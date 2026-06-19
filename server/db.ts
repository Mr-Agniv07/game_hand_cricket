import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type {
  UserStats,
  MatchHistoryEntry,
  PublicUser,
  Friend,
  LeaderboardEntry,
  UserAchievements,
  GlobalRecords,
  OversRecords,
  GameRecord,
} from '@cric/types';

const __dir = dirname(fileURLToPath(import.meta.url));
// Defaults to server/db.json; DB_PATH env lets tests point at a throwaway file
// so they never touch the real database.
const DB_PATH = process.env.DB_PATH || join(__dir, 'db.json');

/** One role's move model: Laplace-smoothed frequency + first-order transitions. */
export interface RoleModelData {
  freq: number[];
  transitions: number[][];
}

/**
 * A player's persisted move model, split by the role the moves were made in.
 * Batting picks and bowling picks are different distributions, so blending
 * them (the old single-model shape) poisoned predictions — keep them apart.
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

/**
 * Backfill any stats fields missing from older db.json records (the leaderboard
 * fields were added later), so every served UserStats is complete. Mutates in
 * place and returns the same object.
 */
function normalizeStats(s: Partial<UserStats> | undefined): UserStats {
  const full = { ...emptyStats(), ...(s ?? {}) };
  return full;
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

/** Full user record as persisted in db.json (never sent to clients verbatim). */
export interface DbUser {
  id: string;
  username: string;
  passwordHash: string;
  token: string | null;
  stats: UserStats;
  achievements?: UserAchievements;
  matchHistory: MatchHistoryEntry[];
  friends?: string[];
  mlModels?: Record<string, MLModelData>;
  createdAt: string;
}

interface Database {
  users: DbUser[];
  mlProfiles?: Record<string, MLModelData>;
  /** Global records bucketed by overs count; see GlobalRecords. */
  records?: GlobalRecords;
}

let cache: Database | null = null;
let mlSaveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Database {
  if (cache) return cache;
  if (!existsSync(DB_PATH)) {
    cache = { users: [] };
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(DB_PATH, 'utf8')) as Database;
    // Backfill fields added in later versions so every record is complete.
    for (const u of cache.users) {
      u.stats = normalizeStats(u.stats);
      u.achievements = normalizeAchievements(u.achievements);
    }
    return cache;
  } catch {
    cache = { users: [] };
    return cache;
  }
}

function save(data: Database): void {
  if (mlSaveTimer) {
    clearTimeout(mlSaveTimer);
    mlSaveTimer = null;
  }
  try {
    writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Filesystem write failed (e.g., read-only FS, file lock); data stays in memory.
  }
}

// Deferred write for the hot per-ball path. Any synchronous save() call
// (auth, stats) will also flush the pending ML data since they share the
// same in-memory object.
function saveSoon(): void {
  if (mlSaveTimer) clearTimeout(mlSaveTimer);
  mlSaveTimer = setTimeout(() => {
    mlSaveTimer = null;
    try {
      if (cache) writeFileSync(DB_PATH, JSON.stringify(cache, null, 2), 'utf8');
    } catch {
      // Filesystem write failed; ML data stays in memory for this session.
    }
  }, 2000);
}

export function findByUsername(username: string): DbUser | null {
  const db = load();
  return db.users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? null;
}

export function findById(id: string): DbUser | null {
  const db = load();
  return db.users.find((u) => u.id === id) ?? null;
}

export function findByToken(token: string): DbUser | null {
  const db = load();
  return db.users.find((u) => u.token === token) ?? null;
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
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  save(db);
  return user;
}

export function saveToken(userId: string, token: string): void {
  const db = load();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return;
  user.token = token;
  save(db);
}

export function addFriend(userId: string, friendId: string): boolean {
  const db = load();
  const user = db.users.find((u) => u.id === userId);
  const friend = db.users.find((u) => u.id === friendId);
  if (!user || !friend) return false;
  if (!user.friends) user.friends = [];
  if (!friend.friends) friend.friends = [];
  if (!user.friends.includes(friendId)) user.friends.push(friendId);
  if (!friend.friends.includes(userId)) friend.friends.push(userId);
  save(db);
  return true;
}

export function removeFriend(userId: string, friendId: string): void {
  const db = load();
  const user = db.users.find((u) => u.id === userId);
  const friend = db.users.find((u) => u.id === friendId);
  if (user) user.friends = (user.friends || []).filter((id) => id !== friendId);
  if (friend) friend.friends = (friend.friends || []).filter((id) => id !== userId);
  save(db);
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
  const db = load();
  const q = query.toLowerCase();
  return db.users
    .filter((u) => u.id !== excludeId && u.username.toLowerCase().includes(q))
    .slice(0, 10)
    .map((u) => ({ id: u.id, username: u.username }));
}

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
}

// Load once, update both players, save once — avoids double-write race on Windows/OneDrive
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
  } of results) {
    if (!userId) continue;
    const user = db.users.find((u) => u.id === userId);
    if (!user) continue;
    user.stats = normalizeStats(user.stats); // safety for partially-migrated records
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
    if (!user.matchHistory) user.matchHistory = [];
    user.matchHistory.push({
      opponent: opponentName || 'Unknown',
      result: tie ? 'tie' : win ? 'win' : 'loss',
      myScore: runsScored,
      oppScore: opponentScore ?? 0,
      overs: overs || 1,
      wickets: wickets || 1,
      date: new Date().toISOString(),
    });
    if (user.matchHistory.length > 10) user.matchHistory = user.matchHistory.slice(-10);
  }
  save(db);
}

export function getMatchHistory(userId: string): MatchHistoryEntry[] {
  const db = load();
  const user = db.users.find((u) => u.id === userId);
  return user?.matchHistory ?? [];
}

/**
 * Every registered player who has played at least one game, with full stats.
 * The client computes the per-category rankings (runs, wickets, ratio, etc.)
 * from a single fetch. Bots are never DB users, so they never appear here.
 */
export function getLeaderboard(): LeaderboardEntry[] {
  const db = load();
  return db.users
    .filter((u) => u.stats.gamesPlayed > 0)
    .map((u) => ({ id: u.id, username: u.username, stats: normalizeStats(u.stats) }));
}

// ─── Achievements (per-user career honours) ──────────────────────────────────

export function getAchievements(userId: string): UserAchievements {
  const db = load();
  const user = db.users.find((u) => u.id === userId);
  return normalizeAchievements(user?.achievements);
}

/**
 * Bump career honours for registered players. Called once when a tournament
 * finalizes; bot/guest entries (no userId) are ignored by the caller. Loads,
 * applies every increment, saves once.
 */
export function incrementAchievements(
  incs: Array<{ userId: string; key: keyof UserAchievements }>
): void {
  if (incs.length === 0) return;
  const db = load();
  for (const { userId, key } of incs) {
    const user = db.users.find((u) => u.id === userId);
    if (!user) continue;
    user.achievements = normalizeAchievements(user.achievements);
    user.achievements[key] += 1;
  }
  save(db);
}

// ─── Global records (tournament matches only, bucketed by overs) ──────────────

export function getGlobalRecords(): GlobalRecords {
  const db = load();
  return db.records ?? { byOvers: {} };
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
 * Fold tournament innings into the global record book. Highest total and the
 * "fastest to" records take any innings; lowest total only counts completed
 * innings (so a curtailed chase can't set a silly low). Saves once.
 */
export function recordInnings(inputs: InningsRecordInput[]): void {
  if (inputs.length === 0) return;
  const db = load();
  if (!db.records) db.records = { byOvers: {} };
  const book = db.records.byOvers;

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

    if (!bucket.highestTotal || inn.total > bucket.highestTotal.value)
      bucket.highestTotal = mk(inn.total);
    if (inn.completed && (!bucket.lowestTotal || inn.total < bucket.lowestTotal.value))
      bucket.lowestTotal = mk(inn.total);
    if (inn.ballsTo50 !== null && (!bucket.fastest50 || inn.ballsTo50 < bucket.fastest50.value))
      bucket.fastest50 = mk(inn.ballsTo50);
    if (inn.ballsTo100 !== null && (!bucket.fastest100 || inn.ballsTo100 < bucket.fastest100.value))
      bucket.fastest100 = mk(inn.ballsTo100);

    book[key] = bucket;
  }
  save(db);
}

// Profiles are keyed by registered user id (stable + unspoofable), not display
// name. Guests (no user id) are neither trained nor served.
export function getPlayerProfile(userId: string): MLModelData | null {
  const db = load();
  const profile = db.mlProfiles?.[userId];
  return (profile as MLModelData) ?? null;
}

export function trainPlayerProfiles(
  updates: Array<{
    userId: string | null;
    role: 'bat' | 'bowl';
    move: number;
    lastMove: number | undefined;
  }>
): void {
  const db = load();
  if (!db.mlProfiles) db.mlProfiles = {};
  for (const { userId, role, move, lastMove } of updates) {
    if (!userId) continue; // guests have no durable identity to train
    let profile = db.mlProfiles[userId] as MLModelData | undefined;
    if (!profile) {
      profile = { bat: emptyRoleModel(), bowl: emptyRoleModel() };
      db.mlProfiles[userId] = profile;
    }
    const model = profile[role];
    // Decay the whole model each observation so the served profile matches the
    // client's online decay rule exactly (recent moves outweigh old).
    for (let i = 1; i <= 6; i++) {
      model.freq[i] *= ML_DECAY;
      for (let j = 1; j <= 6; j++) model.transitions[i][j] *= ML_DECAY;
    }
    model.freq[move] = (model.freq[move] ?? 0) + 1;
    if (lastMove !== undefined) {
      model.transitions[lastMove][move] = (model.transitions[lastMove][move] ?? 0) + 1;
    }
  }
  saveSoon();
}
