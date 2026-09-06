import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type {
  UserStats,
  MatchHistoryEntry,
  MatchScorecard,
  PublicUser,
  Friend,
  LeaderboardEntry,
  UserAchievements,
  GlobalRecords,
  OversRecords,
  GameRecord,
  HeadToHeadRecord,
  BotRankingEntry,
  BotTournamentSummary,
  BotTournamentStanding,
  TournamentState,
  StoreItem,
  AdminStats,
} from '@cric/types';
import { isBotName, BOT_NAMES } from './game/bot.ts';
import type { Prisma } from '@prisma/client';
import {
  observeHuman,
  phaseOf,
  reset as resetOpponentModel,
  isReady as opponentModelReady,
  type Role,
} from './game/opponentModel.ts';

// ─── Persistence model ────────────────────────────────────────────────────────
//
// PostgreSQL (via Prisma) is the source of truth, but the server keeps an
// authoritative in-memory cache loaded once at boot (initDb) and writes changes
// THROUGH to Postgres asynchronously. This keeps every existing call site
// synchronous (the whole server is sync) while data lives in a real, tabular DB
// that survives restarts and Render's ephemeral disk. For a small realtime game
// this mirrors how room state is already held in memory.

const prisma = new PrismaClient();

/** Fire-and-forget a write; never throw into a request, but never swallow silently. */
function persist(p: Promise<unknown>, what: string): void {
  p.catch((e) => console.error(`[db] persist failed (${what}):`, (e as Error)?.message ?? e));
}

// ─── ML move model ─────────────────────────────────────────────────────────────

/** One role's move model: Laplace-smoothed frequency + first-order transitions. */
export interface RoleModelData {
  freq: number[];
  transitions: number[][];
}

/**
 * A player's move model, split by the role the moves were made in. Batting picks
 * and bowling picks are different distributions, so they're kept apart.
 */
export interface MLModelData {
  bat: RoleModelData;
  bowl: RoleModelData;
}

const ML_DECAY = 0.95;

function emptyRoleModel(): RoleModelData {
  return {
    freq: [0, 1, 1, 1, 1, 1, 1],
    transitions: Array.from({ length: 7 }, () => [0, 1, 1, 1, 1, 1, 1]),
  };
}

// In-memory ML profiles, keyed by registered user id. Rebuilt from the BallEvent
// log at boot (no blob is persisted) and updated live as balls are recorded.
const mlProfiles: Record<string, MLModelData> = {};

function applyToProfile(
  userId: string,
  role: 'bat' | 'bowl',
  move: number,
  lastMove?: number
): void {
  let profile = mlProfiles[userId];
  if (!profile) {
    profile = { bat: emptyRoleModel(), bowl: emptyRoleModel() };
    mlProfiles[userId] = profile;
  }
  const model = profile[role];
  // Decay the whole model each observation so recent moves outweigh old ones,
  // matching the client's online decay rule exactly.
  for (let i = 1; i <= 6; i++) {
    model.freq[i] *= ML_DECAY;
    for (let j = 1; j <= 6; j++) model.transitions[i][j] *= ML_DECAY;
  }
  model.freq[move] = (model.freq[move] ?? 0) + 1;
  if (lastMove !== undefined) {
    model.transitions[lastMove][move] = (model.transitions[lastMove][move] ?? 0) + 1;
  }
}

// ─── Stats & achievements helpers ───────────────────────────────────────────────

/** A fresh, zeroed stats record. */
export function emptyStats(): UserStats {
  return {
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    runsScored: 0,
    highScore: 0,
    wicketsTaken: 0,
    boundaries: 0,
    ballsBowled: 0,
    runsConceded: 0,
  };
}

/** Backfill any missing stats fields so every served UserStats is complete. */
function normalizeStats(s: Partial<UserStats> | undefined): UserStats {
  return { ...emptyStats(), ...(s ?? {}) };
}

/** A fresh, zeroed achievements record. */
export function emptyAchievements(): UserAchievements {
  return {
    tournamentsPlayed: 0,
    tournamentsWon: 0,
    orangeCaps: 0,
    purpleCaps: 0,
    mostSixesAwards: 0,
    playerOfTournament: 0,
  };
}

function normalizeAchievements(a: Partial<UserAchievements> | undefined): UserAchievements {
  return { ...emptyAchievements(), ...(a ?? {}) };
}

// ─── In-memory cache shape ──────────────────────────────────────────────────────

/** A user as held in the cache (stats/achievements/history denormalized into objects). */
export interface DbUser {
  id: string;
  username: string;
  passwordHash: string;
  token: string | null;
  stats: UserStats;
  achievements?: UserAchievements;
  matchHistory: MatchHistoryEntry[];
  friends?: string[];
  createdAt: string;
  coins: number;
  unlocks: string[];
}

interface CacheShape {
  users: DbUser[];
  records: GlobalRecords;
}

const cache: CacheShape = { users: [], records: { byOvers: {} } };

/** All reads go through the in-memory cache (populated by initDb at boot). */
function load(): CacheShape {
  return cache;
}

// ─── Boot: load everything from Postgres into the cache ─────────────────────────

function rowToDbUser(u: {
  id: string;
  username: string;
  passwordHash: string;
  token: string | null;
  createdAt: Date;
  gamesPlayed: number;
  wins: number;
  losses: number;
  ties: number;
  runsScored: number;
  highScore: number;
  wicketsTaken: number;
  boundaries: number;
  ballsBowled: number;
  runsConceded: number;
  tournamentsPlayed: number;
  tournamentsWon: number;
  orangeCaps: number;
  purpleCaps: number;
  mostSixesAwards: number;
  playerOfTournament: number;
  coins: number;
  unlocks: string[];
  matchHistory?: Array<{
    opponent: string;
    result: string;
    myScore: number;
    oppScore: number;
    overs: number;
    wickets: number;
    date: Date;
    isTournament: boolean;
    scorecard: Prisma.JsonValue | null;
  }>;
  friendships?: Array<{ friendId: string }>;
}): DbUser {
  return {
    id: u.id,
    username: u.username,
    passwordHash: u.passwordHash,
    token: u.token,
    createdAt: u.createdAt.toISOString(),
    stats: {
      gamesPlayed: u.gamesPlayed,
      wins: u.wins,
      losses: u.losses,
      ties: u.ties,
      runsScored: u.runsScored,
      highScore: u.highScore,
      wicketsTaken: u.wicketsTaken,
      boundaries: u.boundaries,
      ballsBowled: u.ballsBowled,
      runsConceded: u.runsConceded,
    },
    achievements: {
      tournamentsPlayed: u.tournamentsPlayed,
      tournamentsWon: u.tournamentsWon,
      orangeCaps: u.orangeCaps,
      purpleCaps: u.purpleCaps,
      mostSixesAwards: u.mostSixesAwards,
      playerOfTournament: u.playerOfTournament,
    },
    // Fetched newest-first (take 10); reverse to the oldest-first push order the
    // rest of the app expects.
    matchHistory: (u.matchHistory ?? [])
      .map((m) => ({
        opponent: m.opponent,
        result: m.result as MatchHistoryEntry['result'],
        myScore: m.myScore,
        oppScore: m.oppScore,
        overs: m.overs,
        wickets: m.wickets,
        date: m.date.toISOString(),
        isTournament: m.isTournament,
        ...(m.scorecard ? { scorecard: m.scorecard as unknown as MatchScorecard } : {}),
      }))
      .reverse(),
    friends: (u.friendships ?? []).map((f) => f.friendId),
    coins: u.coins,
    unlocks: u.unlocks ?? [],
  };
}

function buildRecords(
  recs: Array<{
    overs: number;
    type: string;
    value: number;
    holderName: string;
    holderId: string | null;
    wickets: number;
    date: Date;
  }>
): GlobalRecords {
  const byOvers: GlobalRecords['byOvers'] = {};
  for (const r of recs) {
    const key = String(r.overs);
    const bucket: OversRecords =
      byOvers[key] ?? { fastest50: null, fastest100: null, highestTotal: null, lowestTotal: null };
    const rec: GameRecord = {
      value: r.value,
      holderName: r.holderName,
      holderId: r.holderId,
      overs: r.overs,
      wickets: r.wickets,
      date: r.date.toISOString(),
    };
    if (r.type === 'fastest50' || r.type === 'fastest100' || r.type === 'highestTotal' || r.type === 'lowestTotal')
      bucket[r.type] = rec;
    byOvers[key] = bucket;
  }
  return { byOvers };
}

/**
 * Load the database into the in-memory cache, and rebuild the ML move models by
 * replaying the ball log (newest 50k, oldest-first so decay lands correctly).
 * Must be awaited before the server starts handling requests.
 */
export async function initDb(): Promise<void> {
  const users = await prisma.user.findMany({
    include: { matchHistory: { orderBy: { date: 'desc' }, take: 10 }, friendships: true },
  });
  cache.users = users.map(rowToDbUser);

  const recs = await prisma.globalRecord.findMany();
  cache.records = buildRecords(recs);

  // Bot-league rankings. Wrapped so a server with the migration not yet applied
  // still boots (the bot league simply has no data until the table exists).
  try {
    const ranks = await prisma.botRanking.findMany();
    for (const r of ranks)
      botRankings.set(botKey(r.botName, r.format), {
        botName: r.botName,
        format: r.format,
        rating: r.rating,
        played: r.played,
        wins: r.wins,
        losses: r.losses,
        ties: r.ties,
        trophies: r.trophies,
        runsFor: r.runsFor,
        runsAgainst: r.runsAgainst,
        batFirst: r.batFirst ?? 0,
        batFirstWins: r.batFirstWins ?? 0,
        careerPlayed: r.careerPlayed ?? 0,
        careerWins: r.careerWins ?? 0,
        careerLosses: r.careerLosses ?? 0,
        careerTies: r.careerTies ?? 0,
        careerTrophies: r.careerTrophies ?? 0,
        careerRunsFor: r.careerRunsFor ?? 0,
        careerRunsAgainst: r.careerRunsAgainst ?? 0,
      });
    seedBotRankings(); // backfill any missing (bot, format) rows
  } catch (err) {
    console.error(
      '[db] bot rankings unavailable (is the BotRanking migration applied?):',
      (err as Error)?.message ?? err
    );
  }

  // Lifetime bot-vs-bot head-to-head. Guarded like the rankings above so a server
  // without the migration yet still boots (H2H simply stays empty until applied).
  try {
    const rows = await prisma.botHeadToHead.findMany();
    botH2H.clear();
    for (const r of rows)
      botH2H.set(h2hCacheKey(r.pair, r.format), {
        pair: r.pair,
        format: r.format,
        nameA: r.nameA,
        nameB: r.nameB,
        aWins: r.aWins,
        bWins: r.bWins,
        ties: r.ties,
        lastWinner: r.lastWinner ?? null,
        lastMargin: r.lastMargin ?? null,
        lastByWickets: r.lastByWickets ?? null,
      });
  } catch (err) {
    console.error(
      '[db] bot head-to-head unavailable (is the BotHeadToHead migration applied?):',
      (err as Error)?.message ?? err
    );
  }

  // Past bot-league tournaments (history cards). Guarded like the rankings above.
  // Load oldest-first to (re)derive each format's sequential name + count, then
  // keep the newest BOT_HISTORY_CAP for the in-memory cache. Names missing or
  // wrong are backfilled in place — this self-heals legacy rows on first boot.
  try {
    // Load tournament SUMMARIES only (never the heavy `state` JSON) to derive
    // names/counts, the career-trophy heal, and the history cards. `state` is pulled
    // just for the recent few (below) + the one-time backfill — so a normal boot no
    // longer transfers every tournament's full state, which was a big egress cost.
    const summaries = await prisma.botTournament.findMany({
      orderBy: { finishedAt: 'asc' },
      select: {
        id: true, format: true, season: true, isSuperLeague: true, name: true,
        champion: true, runnerUp: true, standings: true, finishedAt: true,
      },
    });
    for (const f of BOT_FORMATS) botTournamentCount[f] = 0;
    botSuperLeagueCount = 0;
    for (const t of summaries) {
      const want = t.isSuperLeague
        ? botSuperLeagueName((botSuperLeagueCount += 1))
        : botLeagueName(t.format, (botTournamentCount[t.format] = (botTournamentCount[t.format] ?? 0) + 1));
      if (t.name !== want) {
        t.name = want; // fix the local copy used below
        persist(prisma.botTournament.update({ where: { id: t.id }, data: { name: want } }), 'backfillBotTournamentName');
      }
    }

    // History cache: keep the newest BOT_HISTORY_CAP SUMMARIES (cheap — already
    // loaded above) so past-season browsing lists every league, but pull the heavy
    // `state` JSON ONLY for the newest BOT_STATE_CAP — that bounds per-boot egress.
    const recent = [...summaries].reverse().slice(0, BOT_HISTORY_CAP);
    const withState = recent.slice(0, BOT_STATE_CAP);
    const stateById = new Map<number, TournamentState | null>();
    if (withState.length) {
      const rows = await prisma.botTournament.findMany({
        where: { id: { in: withState.map((t) => t.id) } },
        select: { id: true, state: true },
      });
      for (const r of rows) stateById.set(r.id, (r.state as unknown as TournamentState) ?? null);
    }
    botTournaments.length = 0;
    for (const t of recent)
      botTournaments.push({
        format: t.format,
        season: t.season ?? 1,
        name: t.name ?? botLeagueName(t.format, 0),
        champion: t.champion,
        runnerUp: t.runnerUp,
        finishedAt: t.finishedAt.toISOString(),
        standings: (t.standings as unknown as BotTournamentStanding[]) ?? [],
        state: stateById.get(t.id) ?? null,
      });

    // Self-heal stored Q/E badges: a `state.qualification` computed while a bug was
    // live leaves wrong badges frozen on the history card (the World Cup format once
    // judged top-2 instead of top-4). For a finished tournament the qualifiers are
    // fully determined, so recompute from final standings and persist any correction.
    let qHealed = 0;
    for (let i = 0; i < recent.length; i++) {
      const st = botTournaments[i]?.state;
      if (!st) continue;
      const want = finishedQualification(st);
      if (want && !sameQual(want, st.qualification)) {
        st.qualification = want; // fix the in-memory card served this boot
        persist(
          prisma.botTournament.update({
            where: { id: recent[i].id },
            data: { state: st as unknown as Prisma.InputJsonValue },
          }),
          'healBotQualification'
        );
        qHealed++;
      }
    }
    if (qHealed) console.log(`[db] healed qualification badges on ${qHealed} tournament card(s)`);

    // Self-heal CAREER trophy counts from the championship record (no state needed).
    // Season trophies are live-tracked + reset per season, so they're NOT rebuilt.
    const trophyByKey = new Map<string, number>();
    for (const t of summaries)
      if (t.champion) {
        const k = botKey(t.champion, t.format);
        trophyByKey.set(k, (trophyByKey.get(k) ?? 0) + 1);
      }
    let healed = 0;
    for (const [key, row] of botRankings) {
      const correct = trophyByKey.get(key) ?? 0;
      if (row.careerTrophies !== correct) { row.careerTrophies = correct; persistBotRow(row); healed++; }
    }
    if (healed) console.log(`[db] healed ${healed} bot career-trophy count(s) from championship history`);

    // Batting-first + last-meeting rebuild from every match scorecard — run ONLY when
    // not already populated (fresh DB / post-reset). Reading all states is expensive,
    // so a normal boot skips it; live per-match recording keeps these fresh thereafter.
    const alreadyBuilt = [...botRankings.values()].some((r) => r.batFirst > 0);
    if (!alreadyBuilt) {
      const withState = await prisma.botTournament.findMany({
        orderBy: { finishedAt: 'asc' },
        select: { format: true, state: true },
      });
      let bfMatches = 0;
      for (const t of withState) {
        const st = t.state as unknown as TournamentState | null;
        if (!st?.fixtures?.length || !st.players?.length) continue;
        const wktQuota = st.wickets;
        for (const fx of st.fixtures) {
          const sc = fx.scorecard;
          if (fx.status !== 'done' || !sc || sc.innings.length < 2) continue;
          const inn1 = sc.innings[0];
          const inn2 = sc.innings[1];
          const firstBatName = inn1.batter;
          const p1 = st.players[fx.player1Idx]?.name;
          const p2 = st.players[fx.player2Idx]?.name;
          if (!p1 || !p2 || !firstBatName) continue;
          const winner = fx.result === 'p1' ? p1 : fx.result === 'p2' ? p2 : null;
          const fbRow = getOrCreateBotRow(firstBatName, t.format);
          fbRow.batFirst++;
          if (winner === firstBatName) fbRow.batFirstWins++;
          let margin: { value: number; byWickets: boolean } | null = null;
          if (winner && !fx.superOver)
            margin = winner === firstBatName
              ? { value: Math.max(1, inn1.runs - inn2.runs), byWickets: false }
              : { value: Math.max(1, wktQuota - inn2.wickets), byWickets: true };
          const { pair, nameA, nameB } = h2hPair(p1, p2);
          const hk = h2hCacheKey(pair, t.format);
          let h = botH2H.get(hk);
          if (!h) { h = { pair, format: t.format, nameA, nameB, aWins: 0, bWins: 0, ties: 0, lastWinner: null, lastMargin: null, lastByWickets: null }; botH2H.set(hk, h); }
          h.lastWinner = winner;
          h.lastMargin = margin?.value ?? null;
          h.lastByWickets = margin?.byWickets ?? null;
          bfMatches++;
        }
      }
      for (const r of botRankings.values()) persistBotRow(r);
      for (const r of botH2H.values()) persistBotH2H(r);
      if (bfMatches) console.log(`[db] built bot batting-first + last-meeting from ${bfMatches} matches`);
    }
  } catch (err) {
    console.error(
      '[db] bot tournament history unavailable (is the BotTournament migration applied?):',
      (err as Error)?.message ?? err
    );
  }

  // Bot seasons: load the open season + past champions (opens Season 1 if none).
  await loadBotSeasons();

  // Human balls only ever exist now (bot balls aren't persisted), so ONE read feeds
  // both the per-user profiles (rows with a userId) and the global move model (all
  // human balls) — instead of two near-identical scans of the same rows.
  const balls = await prisma.ballEvent.findMany({
    where: { isBot: false },
    orderBy: { id: 'desc' },
    take: 60000,
    select: { userId: true, role: true, innings: true, ballIndex: true, overs: true, prevMove: true, move: true },
  });
  balls.reverse();
  resetOpponentModel();
  for (const b of balls) {
    if (b.userId) applyToProfile(b.userId, b.role as 'bat' | 'bowl', b.move, b.prevMove ?? undefined);
    observeHuman(b.role as Role, b.innings, phaseOf(b.ballIndex, b.overs * 6), b.prevMove ?? null, b.move);
  }

  console.log(
    `[db] ready — ${cache.users.length} users, ${recs.length} records; ` +
      `human-move model trained on ${balls.length} balls (ready=${opponentModelReady()})`
  );
}

// ─── Users / auth ───────────────────────────────────────────────────────────────

export function findByUsername(username: string): DbUser | null {
  return load().users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? null;
}

export function findById(id: string): DbUser | null {
  return load().users.find((u) => u.id === id) ?? null;
}

export function findByToken(token: string): DbUser | null {
  return load().users.find((u) => u.token === token) ?? null;
}

export function createUser(username: string, passwordHash: string): DbUser | null {
  const db = load();
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return null;
  const user: DbUser = {
    id: randomUUID(),
    username,
    passwordHash,
    token: null,
    stats: emptyStats(),
    achievements: emptyAchievements(),
    matchHistory: [],
    friends: [],
    createdAt: new Date().toISOString(),
    coins: 0,
    unlocks: [],
  };
  db.users.push(user);
  persist(
    prisma.user.create({
      data: { id: user.id, username, passwordHash, createdAt: new Date(user.createdAt) },
    }),
    'createUser'
  );
  return user;
}

export function saveToken(userId: string, token: string): void {
  const user = load().users.find((u) => u.id === userId);
  if (!user) return;
  user.token = token;
  persist(prisma.user.update({ where: { id: userId }, data: { token } }), 'saveToken');
}

// ─── Economy (coins + unlocks) ───────────────────────────────────────────────

/** The store catalogue. Longer formats cost more; 1–2 over & 4-player are free. */
export const STORE_ITEMS: StoreItem[] = [
  { id: 'over3', label: '3-Over Matches', description: 'Play the 3-over format (casual & tournaments).', price: 25 },
  { id: 'over5', label: '5-Over Matches', description: 'Play the 5-over format (casual & tournaments).', price: 50 },
  { id: 'over10', label: '10-Over Matches', description: 'Play the 10-over format (casual & tournaments).', price: 150 },
  { id: 'tourney8', label: '8-Player Tournaments', description: 'Host & join the bigger 8-player bracket.', price: 100 },
  { id: 'tourney16', label: '16-Player Super League', description: 'Host & join the 16-player Super League — four groups, then knockouts.', price: 250 },
  { id: 'emotes', label: 'Full Emote Pack', description: 'Unlock every in-match taunt emote.', price: 40 },
];

/** Coins awarded for various actions. */
export const COIN_REWARDS = {
  // Finishing a Quick Match against a stranger (friends are excluded — no farming).
  quickMatch: 5,
  // Winning a tournament that had at least one of your friends in it.
  tournamentWinWithFriend: 20,
};

/**
 * Champion-bid stakes: backing a bot to win a league now costs coins up front and
 * pays out only if that bot lifts the trophy. The Super League (16 bots) is the
 * premium event — bigger stake, bigger prize.
 */
export const LEAGUE_BID = {
  normal: { stake: 20, prize: 50 }, // 5/10-over leagues (12 bots)
  super: { stake: 50, prize: 100 }, // Super League (16 bots)
};

/** The admin account (ADMIN_USERNAME) gets everything for free. */
function isAdminUser(u: DbUser | null | undefined): boolean {
  return !!process.env.ADMIN_USERNAME && u?.username === process.env.ADMIN_USERNAME;
}

export function getEconomy(userId: string): { coins: number; unlocks: string[] } {
  const u = load().users.find((x) => x.id === userId);
  if (!u) return { coins: 0, unlocks: [] };
  // Admin owns everything (so the client shows no locks); others get their list.
  return { coins: u.coins ?? 0, unlocks: isAdminUser(u) ? STORE_ITEMS.map((s) => s.id) : (u.unlocks ?? []) };
}

/** Whether a user owns a given unlock. Guests own nothing; the admin owns all. */
export function hasUnlock(userId: string | null | undefined, itemId: string): boolean {
  if (!userId) return false;
  const u = load().users.find((x) => x.id === userId);
  if (!u) return false;
  if (isAdminUser(u)) return true;
  return !!u.unlocks?.includes(itemId);
}

/** The unlock id required to play a given over count, or null if it's free (1–2). */
export function overUnlockId(overs: number): string | null {
  return overs === 3 ? 'over3' : overs === 5 ? 'over5' : overs === 10 ? 'over10' : null;
}

/** Credit (or debit) coins; clamped at 0. No-op for guests. */
export function addCoins(userId: string | null | undefined, amount: number): void {
  if (!userId || amount === 0) return;
  const u = load().users.find((x) => x.id === userId);
  if (!u) return;
  u.coins = Math.max(0, (u.coins ?? 0) + amount);
  persist(prisma.user.update({ where: { id: userId }, data: { coins: u.coins } }), 'addCoins');
}

/** Deduct `amount` coins if the user can afford it. Returns false (no change) when
 *  the balance is short — so callers can reject a purchase/bet atomically. */
export function spendCoins(userId: string | null | undefined, amount: number): boolean {
  if (!userId || amount <= 0) return false;
  const u = load().users.find((x) => x.id === userId);
  if (!u || (u.coins ?? 0) < amount) return false;
  u.coins -= amount;
  persist(prisma.user.update({ where: { id: userId }, data: { coins: u.coins } }), 'spendCoins');
  return true;
}

/** Buy a store item: validates balance + ownership, then deducts and records it. */
export function unlockItem(
  userId: string,
  itemId: string
): { ok: boolean; error?: string; coins: number; unlocks: string[] } {
  const u = load().users.find((x) => x.id === userId);
  if (!u) return { ok: false, error: 'User not found.', coins: 0, unlocks: [] };
  const item = STORE_ITEMS.find((s) => s.id === itemId);
  if (!item) return { ok: false, error: 'Unknown item.', coins: u.coins, unlocks: u.unlocks };
  if (u.unlocks.includes(itemId)) return { ok: true, coins: u.coins, unlocks: u.unlocks };
  if ((u.coins ?? 0) < item.price)
    return { ok: false, error: 'Not enough coins.', coins: u.coins, unlocks: u.unlocks };
  u.coins -= item.price;
  u.unlocks = [...u.unlocks, itemId];
  persist(
    prisma.user.update({ where: { id: userId }, data: { coins: u.coins, unlocks: u.unlocks } }),
    'unlockItem'
  );
  return { ok: true, coins: u.coins, unlocks: u.unlocks };
}

// ─── Friends ────────────────────────────────────────────────────────────────────

export function addFriend(userId: string, friendId: string): boolean {
  const db = load();
  const user = db.users.find((u) => u.id === userId);
  const friend = db.users.find((u) => u.id === friendId);
  if (!user || !friend) return false;
  user.friends ??= [];
  friend.friends ??= [];
  if (!user.friends.includes(friendId)) user.friends.push(friendId);
  if (!friend.friends.includes(userId)) friend.friends.push(userId);
  persist(
    prisma.friendship.createMany({
      data: [
        { userId, friendId },
        { userId: friendId, friendId: userId },
      ],
      skipDuplicates: true,
    }),
    'addFriend'
  );
  return true;
}

export function removeFriend(userId: string, friendId: string): void {
  const db = load();
  const user = db.users.find((u) => u.id === userId);
  const friend = db.users.find((u) => u.id === friendId);
  if (user) user.friends = (user.friends || []).filter((id) => id !== friendId);
  if (friend) friend.friends = (friend.friends || []).filter((id) => id !== userId);
  persist(
    prisma.friendship.deleteMany({
      where: {
        OR: [
          { userId, friendId },
          { userId: friendId, friendId: userId },
        ],
      },
    }),
    'removeFriend'
  );
}

/**
 * Whether two registered users are friends (mutual, so either direction works).
 * Returns false if either id is missing — used to deny coin rewards between
 * friends so they can't farm coins off each other.
 */
export function areFriends(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b || a === b) return false;
  const db = load();
  const user = db.users.find((u) => u.id === a);
  return !!user?.friends?.includes(b);
}

export function getFriends(userId: string): Friend[] {
  const db = load();
  const user = db.users.find((u) => u.id === userId);
  if (!user?.friends?.length) return [];
  return user.friends
    .map((fid) => db.users.find((u) => u.id === fid))
    .filter((u): u is DbUser => Boolean(u))
    .map((u) => ({ id: u.id, username: u.username, stats: u.stats, online: false }));
}

export function searchUsers(query: string, excludeId: string): PublicUser[] {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  return load()
    .users.filter((u) => u.id !== excludeId && u.username.toLowerCase().includes(q))
    .slice(0, 10)
    .map((u) => ({ id: u.id, username: u.username }));
}

// ─── Game stats & match history ──────────────────────────────────────────────────

export interface GameStatsResult {
  userId: string | null | undefined;
  win: boolean;
  tie: boolean;
  runsScored: number;
  opponentName: string;
  opponentScore: number;
  overs: number;
  wickets: number;
  /** Wickets this player took while bowling this match. */
  wicketsTaken?: number;
  /** Boundaries (4s + 5s + 6s) this player hit while batting this match. */
  boundaries?: number;
  /** Balls this player bowled this match. */
  ballsBowled?: number;
  /** Runs this player conceded while bowling this match. */
  runsConceded?: number;
  /** Whether this match was part of a tournament. */
  isTournament?: boolean;
  /** Full match scorecard to attach to this player's history entry. */
  scorecard?: MatchScorecard;
}

export function updateGameStats(results: GameStatsResult[]): void {
  const db = load();
  for (const {
    userId,
    win,
    tie,
    runsScored,
    opponentName,
    opponentScore,
    overs,
    wickets,
    wicketsTaken = 0,
    boundaries = 0,
    ballsBowled = 0,
    runsConceded = 0,
    isTournament = false,
    scorecard,
  } of results) {
    if (!userId) continue;
    const user = db.users.find((u) => u.id === userId);
    if (!user) continue;
    user.stats = normalizeStats(user.stats);
    user.stats.gamesPlayed += 1;
    if (tie) user.stats.ties += 1;
    else if (win) user.stats.wins += 1;
    else user.stats.losses += 1;
    user.stats.runsScored += runsScored;
    if (runsScored > user.stats.highScore) user.stats.highScore = runsScored;
    user.stats.wicketsTaken += wicketsTaken;
    user.stats.boundaries += boundaries;
    user.stats.ballsBowled += ballsBowled;
    user.stats.runsConceded += runsConceded;

    const entry: MatchHistoryEntry = {
      opponent: opponentName || 'Unknown',
      result: tie ? 'tie' : win ? 'win' : 'loss',
      myScore: runsScored,
      oppScore: opponentScore ?? 0,
      overs: overs || 1,
      wickets: wickets || 1,
      date: new Date().toISOString(),
      isTournament,
      ...(scorecard ? { scorecard } : {}),
    };
    if (!user.matchHistory) user.matchHistory = [];
    user.matchHistory.push(entry);
    if (user.matchHistory.length > 10) user.matchHistory = user.matchHistory.slice(-10);

    const s = user.stats;
    // Absolute write from the authoritative cache (not increments) so a missed
    // write never causes drift.
    persist(
      prisma.user.update({
        where: { id: userId },
        data: {
          gamesPlayed: s.gamesPlayed,
          wins: s.wins,
          losses: s.losses,
          ties: s.ties,
          runsScored: s.runsScored,
          highScore: s.highScore,
          wicketsTaken: s.wicketsTaken,
          boundaries: s.boundaries,
          ballsBowled: s.ballsBowled,
          runsConceded: s.runsConceded,
        },
      }),
      'updateGameStats:user'
    );
    persist(
      prisma.matchHistory.create({
        data: {
          userId,
          opponent: entry.opponent,
          result: entry.result,
          myScore: entry.myScore,
          oppScore: entry.oppScore,
          overs: entry.overs,
          wickets: entry.wickets,
          date: new Date(entry.date),
          isTournament,
          scorecard: scorecard ? (scorecard as unknown as Prisma.InputJsonValue) : undefined,
        },
      }),
      'updateGameStats:history'
    );
  }
}

export function getMatchHistory(userId: string): MatchHistoryEntry[] {
  const user = load().users.find((u) => u.id === userId);
  return user?.matchHistory ?? [];
}

/**
 * Lifetime head-to-head records for a user, one row per distinct opponent name
 * (human or bot). Aggregated straight from the full MatchHistory table in
 * Postgres — the in-memory cache only keeps each user's last 10 matches, so it
 * can't answer this. Cheap (a single grouped query) and off the game hot path.
 */
export async function getHeadToHead(userId: string): Promise<HeadToHeadRecord[]> {
  const grouped = await prisma.matchHistory.groupBy({
    by: ['opponent', 'result'],
    where: { userId },
    _count: { _all: true },
    _sum: { myScore: true, oppScore: true },
    _max: { date: true },
  });

  const byOpponent = new Map<string, HeadToHeadRecord>();
  for (const g of grouped) {
    let rec = byOpponent.get(g.opponent);
    if (!rec) {
      rec = {
        opponent: g.opponent,
        isBot: isBotName(g.opponent),
        played: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        runsFor: 0,
        runsAgainst: 0,
        lastPlayed: '',
      };
      byOpponent.set(g.opponent, rec);
    }
    const n = g._count._all;
    rec.played += n;
    if (g.result === 'win') rec.wins += n;
    else if (g.result === 'loss') rec.losses += n;
    else rec.ties += n;
    rec.runsFor += g._sum.myScore ?? 0;
    rec.runsAgainst += g._sum.oppScore ?? 0;
    const d = g._max.date ? g._max.date.toISOString() : '';
    if (d > rec.lastPlayed) rec.lastPlayed = d;
  }

  // Most recently played opponents first.
  return [...byOpponent.values()].sort((a, b) => (a.lastPlayed < b.lastPlayed ? 1 : -1));
}

/**
 * Every registered player who has played at least one game, with full stats.
 * The client computes per-category rankings from a single fetch.
 */
export function getLeaderboard(): LeaderboardEntry[] {
  return load()
    .users.filter((u) => u.stats.gamesPlayed > 0)
    .map((u) => ({ id: u.id, username: u.username, stats: normalizeStats(u.stats) }));
}

// ─── Achievements (per-user career honours) ──────────────────────────────────────

export function getAchievements(userId: string): UserAchievements {
  const user = load().users.find((u) => u.id === userId);
  return normalizeAchievements(user?.achievements);
}

/**
 * Bump career honours for registered players (called once when a tournament
 * finalizes). Updates the cache and writes the affected users' achievement
 * columns through to Postgres.
 */
export function incrementAchievements(
  incs: Array<{ userId: string; key: keyof UserAchievements }>
): void {
  if (incs.length === 0) return;
  const db = load();
  const touched = new Set<string>();
  for (const { userId, key } of incs) {
    const user = db.users.find((u) => u.id === userId);
    if (!user) continue;
    user.achievements = normalizeAchievements(user.achievements);
    user.achievements[key] += 1;
    touched.add(userId);
  }
  for (const userId of touched) {
    const a = db.users.find((u) => u.id === userId)!.achievements!;
    persist(
      prisma.user.update({
        where: { id: userId },
        data: {
          tournamentsPlayed: a.tournamentsPlayed,
          tournamentsWon: a.tournamentsWon,
          orangeCaps: a.orangeCaps,
          purpleCaps: a.purpleCaps,
          mostSixesAwards: a.mostSixesAwards,
          playerOfTournament: a.playerOfTournament,
        },
      }),
      'incrementAchievements'
    );
  }
}

// ─── Global records (tournament matches only, bucketed by overs) ──────────────────

export function getGlobalRecords(): GlobalRecords {
  return load().records;
}

/** A finished tournament innings, distilled to the values records care about. */
export interface InningsRecordInput {
  overs: number;
  wickets: number;
  total: number;
  /** Innings actually completed (all out or overs done) — gate for "lowest total". */
  completed: boolean;
  /** Ball on which 50/100 was reached, or null if never. */
  ballsTo50: number | null;
  ballsTo100: number | null;
  holderName: string;
  holderId: string | null;
}

/**
 * Fold tournament innings into the global record book (cache + Postgres). Highest
 * total and the "fastest to" records take any innings; lowest total only counts
 * completed innings.
 */
export function recordInnings(inputs: InningsRecordInput[]): void {
  if (inputs.length === 0) return;
  const book = load().records.byOvers;

  for (const inn of inputs) {
    const key = String(inn.overs);
    const bucket: OversRecords =
      book[key] ?? { fastest50: null, fastest100: null, highestTotal: null, lowestTotal: null };
    const mk = (value: number): GameRecord => ({
      value,
      holderName: inn.holderName,
      holderId: inn.holderId,
      overs: inn.overs,
      wickets: inn.wickets,
      date: new Date().toISOString(),
    });

    const changed: Array<keyof OversRecords> = [];
    if (!bucket.highestTotal || inn.total > bucket.highestTotal.value) {
      bucket.highestTotal = mk(inn.total);
      changed.push('highestTotal');
    }
    if (inn.completed && (!bucket.lowestTotal || inn.total < bucket.lowestTotal.value)) {
      bucket.lowestTotal = mk(inn.total);
      changed.push('lowestTotal');
    }
    if (inn.ballsTo50 !== null && (!bucket.fastest50 || inn.ballsTo50 < bucket.fastest50.value)) {
      bucket.fastest50 = mk(inn.ballsTo50);
      changed.push('fastest50');
    }
    if (inn.ballsTo100 !== null && (!bucket.fastest100 || inn.ballsTo100 < bucket.fastest100.value)) {
      bucket.fastest100 = mk(inn.ballsTo100);
      changed.push('fastest100');
    }
    book[key] = bucket;

    for (const type of changed) {
      const rec = bucket[type]!;
      const data = {
        value: rec.value,
        holderName: rec.holderName,
        holderId: rec.holderId,
        wickets: inn.wickets,
        date: new Date(rec.date),
      };
      persist(
        prisma.globalRecord.upsert({
          where: { overs_type: { overs: inn.overs, type } },
          create: { overs: inn.overs, type, ...data },
          update: data,
        }),
        'recordInnings'
      );
    }
  }
}

// ─── Bot league rankings ─────────────────────────────────────────────────────────
//
// Persistent per-format (5/10 over) Elo-style ranking for each roster bot, held
// in a write-through in-memory map like everything else here. Updated after each
// bot-league match; bots are identified by their stable roster name. Beating a
// higher-rated bot moves the needle more (the "ICC-style" weighting).

const BOT_FORMATS = [5, 10] as const;
const ELO_BASE = 1000;
const ELO_K = 32;

interface BotRankingRow {
  botName: string;
  format: number;
  // Current-season stats (reset at a season rollover).
  rating: number;
  played: number;
  wins: number;
  losses: number;
  ties: number;
  trophies: number;
  runsFor: number;
  runsAgainst: number;
  // Lifetime (never reset).
  batFirst: number;
  batFirstWins: number;
  careerPlayed: number;
  careerWins: number;
  careerLosses: number;
  careerTies: number;
  careerTrophies: number;
  careerRunsFor: number;
  careerRunsAgainst: number;
}

const botRankings = new Map<string, BotRankingRow>(); // keyed by `${botName}|${format}`
const botKey = (name: string, format: number) => `${name}|${format}`;

// ─── Lifetime bot-vs-bot head-to-head ──────────────────────────────────────────
// One row per unordered pair of bots PER FORMAT (5 vs 10 are tracked separately),
// accumulated across every bot-league match (group + knockouts). Keyed by the two
// names sorted into "A|B" plus the format; aWins/bWins follow nameA/nameB. Loaded
// at boot, updated per match, reset on reset.
type BotH2HRow = {
  pair: string;
  format: number;
  nameA: string;
  nameB: string;
  aWins: number;
  bWins: number;
  ties: number;
  // Most-recent meeting: winner (null = tie), margin (null = Super Over/tie), and
  // whether that margin is wickets (true) or runs (false; null = tie/Super Over).
  lastWinner: string | null;
  lastMargin: number | null;
  lastByWickets: boolean | null;
};
const botH2H = new Map<string, BotH2HRow>(); // keyed by `${pair}|${format}`
const h2hCacheKey = (pair: string, format: number) => `${pair}|${format}`;

/** Canonical (order-independent) key + name ordering for a bot pair. */
function h2hPair(x: string, y: string): { pair: string; nameA: string; nameB: string } {
  const [nameA, nameB] = x.localeCompare(y) <= 0 ? [x, y] : [y, x];
  return { pair: `${nameA}|${nameB}`, nameA, nameB };
}

function persistBotH2H(row: BotH2HRow): void {
  const fields = {
    aWins: row.aWins,
    bWins: row.bWins,
    ties: row.ties,
    lastWinner: row.lastWinner,
    lastMargin: row.lastMargin,
    lastByWickets: row.lastByWickets,
  };
  persist(
    prisma.botHeadToHead.upsert({
      where: { pair_format: { pair: row.pair, format: row.format } },
      create: { pair: row.pair, format: row.format, nameA: row.nameA, nameB: row.nameB, ...fields },
      update: fields,
    }),
    'botH2H'
  );
}

/**
 * Fold one finished bot-vs-bot match into the per-format head-to-head record:
 * bump the win/tie tally AND overwrite the "last meeting" (winner + margin).
 * `margin` is the winning margin with its unit; null margin = decided by Super Over
 * (or a tie, when winnerName is null).
 */
function recordBotH2H(
  aName: string,
  bName: string,
  winnerName: string | null,
  format: number,
  margin: { value: number; byWickets: boolean } | null
): void {
  if (aName === bName) return;
  const { pair, nameA, nameB } = h2hPair(aName, bName);
  const key = h2hCacheKey(pair, format);
  let row = botH2H.get(key);
  if (!row) {
    row = { pair, format, nameA, nameB, aWins: 0, bWins: 0, ties: 0, lastWinner: null, lastMargin: null, lastByWickets: null };
    botH2H.set(key, row);
  }
  if (winnerName === null) row.ties++;
  else if (winnerName === row.nameA) row.aWins++;
  else row.bWins++;
  row.lastWinner = winnerName;
  row.lastMargin = margin?.value ?? null;
  row.lastByWickets = margin?.byWickets ?? null;
  persistBotH2H(row);
}

/** Lifetime head-to-head between two bots for a format, oriented to (x, y). */
export interface BotH2HResult {
  played: number;
  xWins: number;
  yWins: number;
  ties: number;
  /** The most-recent meeting (null if they've never met in this format). */
  last: { winner: string | null; margin: number | null; byWickets: boolean | null } | null;
}
export function getBotHeadToHead(x: string, y: string, format: number): BotH2HResult {
  const row = botH2H.get(h2hCacheKey(h2hPair(x, y).pair, format));
  if (!row) return { played: 0, xWins: 0, yWins: 0, ties: 0, last: null };
  const xIsA = row.nameA === x;
  const xWins = xIsA ? row.aWins : row.bWins;
  const yWins = xIsA ? row.bWins : row.aWins;
  const played = xWins + yWins + row.ties;
  const last =
    played > 0
      ? { winner: row.lastWinner, margin: row.lastMargin, byWickets: row.lastByWickets }
      : null;
  return { played, xWins, yWins, ties: row.ties, last };
}

/** A bot's batting-first record for a format (for the "win% batting first" insight). */
export function getBotBatFirst(name: string, format: number): { batFirst: number; batFirstWins: number } {
  const row = botRankings.get(botKey(name, format));
  return { batFirst: row?.batFirst ?? 0, batFirstWins: row?.batFirstWins ?? 0 };
}

function freshBotRow(botName: string, format: number): BotRankingRow {
  return {
    botName,
    format,
    rating: ELO_BASE,
    played: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    trophies: 0,
    runsFor: 0,
    runsAgainst: 0,
    batFirst: 0,
    batFirstWins: 0,
    careerPlayed: 0,
    careerWins: 0,
    careerLosses: 0,
    careerTies: 0,
    careerTrophies: 0,
    careerRunsFor: 0,
    careerRunsAgainst: 0,
  };
}

function getOrCreateBotRow(name: string, format: number): BotRankingRow {
  const key = botKey(name, format);
  let row = botRankings.get(key);
  if (!row) {
    row = freshBotRow(name, format);
    botRankings.set(key, row);
  }
  return row;
}

function persistBotRow(row: BotRankingRow): void {
  persist(
    prisma.botRanking.upsert({
      where: { botName_format: { botName: row.botName, format: row.format } },
      create: { ...row },
      update: {
        rating: row.rating,
        played: row.played,
        wins: row.wins,
        losses: row.losses,
        ties: row.ties,
        trophies: row.trophies,
        runsFor: row.runsFor,
        runsAgainst: row.runsAgainst,
        batFirst: row.batFirst,
        batFirstWins: row.batFirstWins,
        careerPlayed: row.careerPlayed,
        careerWins: row.careerWins,
        careerLosses: row.careerLosses,
        careerTies: row.careerTies,
        careerTrophies: row.careerTrophies,
        careerRunsFor: row.careerRunsFor,
        careerRunsAgainst: row.careerRunsAgainst,
      },
    }),
    'botRanking'
  );
}

/**
 * Ensure every roster bot has a row in both formats. At boot (reset=false) this is
 * NON-destructive: it only creates a row that's genuinely absent and NEVER overwrites
 * an existing DB row — a row missing from the in-memory cache must not wipe a bot's
 * real stats/trophies. On an admin reset (reset=true) it force-writes every row back
 * to base (that's the whole point of a reset).
 */
function seedBotRankings(reset = false): void {
  for (const name of BOT_NAMES) {
    for (const format of BOT_FORMATS) {
      if (reset || !botRankings.has(botKey(name, format))) {
        const row = freshBotRow(name, format);
        botRankings.set(botKey(name, format), row);
        persist(
          prisma.botRanking.upsert({
            where: { botName_format: { botName: name, format } },
            create: { ...row },
            update: reset
              ? { rating: ELO_BASE, played: 0, wins: 0, losses: 0, ties: 0, trophies: 0, runsFor: 0, runsAgainst: 0, batFirst: 0, batFirstWins: 0, careerPlayed: 0, careerWins: 0, careerLosses: 0, careerTies: 0, careerTrophies: 0, careerRunsFor: 0, careerRunsAgainst: 0 }
              : {}, // boot: leave any existing row exactly as it is
          }),
          'seedBotRanking'
        );
      }
    }
  }
}

/**
 * Record one finished bot-league match into both bots' rankings (Elo + tallies).
 * `result` is authoritative (so a tie broken by a Super Over still counts as a
 * win for the bot that actually advanced, even though the run scores are level).
 */
export function recordBotLeagueMatch(input: {
  format: number;
  aName: string;
  aScore: number;
  bName: string;
  bScore: number;
  result: 'a' | 'b' | 'tie';
  /** Which bot batted first (for the batting-first split). */
  firstBatName?: string;
  /** Winning margin + unit; null = tie or Super Over (for the "last meeting" line). */
  margin?: { value: number; byWickets: boolean } | null;
}): void {
  const { format, aName, aScore, bName, bScore, result, firstBatName, margin } = input;
  const a = getOrCreateBotRow(aName, format);
  const b = getOrCreateBotRow(bName, format);

  const sA = result === 'a' ? 1 : result === 'b' ? 0 : 0.5;
  const sB = 1 - sA;
  const eA = 1 / (1 + Math.pow(10, (b.rating - a.rating) / 400));
  const eB = 1 - eA;
  a.rating += ELO_K * (sA - eA);
  b.rating += ELO_K * (sB - eB);

  a.played++;
  b.played++;
  a.careerPlayed++;
  b.careerPlayed++;
  a.runsFor += aScore;
  a.runsAgainst += bScore;
  b.runsFor += bScore;
  b.runsAgainst += aScore;
  a.careerRunsFor += aScore;
  a.careerRunsAgainst += bScore;
  b.careerRunsFor += bScore;
  b.careerRunsAgainst += aScore;
  if (sA === 1) {
    a.wins++;
    b.losses++;
    a.careerWins++;
    b.careerLosses++;
  } else if (sA === 0) {
    a.losses++;
    b.wins++;
    a.careerLosses++;
    b.careerWins++;
  } else {
    a.ties++;
    b.ties++;
    a.careerTies++;
    b.careerTies++;
  }

  // Batting-first split: only the side that batted first counts, and only counts a
  // win if it went on to win (Elo `result` is authoritative — covers Super Overs).
  const winnerName = result === 'a' ? aName : result === 'b' ? bName : null;
  if (firstBatName) {
    const firstRow = firstBatName === aName ? a : firstBatName === bName ? b : null;
    if (firstRow) {
      firstRow.batFirst++;
      if (winnerName === firstBatName) firstRow.batFirstWins++;
    }
  }

  persistBotRow(a);
  persistBotRow(b);

  // Lifetime head-to-head (per format): winner + last-meeting margin.
  recordBotH2H(aName, bName, winnerName, format, margin ?? null);
}

/**
 * Wipe every bot ranking back to base (rating 1000, zeroed played/W-L-T,
 * trophies, runs) in BOTH the cache and the DB. Used to recover cleanly when a
 * league is interrupted mid-flight (e.g. a deploy restarts the server). Done as
 * an in-place reseed (upsert to base) so no row is deleted and no race window
 * opens against concurrent writes.
 */
export function resetBotRankings(): void {
  botRankings.clear();
  seedBotRankings(true); // force every (bot, format) row back to base values
  // Also wipe past-tournament history — a ranking reset means a clean slate, and
  // the per-format sequence restarts from #1.
  botTournaments.length = 0;
  for (const f of BOT_FORMATS) botTournamentCount[f] = 0;
  botSuperLeagueCount = 0;
  persist(prisma.botTournament.deleteMany({}), 'resetBotTournaments');
  // Lifetime head-to-head is part of the bot record — wipe it on a clean slate too.
  botH2H.clear();
  persist(prisma.botHeadToHead.deleteMany({}), 'resetBotH2H');
}

/** Award a bot-league trophy (a tournament title) to the winning bot for a format —
 *  counts toward BOTH the current season and the lifetime career tally. */
export function recordBotTrophy(botName: string, format: number): void {
  const row = getOrCreateBotRow(botName, format);
  row.trophies++;
  row.careerTrophies++;
  persistBotRow(row);
}

// Durable history of completed bot-league tournaments, newest first. Loaded at
// boot and appended on each finalize; capped in memory (DB keeps everything).
const botTournaments: BotTournamentSummary[] = [];
// How many completed tournaments to keep in memory as SUMMARY cards (cheap — no
// heavy state). Generous so past-season browsing lists every league across several
// seasons; the DB still keeps everything.
const BOT_HISTORY_CAP = 500;
// Of those, only the newest N carry their heavy `state` JSON (for the detail view).
// Kept small to bound the per-boot state read — the main Neon egress cost.
const BOT_STATE_CAP = 20;
// Total completed tournaments per format (the sequence number for naming, e.g.
// "Bot League 5#3"). Loaded at boot, incremented per finalize, reset on reset.
// The 12-bot Super League has its own sequence ("Bot Super League 3") and is kept
// out of the per-format count, so the normal 10-over numbering stays unbroken.
const botTournamentCount: Record<number, number> = {};
let botSuperLeagueCount = 0;

const botLeagueName = (format: number, seq: number) => `Bot League ${format}#${seq}`;
const botSuperLeagueName = (seq: number) => `Bot Super League ${seq}`;

/** A completed bot tournament is a Super League iff its final state had 16 teams. */
const isSuperLeagueState = (state: TournamentState | null | undefined) => state?.size === 16;

/** Recompute the group-stage Q/E badges for a FINISHED tournament purely from its
 *  final standings — once every group game is done the qualifiers are fully
 *  determined (top K of each group, plus the 2 best 3rd-placed in the 12-team
 *  league). Used to self-heal history cards whose stored `qualification` was frozen
 *  while a bug was live (the World Cup format once judged top-2 instead of top-4, so
 *  its 3rd/4th-placed qualifiers were wrongly badged 'E'). Returns null when the
 *  tournament has no knockout to qualify for. */
function finishedQualification(st: TournamentState): Record<string, 'Q' | 'E'> | null {
  if (st.isQualifier || !st.groups?.length) return null;
  const K = st.superFormat === 'worldcup' ? 4 : 2; // direct qualifiers per group
  const bestThirds = st.size === 12; // the 12-team league also takes the 2 best thirds
  const ptsOf = (idx: number) => st.pointsTable[st.players[idx]?.id ?? '']?.points ?? 0;
  const nrrOf = (idx: number) => st.pointsTable[st.players[idx]?.id ?? '']?.nrr ?? 0;
  const rank = (ids: number[]) => [...ids].sort((a, b) => ptsOf(b) - ptsOf(a) || nrrOf(b) - nrrOf(a));
  const out: Record<string, 'Q' | 'E'> = {};
  const thirds: number[] = [];
  for (const group of st.groups)
    rank(group).forEach((idx, pos) => {
      const id = st.players[idx]?.id;
      if (!id) return;
      if (pos < K) out[id] = 'Q';
      else if (bestThirds && pos === K) thirds.push(idx); // 3rd-placed — decide via best-thirds
      else out[id] = 'E';
    });
  if (bestThirds && thirds.length) {
    const through = new Set(rank(thirds).slice(0, 2));
    for (const idx of thirds) {
      const id = st.players[idx]?.id;
      if (id) out[id] = through.has(idx) ? 'Q' : 'E';
    }
  }
  return out;
}

function sameQual(a: Record<string, 'Q' | 'E'>, b?: Record<string, 'Q' | 'E'>): boolean {
  if (!b) return Object.keys(a).length === 0;
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
}

/** Persist one completed bot-league tournament and cache it for the history view. */
export function recordBotTournament(input: {
  format: number;
  champion: string;
  runnerUp: string | null;
  standings: BotTournamentStanding[];
  state: TournamentState;
}): void {
  const isSuper = isSuperLeagueState(input.state);
  const name = isSuper
    ? botSuperLeagueName((botSuperLeagueCount += 1))
    : botLeagueName(
        input.format,
        (botTournamentCount[input.format] = (botTournamentCount[input.format] ?? 0) + 1)
      );
  const season = currentSeason?.number ?? 1;
  const summary: BotTournamentSummary = {
    format: input.format,
    season,
    name,
    champion: input.champion,
    runnerUp: input.runnerUp,
    finishedAt: new Date().toISOString(),
    standings: input.standings,
    state: input.state,
  };
  botTournaments.unshift(summary);
  if (botTournaments.length > BOT_HISTORY_CAP) botTournaments.length = BOT_HISTORY_CAP;
  persist(
    prisma.botTournament.create({
      data: {
        format: input.format,
        season,
        isSuperLeague: isSuper,
        name: summary.name,
        champion: input.champion,
        runnerUp: input.runnerUp ?? undefined,
        standings: input.standings as unknown as Prisma.InputJsonValue,
        state: input.state as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(summary.finishedAt),
      },
    }),
    'recordBotTournament'
  );
}

/** Past completed bot tournaments (newest first), optionally filtered by format. */
export function getBotTournaments(format?: number): BotTournamentSummary[] {
  return format ? botTournaments.filter((t) => t.format === format) : botTournaments;
}

/** Ranked standings for a format: every roster bot, highest rating first. */
export function getBotRankings(format: number): BotRankingEntry[] {
  const rows = [...botRankings.values()].filter((r) => r.format === format);
  rows.sort(
    (x, y) =>
      y.rating - x.rating ||
      y.wins - x.wins ||
      y.trophies - x.trophies ||
      x.botName.localeCompare(y.botName)
  );
  return rows.map((r, i) => ({
    rank: i + 1,
    botName: r.botName,
    format: r.format,
    rating: Math.round(r.rating),
    played: r.played,
    wins: r.wins,
    losses: r.losses,
    ties: r.ties,
    trophies: r.trophies,
    winPct: r.played ? Math.round((r.wins / r.played) * 100) : 0,
    careerPlayed: r.careerPlayed,
    careerWins: r.careerWins,
    careerTrophies: r.careerTrophies,
    careerWinPct: r.careerPlayed ? Math.round((r.careerWins / r.careerPlayed) * 100) : 0,
  }));
}

// ─── Bot seasons ────────────────────────────────────────────────────────────────
// A season = a competitive block of title leagues. It ends once all three caps are
// met (20 five-over + 20 ten-over + 10 Super League), at which point the champion is
// crowned (most SEASON trophies across formats → win% → wins → runs), the season is
// archived, and every bot's SEASON stats reset to base for the next season. Lifetime
// data (career totals, head-to-head, records, tournament history) is never touched.

const SEASON_CAPS = { five: 20, ten: 20, super: 10 } as const;
type LeagueCategory = 'five' | 'ten' | 'super';

interface SeasonRow {
  number: number;
  leagues5: number;
  leagues10: number;
  leaguesSuper: number;
}
let currentSeason: SeasonRow | null = null;
const pastSeasons: import('@cric/types').BotSeasonArchive[] = []; // newest first

/** Load the open season (+ past champions) at boot; opens Season 1 if none exists. */
async function loadBotSeasons(): Promise<void> {
  try {
    const rows = await prisma.botSeason.findMany({ orderBy: { number: 'desc' } });
    pastSeasons.length = 0;
    for (const s of rows)
      if (s.endedAt)
        pastSeasons.push({
          number: s.number,
          champion: s.champion,
          championTrophies: s.championTrophies,
          endedAt: s.endedAt.toISOString(),
          standings: (s.standings as unknown as import('@cric/types').BotSeasonStanding[]) ?? [],
        });
    const open = rows.find((s) => !s.endedAt);
    if (open) {
      currentSeason = { number: open.number, leagues5: open.leagues5, leagues10: open.leagues10, leaguesSuper: open.leaguesSuper };
    } else {
      const nextNum = (rows[0]?.number ?? 0) + 1;
      currentSeason = { number: nextNum, leagues5: 0, leagues10: 0, leaguesSuper: 0 };
      persist(prisma.botSeason.create({ data: { number: nextNum } }), 'openBotSeason');
    }
  } catch (err) {
    console.error('[db] bot seasons unavailable (is the BotSeason migration applied?):', (err as Error)?.message ?? err);
    currentSeason = null;
  }
}

/** Category of a finished title league, for the per-format season caps. */
export function leagueCategory(format: number, isSuperLeague: boolean): LeagueCategory {
  return isSuperLeague ? 'super' : format === 5 ? 'five' : 'ten';
}

/**
 * Count one finished TITLE league toward the current season, and roll the season
 * over (crown + reset) once every cap is met. Returns the just-ended season summary
 * when it rolled over, else null. Qualifiers must NOT be passed here.
 */
export function noteTitleLeaguePlayed(category: LeagueCategory): { number: number; champion: string | null; championTrophies: number } | null {
  if (!currentSeason) return null;
  if (category === 'five' && currentSeason.leagues5 < SEASON_CAPS.five) currentSeason.leagues5++;
  else if (category === 'ten' && currentSeason.leagues10 < SEASON_CAPS.ten) currentSeason.leagues10++;
  else if (category === 'super' && currentSeason.leaguesSuper < SEASON_CAPS.super) currentSeason.leaguesSuper++;
  const s = currentSeason;
  persist(
    prisma.botSeason.update({
      where: { number: s.number },
      data: { leagues5: s.leagues5, leagues10: s.leagues10, leaguesSuper: s.leaguesSuper },
    }),
    'botSeasonProgress'
  );
  if (s.leagues5 >= SEASON_CAPS.five && s.leagues10 >= SEASON_CAPS.ten && s.leaguesSuper >= SEASON_CAPS.super) {
    return endSeason();
  }
  return null;
}

/** Crown the season champion, archive the season, reset all SEASON stats, open next. */
function endSeason(): { number: number; champion: string | null; championTrophies: number } {
  const number = currentSeason!.number;
  // Aggregate each bot's SEASON stats across both formats.
  const agg = new Map<string, { trophies: number; wins: number; played: number; runs: number }>();
  for (const r of botRankings.values()) {
    const e = agg.get(r.botName) ?? { trophies: 0, wins: 0, played: 0, runs: 0 };
    e.trophies += r.trophies;
    e.wins += r.wins;
    e.played += r.played;
    e.runs += r.runsFor;
    agg.set(r.botName, e);
  }
  const ranked = [...agg.entries()]
    .map(([name, s]) => ({ name, ...s, winPct: s.played ? s.wins / s.played : 0 }))
    .sort((a, b) => b.trophies - a.trophies || b.winPct - a.winPct || b.wins - a.wins || b.runs - a.runs);
  const champion = ranked[0]?.name ?? null;
  const championTrophies = ranked[0]?.trophies ?? 0;
  const standings = ranked.map((r) => ({
    name: r.name,
    trophies: r.trophies,
    wins: r.wins,
    played: r.played,
    winPct: Math.round(r.winPct * 100),
    runs: r.runs,
  }));

  // Archive the finished season.
  persist(
    prisma.botSeason.update({
      where: { number },
      data: { endedAt: new Date(), champion, championTrophies, standings: standings as unknown as Prisma.InputJsonValue },
    }),
    'archiveBotSeason'
  );
  pastSeasons.unshift({ number, champion, championTrophies, endedAt: new Date().toISOString(), standings });

  // Reset every bot's SEASON stats to base (career + batFirst untouched).
  for (const r of botRankings.values()) {
    r.rating = ELO_BASE;
    r.played = 0;
    r.wins = 0;
    r.losses = 0;
    r.ties = 0;
    r.trophies = 0;
    r.runsFor = 0;
    r.runsAgainst = 0;
    persistBotRow(r);
  }

  // Open the next season.
  const nextNum = number + 1;
  currentSeason = { number: nextNum, leagues5: 0, leagues10: 0, leaguesSuper: 0 };
  persist(prisma.botSeason.create({ data: { number: nextNum } }), 'openBotSeason');

  console.log(`[db] Season ${number} ended — champion: ${champion ?? 'none'} (${championTrophies} trophies). Season ${nextNum} opened.`);
  return { number, champion, championTrophies };
}

/** Current season + progress + past champions, for the client. */
export function getBotSeasonInfo(): import('@cric/types').BotSeasonInfo {
  return {
    number: currentSeason?.number ?? 1,
    leagues5: currentSeason?.leagues5 ?? 0,
    leagues10: currentSeason?.leagues10 ?? 0,
    leaguesSuper: currentSeason?.leaguesSuper ?? 0,
    caps: { ...SEASON_CAPS },
    pastChampions: pastSeasons,
  };
}

/**
 * Auto-generated "league news" headlines, built PURELY from recorded data — every
 * line is derived from real results, standings and head-to-head, so nothing is
 * invented. Returned newest/juiciest first for the Bot League news ticker. Season
 * stats (.trophies) reset each season; career totals, H2H and batting-first are
 * lifetime, and the wording reflects that so the facts stay accurate.
 */
export function generateBotNews(): string[] {
  const news: string[] = [];
  const isSuper = (t: BotTournamentSummary) =>
    t.name.startsWith('Bot Super League') || t.state?.size === 16;
  const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const seasonNo = currentSeason?.number ?? 1;

  // 1) The latest title decided.
  const latest = botTournaments[0];
  if (latest) {
    const label = isSuper(latest) ? 'Super League' : `${latest.format}-over`;
    news.push(
      latest.runnerUp
        ? `🏆 ${latest.champion} lift the ${label} crown, beating ${latest.runnerUp} in the final.`
        : `🏆 ${latest.champion} are the latest ${label} champions.`
    );
  }

  // Trophy tallies per bot: season (resets) and career (lifetime), summed across formats.
  const seasonT = new Map<string, number>();
  const careerT = new Map<string, number>();
  for (const r of botRankings.values()) {
    seasonT.set(r.botName, (seasonT.get(r.botName) ?? 0) + r.trophies);
    careerT.set(r.botName, (careerT.get(r.botName) ?? 0) + r.careerTrophies);
  }

  // Tie-aware "who's on top" of a per-bot tally: returns every bot sharing the max.
  const topOf = (m: Map<string, number>) => {
    const ranked = [...m.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;
    const value = ranked[0][1];
    return { leaders: ranked.filter(([, v]) => v === value).map(([n]) => n), value };
  };

  // 2) Who leads THIS season (tie-aware).
  const sLead = topOf(seasonT);
  if (sLead)
    news.push(
      sLead.leaders.length === 1
        ? `📈 Season ${seasonNo} race: ${sLead.leaders[0]} out front with ${plural(sLead.value, 'title')}.`
        : sLead.leaders.length === 2
          ? `📈 Season ${seasonNo} race: ${sLead.leaders[0]} & ${sLead.leaders[1]} tied at the top with ${plural(sLead.value, 'title')} each.`
          : `📈 Season ${seasonNo} race: ${sLead.leaders.length} bots tied on ${plural(sLead.value, 'title')}.`
    );

  // 3) Reigning past-season champion still title-less this season.
  const lastPast = pastSeasons[0]; // newest archived season
  if (lastPast?.champion && (seasonT.get(lastPast.champion) ?? 0) === 0)
    news.push(`📰 Season ${lastPast.number} champion ${lastPast.champion} still without a title in Season ${seasonNo}…`);

  // 4) Consecutive-title streaks per bucket.
  const buckets: Array<{ label: string; pick: (t: BotTournamentSummary) => boolean }> = [
    { label: '5-over', pick: (t) => t.format === 5 && !isSuper(t) },
    { label: '10-over', pick: (t) => t.format === 10 && !isSuper(t) },
    { label: 'Super League', pick: (t) => isSuper(t) },
  ];
  for (const b of buckets) {
    const seq = botTournaments.filter(b.pick); // newest first
    if (seq.length >= 2 && seq[0].champion) {
      let k = 1;
      while (k < seq.length && seq[k].champion === seq[0].champion) k++;
      if (k >= 2) news.push(`🔥 ${seq[0].champion} on a ${k}-title streak in the ${b.label}.`);
    }
  }

  // 5) Biggest all-time rivalry — COMBINED across both formats. H2H is stored per
  // format, so sum the 5-over and 10-over records for each pair (nameA/nameB are the
  // same sorted orientation across formats, so aWins/bWins line up) for a true
  // overall head-to-head.
  const rivalry = new Map<string, { nameA: string; nameB: string; a: number; b: number; ties: number }>();
  for (const h of botH2H.values()) {
    const e = rivalry.get(h.pair) ?? { nameA: h.nameA, nameB: h.nameB, a: 0, b: 0, ties: 0 };
    e.a += h.aWins;
    e.b += h.bWins;
    e.ties += h.ties;
    rivalry.set(h.pair, e);
  }
  let riv: { win: string; lose: string; w: number; l: number; total: number } | null = null;
  for (const e of rivalry.values()) {
    const total = e.a + e.b + e.ties;
    if (total < 4) continue;
    const aLeads = e.a >= e.b;
    const cand = {
      win: aLeads ? e.nameA : e.nameB,
      lose: aLeads ? e.nameB : e.nameA,
      w: aLeads ? e.a : e.b,
      l: aLeads ? e.b : e.a,
      total,
    };
    if (!riv || cand.total > riv.total) riv = cand;
  }
  if (riv && riv.w > riv.l)
    news.push(`🥊 Rivalry: ${riv.win} lead ${riv.w}–${riv.l} all-time (both formats) against ${riv.lose}.`);

  // 6) All-time honours leader (lifetime titles, tie-aware).
  const cLead = topOf(careerT);
  if (cLead)
    news.push(
      cLead.leaders.length === 1
        ? `👑 All-time: ${cLead.leaders[0]} tops the honours board with ${plural(cLead.value, 'career title')}.`
        : cLead.leaders.length === 2
          ? `👑 All-time: ${cLead.leaders[0]} & ${cLead.leaders[1]} share top spot with ${plural(cLead.value, 'career title')} each.`
          : `👑 All-time: ${cLead.leaders.length} bots share top spot with ${plural(cLead.value, 'career title')} each.`
    );

  // 7) Strongest batting-first record (lifetime, per format, decent sample).
  let bf: { name: string; pct: number; fmt: number } | null = null;
  for (const r of botRankings.values()) {
    if (r.batFirst < 6) continue;
    const pct = Math.round((r.batFirstWins / r.batFirst) * 100);
    if (!bf || pct > bf.pct) bf = { name: r.botName, pct, fmt: r.format };
  }
  if (bf) news.push(`🏏 ${bf.name} win ${bf.pct}% of their ${bf.fmt}-over games batting first.`);

  // 8) Per-format season trophy leaders (by margin over the chasing pack).
  for (const fmt of [5, 10] as const) {
    const fmtT: Array<[string, number]> = [];
    for (const r of botRankings.values()) if (r.format === fmt && r.trophies > 0) fmtT.push([r.botName, r.trophies]);
    fmtT.sort((a, b) => b[1] - a[1]);
    if (!fmtT.length) continue;
    const top = fmtT[0][1];
    const tiedTop = fmtT.filter(([, t]) => t === top).map(([n]) => n);
    if (tiedTop.length > 1)
      news.push(`🏅 Season ${seasonNo} ${fmt}-over: ${tiedTop.slice(0, 2).join(' & ')} tied on ${plural(top, 'trophy', 'trophies')}.`);
    else {
      const margin = top - (fmtT[1]?.[1] ?? 0);
      news.push(`🏅 Season ${seasonNo} ${fmt}-over: ${fmtT[0][0]} lead by ${plural(margin, 'trophy', 'trophies')}.`);
    }
  }

  // 9) Most career wins (lifetime, tie-aware).
  const careerW = new Map<string, number>();
  for (const r of botRankings.values()) careerW.set(r.botName, (careerW.get(r.botName) ?? 0) + r.careerWins);
  const wLead = topOf(careerW);
  if (wLead)
    news.push(
      wLead.leaders.length === 1
        ? `🎯 ${wLead.leaders[0]} has the most career wins (${wLead.value}).`
        : `🎯 ${wLead.leaders.slice(0, 2).join(' & ')} lead career wins with ${plural(wLead.value, 'win')} each.`
    );

  // 10) A one-sided head-to-head (per format): one bot still winless against another.
  // Pick the most lopsided (loser has 0 wins; winner has a clear pile of ≥4).
  let hoodoo: { loser: string; winner: string; fmt: number; total: number; wins: number } | null = null;
  for (const h of botH2H.values()) {
    const total = h.aWins + h.bWins + h.ties;
    if (h.bWins === 0 && h.aWins >= 4 && (!hoodoo || h.aWins > hoodoo.wins))
      hoodoo = { loser: h.nameB, winner: h.nameA, fmt: h.format, total, wins: h.aWins };
    else if (h.aWins === 0 && h.bWins >= 4 && (!hoodoo || h.bWins > hoodoo.wins))
      hoodoo = { loser: h.nameA, winner: h.nameB, fmt: h.format, total, wins: h.bWins };
  }
  if (hoodoo)
    news.push(
      `🚫 ${hoodoo.loser} are yet to beat ${hoodoo.winner} in the ${hoodoo.fmt}-over (winless in ${plural(hoodoo.total, 'meeting')}).`
    );

  if (news.length === 0)
    news.push('📰 The Bot League is warming up — headlines appear as titles are decided.');
  return news.slice(0, 12);
}

/**
 * A compact, factual DATA SNAPSHOT of the league (not headlines) for the AI news
 * writer to work from. It gives the model raw material — recent results, standings,
 * rivalries, streaks — so it can pick its own angles and write freely, while every
 * hard fact it might cite is present and true here. Contains NO bot personalities.
 */
export function getBotNewsContext(): string {
  const L: string[] = [];
  const isSuper = (t: BotTournamentSummary) =>
    t.name.startsWith('Bot Super League') || t.state?.size === 16;
  const seasonNo = currentSeason?.number ?? 1;

  L.push('League: "Cric Flick" — 16 named bots. Formats: 5-over, 10-over, and a 16-bot Super League. Each season resets all standings.');
  L.push(
    `Current season: ${seasonNo}. Titles decided so far — 5-over ${currentSeason?.leagues5 ?? 0}/${SEASON_CAPS.five}, 10-over ${currentSeason?.leagues10 ?? 0}/${SEASON_CAPS.ten}, Super League ${currentSeason?.leaguesSuper ?? 0}/${SEASON_CAPS.super}.`
  );

  const recent = botTournaments.slice(0, 6);
  if (recent.length) {
    L.push('Recent results (newest first):');
    for (const t of recent) {
      const label = isSuper(t) ? 'Super League' : `${t.format}-over`;
      L.push(`- Season ${t.season} ${label}: ${t.champion} won${t.runnerUp ? `, beating ${t.runnerUp} in the final` : ''}.`);
    }
  }

  const champOf = (pick: (t: BotTournamentSummary) => boolean) => botTournaments.find(pick)?.champion ?? null;
  L.push(
    `Reigning champions — 5-over: ${champOf((t) => t.format === 5 && !isSuper(t)) ?? 'none yet'}; 10-over: ${champOf((t) => t.format === 10 && !isSuper(t)) ?? 'none yet'}; Super League: ${champOf(isSuper) ?? 'none yet'}.`
  );

  const seasonT = new Map<string, number>();
  const careerT = new Map<string, number>();
  const careerW = new Map<string, number>();
  for (const r of botRankings.values()) {
    seasonT.set(r.botName, (seasonT.get(r.botName) ?? 0) + r.trophies);
    careerT.set(r.botName, (careerT.get(r.botName) ?? 0) + r.careerTrophies);
    careerW.set(r.botName, (careerW.get(r.botName) ?? 0) + r.careerWins);
  }
  const topList = (m: Map<string, number>, n: number) =>
    [...m.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, v]) => `${name} ${v}`).join(', ');
  const st = topList(seasonT, 6); if (st) L.push(`Season ${seasonNo} title counts: ${st}.`);
  const ct = topList(careerT, 6); if (ct) L.push(`All-time title counts: ${ct}.`);
  const cw = topList(careerW, 5); if (cw) L.push(`All-time match wins: ${cw}.`);

  for (const s of pastSeasons.slice(0, 2))
    if (s.champion) L.push(`Season ${s.number} champion: ${s.champion}${s.championTrophies != null ? ` (${s.championTrophies} titles that season)` : ''}.`);

  // Head-to-head combined across both formats.
  const rivalry = new Map<string, { a: string; b: string; aw: number; bw: number; ties: number }>();
  for (const h of botH2H.values()) {
    const e = rivalry.get(h.pair) ?? { a: h.nameA, b: h.nameB, aw: 0, bw: 0, ties: 0 };
    e.aw += h.aWins; e.bw += h.bWins; e.ties += h.ties;
    rivalry.set(h.pair, e);
  }
  const rivs = [...rivalry.values()]
    .map((e) => ({ ...e, total: e.aw + e.bw + e.ties }))
    .filter((e) => e.total >= 4)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  if (rivs.length) {
    L.push('Head-to-head (all-time, both formats):');
    for (const e of rivs) {
      if (e.aw === 0 && e.bw >= 4) L.push(`- ${e.a} has never beaten ${e.b} (0-${e.bw} in ${e.total} meetings).`);
      else if (e.bw === 0 && e.aw >= 4) L.push(`- ${e.b} has never beaten ${e.a} (0-${e.aw} in ${e.total} meetings).`);
      else L.push(`- ${e.a} ${e.aw}-${e.bw} ${e.b}${e.ties ? ` (${e.ties} tied)` : ''}.`);
    }
  }

  const buckets: Array<[string, (t: BotTournamentSummary) => boolean]> = [
    ['5-over', (t) => t.format === 5 && !isSuper(t)],
    ['10-over', (t) => t.format === 10 && !isSuper(t)],
    ['Super League', isSuper],
  ];
  for (const [label, pick] of buckets) {
    const seq = botTournaments.filter(pick);
    if (seq.length >= 2 && seq[0].champion) {
      let k = 1;
      while (k < seq.length && seq[k].champion === seq[0].champion) k++;
      if (k >= 2) L.push(`Streak: ${seq[0].champion} has won the last ${k} ${label} titles in a row.`);
    }
  }

  const bf = [...botRankings.values()]
    .filter((r) => r.batFirst >= 6)
    .map((r) => ({ name: r.botName, fmt: r.format, pct: Math.round((r.batFirstWins / r.batFirst) * 100) }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 3);
  if (bf.length) L.push(`Batting-first win rate: ${bf.map((x) => `${x.name} ${x.pct}% (${x.fmt}-over)`).join(', ')}.`);

  return L.join('\n');
}

/** Whether another title league of this category may start (its season cap isn't hit
 *  yet). Qualifiers don't count toward a season, so callers shouldn't gate them. */
export function canStartLeague(category: LeagueCategory): boolean {
  if (!currentSeason) return true; // seasons unavailable → don't block starts
  if (category === 'five') return currentSeason.leagues5 < SEASON_CAPS.five;
  if (category === 'ten') return currentSeason.leagues10 < SEASON_CAPS.ten;
  return currentSeason.leaguesSuper < SEASON_CAPS.super;
}

/** Admin: force the current season to roll over now (crown champion + reset), before
 *  the caps are reached. Returns the just-ended season summary (null if unavailable). */
export function forceEndBotSeason(): { number: number; champion: string | null; championTrophies: number } | null {
  return currentSeason ? endSeason() : null;
}

// ─── Admin stats ───────────────────────────────────────────────────────────────

/**
 * Aggregate stats for the admin dashboard, computed synchronously from the
 * in-memory cache + bot state (the runtime counts — online users, live rooms,
 * active tournaments, queue — are added by the admin route, which has the maps).
 */
export function getAdminStats(): Omit<
  AdminStats,
  'online' | 'liveRooms' | 'activeTournaments' | 'queueWaiting'
> {
  const users = cache.users;
  const sum = (f: (u: DbUser) => number) => users.reduce((a, u) => a + f(u), 0);
  return {
    users: users.length,
    usersPlayed: users.filter((u) => u.stats.gamesPlayed > 0).length,
    totalGamesPlayed: sum((u) => u.stats.gamesPlayed),
    totalRunsScored: sum((u) => u.stats.runsScored),
    matchHistoryRows: sum((u) => u.matchHistory.length),
    friendships: Math.round(sum((u) => u.friends?.length ?? 0) / 2),
    coinsInCirculation: sum((u) => u.coins ?? 0),
    tournamentsPlayed: sum((u) => u.achievements?.tournamentsPlayed ?? 0),
    tournamentsWon: sum((u) => u.achievements?.tournamentsWon ?? 0),
    botLeaguesCompleted:
      Object.values(botTournamentCount).reduce((a, b) => a + b, 0) + botSuperLeagueCount,
    botH2HPairs: botH2H.size,
    botRankingRows: botRankings.size,
  };
}

// ─── ML profiles & ball log ──────────────────────────────────────────────────────

// Profiles are keyed by registered user id (stable + unspoofable). Guests/bots
// are logged for analysis but not served a profile.
export function getPlayerProfile(userId: string): MLModelData | null {
  return mlProfiles[userId] ?? null;
}

/** One ball's decision plus the full situation it was made in. */
export interface BallEventInput {
  roomId: string;
  userId: string | null;
  playerName: string;
  isBot: boolean;
  botStyle: string | null;
  role: 'bat' | 'bowl';
  move: number;
  /** This player's previous move this innings (for ML transitions). */
  prevMove: number | null;
  /** nth ball of the innings, 0-based. */
  ballIndex: number;
  innings: number;
  battingFirst: boolean;
  chasing: boolean;
  overs: number;
  wickets: number;
  isTournament: boolean;
  opponentMove: number | null;
  scored: number;
  isOut: boolean;
}

// Ball events are buffered and flushed in batches — they're high-volume
// (per-ball) and non-critical, so we never block the game on them.
const ballQueue: BallEventInput[] = [];
let ballFlushTimer: ReturnType<typeof setTimeout> | null = null;
const BALL_QUEUE_CAP = 10000;

function scheduleBallFlush(): void {
  if (ballFlushTimer) return;
  ballFlushTimer = setTimeout(flushBalls, 2000);
}

async function flushBalls(): Promise<void> {
  ballFlushTimer = null;
  if (ballQueue.length === 0) return;
  const batch = ballQueue.splice(0, ballQueue.length);
  try {
    await prisma.ballEvent.createMany({
      data: batch.map((e) => ({
        roomId: e.roomId,
        userId: e.userId,
        playerName: e.playerName,
        isBot: e.isBot,
        botStyle: e.botStyle,
        role: e.role,
        move: e.move,
        prevMove: e.prevMove,
        ballIndex: e.ballIndex,
        innings: e.innings,
        battingFirst: e.battingFirst,
        chasing: e.chasing,
        overs: e.overs,
        wickets: e.wickets,
        isTournament: e.isTournament,
        opponentMove: e.opponentMove,
        scored: e.scored,
        isOut: e.isOut,
      })),
    });
  } catch (err) {
    console.error('[db] ballEvent flush failed:', (err as Error)?.message ?? err);
    // Requeue for a retry, but cap so a prolonged DB outage can't grow unbounded.
    if (ballQueue.length < BALL_QUEUE_CAP) ballQueue.unshift(...batch);
    scheduleBallFlush();
  }
}

/**
 * Record every ball of a resolved delivery: durably log each player's decision +
 * context (humans AND bots), and update the in-memory ML model for registered
 * players. Replaces the old persisted-profile training path.
 */
export function recordBalls(events: BallEventInput[]): void {
  for (const e of events) {
    if (e.userId) applyToProfile(e.userId, e.role, e.move, e.prevMove ?? undefined);
    // Keep the global human-move model fresh within a running server (no restart
    // needed to "level up"). Human balls only.
    if (!e.isBot)
      observeHuman(e.role, e.innings, phaseOf(e.ballIndex, e.overs * 6), e.prevMove ?? null, e.move);
  }
  // Persist HUMAN balls only. Bot-vs-bot balls were ~95% of the ball log (~170 MB)
  // yet are never read: the move model + per-user profiles both use human balls only,
  // and match records/stats/Hall of Fame live in other tables. A bot's move in a
  // human match is still captured as `opponentMove` on the human's row, so no signal
  // is lost — this just stops the storage bloat.
  ballQueue.push(...events.filter((e) => !e.isBot));
  scheduleBallFlush();
}
