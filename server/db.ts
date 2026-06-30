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
    const all = await prisma.botTournament.findMany({ orderBy: { finishedAt: 'asc' } });
    for (const f of BOT_FORMATS) botTournamentCount[f] = 0;
    botSuperLeagueCount = 0;
    for (const t of all) {
      // Super Leagues (12-team final state) get their own running sequence and are
      // kept out of the per-format count, matching how new ones are named.
      const want = isSuperLeagueState(t.state as unknown as TournamentState | null)
        ? botSuperLeagueName((botSuperLeagueCount += 1))
        : botLeagueName(
            t.format,
            (botTournamentCount[t.format] = (botTournamentCount[t.format] ?? 0) + 1)
          );
      if (t.name !== want) {
        t.name = want; // fix the local copy used below
        persist(
          prisma.botTournament.update({ where: { id: t.id }, data: { name: want } }),
          'backfillBotTournamentName'
        );
      }
    }
    botTournaments.length = 0;
    for (const t of [...all].reverse().slice(0, BOT_HISTORY_CAP))
      botTournaments.push({
        format: t.format,
        name: t.name ?? botLeagueName(t.format, 0),
        champion: t.champion,
        runnerUp: t.runnerUp,
        finishedAt: t.finishedAt.toISOString(),
        standings: (t.standings as unknown as BotTournamentStanding[]) ?? [],
        state: (t.state as unknown as TournamentState) ?? null,
      });

    // Self-heal trophy counts from the authoritative championship record: a bot's
    // trophies for a format == how many tournaments of that format it has won. This
    // repairs any ranking row whose trophy count drifted (e.g. got zeroed by a stale
    // fresh-row overwrite) and keeps it honest on every boot. Leaves correct rows
    // untouched. (Super Leagues are stored as format 10, matching how titles are
    // credited, so counting by format stays consistent.)
    const trophyByKey = new Map<string, number>();
    for (const t of all)
      if (t.champion) {
        const k = botKey(t.champion, t.format);
        trophyByKey.set(k, (trophyByKey.get(k) ?? 0) + 1);
      }
    let healed = 0;
    for (const [key, row] of botRankings) {
      const correct = trophyByKey.get(key) ?? 0;
      if (row.trophies !== correct) {
        row.trophies = correct;
        persistBotRow(row);
        healed++;
      }
    }
    if (healed) console.log(`[db] healed ${healed} bot trophy count(s) from championship history`);
  } catch (err) {
    console.error(
      '[db] bot tournament history unavailable (is the BotTournament migration applied?):',
      (err as Error)?.message ?? err
    );
  }

  const balls = await prisma.ballEvent.findMany({
    where: { userId: { not: null } },
    orderBy: { id: 'desc' },
    take: 50000,
    select: { userId: true, role: true, move: true, prevMove: true },
  });
  balls.reverse();
  for (const b of balls)
    applyToProfile(b.userId!, b.role as 'bat' | 'bowl', b.move, b.prevMove ?? undefined);

  // Train the global, context-aware human-move model from history (human balls
  // only — predicting bots would be pointless). Bots use it as a prior so they
  // read a human well from ball one; it sharpens as more games are logged.
  const humanBalls = await prisma.ballEvent.findMany({
    where: { isBot: false },
    orderBy: { id: 'desc' },
    take: 100000,
    select: { role: true, innings: true, ballIndex: true, overs: true, prevMove: true, move: true },
  });
  resetOpponentModel();
  for (const b of humanBalls)
    observeHuman(b.role as Role, b.innings, phaseOf(b.ballIndex, b.overs * 6), b.prevMove ?? null, b.move);

  console.log(
    `[db] ready — ${cache.users.length} users, ${recs.length} records, ${balls.length} ball-events replayed; ` +
      `human-move model trained on ${humanBalls.length} balls (ready=${opponentModelReady()})`
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
  { id: 'emotes', label: 'Full Emote Pack', description: 'Unlock every in-match taunt emote.', price: 40 },
];

/** Coins awarded for various actions. */
export const COIN_REWARDS = {
  // Finishing a Quick Match against a stranger (friends are excluded — no farming).
  quickMatch: 5,
  // Winning a tournament that had at least one of your friends in it.
  tournamentWinWithFriend: 20,
  // Backing the champion bot in a bot league.
  bidWin: 50,
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
  rating: number;
  played: number;
  wins: number;
  losses: number;
  ties: number;
  trophies: number;
  runsFor: number;
  runsAgainst: number;
}

const botRankings = new Map<string, BotRankingRow>(); // keyed by `${botName}|${format}`
const botKey = (name: string, format: number) => `${name}|${format}`;

// ─── Lifetime bot-vs-bot head-to-head ──────────────────────────────────────────
// One row per unordered pair of bots PER FORMAT (5 vs 10 are tracked separately),
// accumulated across every bot-league match (group + knockouts). Keyed by the two
// names sorted into "A|B" plus the format; aWins/bWins follow nameA/nameB. Loaded
// at boot, updated per match, reset on reset.
type BotH2HRow = { pair: string; format: number; nameA: string; nameB: string; aWins: number; bWins: number; ties: number };
const botH2H = new Map<string, BotH2HRow>(); // keyed by `${pair}|${format}`
const h2hCacheKey = (pair: string, format: number) => `${pair}|${format}`;

/** Canonical (order-independent) key + name ordering for a bot pair. */
function h2hPair(x: string, y: string): { pair: string; nameA: string; nameB: string } {
  const [nameA, nameB] = x.localeCompare(y) <= 0 ? [x, y] : [y, x];
  return { pair: `${nameA}|${nameB}`, nameA, nameB };
}

function persistBotH2H(row: BotH2HRow): void {
  persist(
    prisma.botHeadToHead.upsert({
      where: { pair_format: { pair: row.pair, format: row.format } },
      create: { pair: row.pair, format: row.format, nameA: row.nameA, nameB: row.nameB, aWins: row.aWins, bWins: row.bWins, ties: row.ties },
      update: { aWins: row.aWins, bWins: row.bWins, ties: row.ties },
    }),
    'botH2H'
  );
}

/** Fold one finished bot-vs-bot match into the per-format head-to-head record. */
function recordBotH2H(aName: string, bName: string, winnerName: string | null, format: number): void {
  if (aName === bName) return;
  const { pair, nameA, nameB } = h2hPair(aName, bName);
  const key = h2hCacheKey(pair, format);
  let row = botH2H.get(key);
  if (!row) {
    row = { pair, format, nameA, nameB, aWins: 0, bWins: 0, ties: 0 };
    botH2H.set(key, row);
  }
  if (winnerName === null) row.ties++;
  else if (winnerName === row.nameA) row.aWins++;
  else row.bWins++;
  persistBotH2H(row);
}

/** Lifetime head-to-head between two bots for a format, oriented to (x, y). */
export function getBotHeadToHead(
  x: string,
  y: string,
  format: number
): { played: number; xWins: number; yWins: number; ties: number } {
  const row = botH2H.get(h2hCacheKey(h2hPair(x, y).pair, format));
  if (!row) return { played: 0, xWins: 0, yWins: 0, ties: 0 };
  const xIsA = row.nameA === x;
  const xWins = xIsA ? row.aWins : row.bWins;
  const yWins = xIsA ? row.bWins : row.aWins;
  return { played: xWins + yWins + row.ties, xWins, yWins, ties: row.ties };
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
              ? { rating: ELO_BASE, played: 0, wins: 0, losses: 0, ties: 0, trophies: 0, runsFor: 0, runsAgainst: 0 }
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
}): void {
  const { format, aName, aScore, bName, bScore, result } = input;
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
  a.runsFor += aScore;
  a.runsAgainst += bScore;
  b.runsFor += bScore;
  b.runsAgainst += aScore;
  if (sA === 1) {
    a.wins++;
    b.losses++;
  } else if (sA === 0) {
    a.losses++;
    b.wins++;
  } else {
    a.ties++;
    b.ties++;
  }

  persistBotRow(a);
  persistBotRow(b);

  // Lifetime head-to-head (per format): winner by the authoritative result.
  recordBotH2H(aName, bName, result === 'a' ? aName : result === 'b' ? bName : null, format);
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

/** Award a bot-league trophy (a tournament title) to the winning bot for a format. */
export function recordBotTrophy(botName: string, format: number): void {
  const row = getOrCreateBotRow(botName, format);
  row.trophies++;
  persistBotRow(row);
}

// Durable history of completed bot-league tournaments, newest first. Loaded at
// boot and appended on each finalize; capped in memory (DB keeps everything).
const botTournaments: BotTournamentSummary[] = [];
const BOT_HISTORY_CAP = 50;
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

/** Persist one completed bot-league tournament and cache it for the history view. */
export function recordBotTournament(input: {
  format: number;
  champion: string;
  runnerUp: string | null;
  standings: BotTournamentStanding[];
  state: TournamentState;
}): void {
  const name = isSuperLeagueState(input.state)
    ? botSuperLeagueName((botSuperLeagueCount += 1))
    : botLeagueName(
        input.format,
        (botTournamentCount[input.format] = (botTournamentCount[input.format] ?? 0) + 1)
      );
  const summary: BotTournamentSummary = {
    format: input.format,
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
  }));
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
  ballQueue.push(...events);
  scheduleBallFlush();
}
