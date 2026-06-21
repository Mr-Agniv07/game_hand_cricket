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

/** Ensure every roster bot has a row in both formats (cache + DB). */
function seedBotRankings(): void {
  for (const name of BOT_NAMES) {
    for (const format of BOT_FORMATS) {
      if (!botRankings.has(botKey(name, format))) {
        const row = freshBotRow(name, format);
        botRankings.set(botKey(name, format), row);
        persistBotRow(row);
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
}

/** Award a bot-league trophy (a tournament title) to the winning bot for a format. */
export function recordBotTrophy(botName: string, format: number): void {
  const row = getOrCreateBotRow(botName, format);
  row.trophies++;
  persistBotRow(row);
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
