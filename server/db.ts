import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type { UserStats, MatchHistoryEntry, Mode, PublicUser, Friend } from '@cric/types';

const __dir = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dir, 'db.json');

export interface MLModelData {
  freq: number[];
  transitions: number[][];
}

/** Full user record as persisted in db.json (never sent to clients verbatim). */
export interface DbUser {
  id: string;
  username: string;
  passwordHash: string;
  token: string | null;
  stats: UserStats;
  matchHistory: MatchHistoryEntry[];
  friends?: string[];
  mlModels?: Record<string, MLModelData>;
  createdAt: string;
}

interface Database {
  users: DbUser[];
  mlProfiles?: Record<string, MLModelData>;
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
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// Deferred write for the hot per-ball path. Any synchronous save() call
// (auth, stats) will also flush the pending ML data since they share the
// same in-memory object.
function saveSoon(): void {
  if (mlSaveTimer) clearTimeout(mlSaveTimer);
  mlSaveTimer = setTimeout(() => {
    mlSaveTimer = null;
    if (cache) writeFileSync(DB_PATH, JSON.stringify(cache, null, 2), 'utf8');
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
    stats: { gamesPlayed: 0, wins: 0, losses: 0, ties: 0, runsScored: 0, highScore: 0 },
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
  mode: Mode;
  count: number;
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
    mode,
    count,
  } of results) {
    if (!userId) continue;
    const user = db.users.find((u) => u.id === userId);
    if (!user) continue;
    user.stats.gamesPlayed += 1;
    if (tie) user.stats.ties += 1;
    else if (win) user.stats.wins += 1;
    else user.stats.losses += 1;
    user.stats.runsScored += runsScored;
    if (runsScored > user.stats.highScore) user.stats.highScore = runsScored;
    if (!user.matchHistory) user.matchHistory = [];
    user.matchHistory.push({
      opponent: opponentName || 'Unknown',
      result: tie ? 'tie' : win ? 'win' : 'loss',
      myScore: runsScored,
      oppScore: opponentScore ?? 0,
      mode: mode || 'overs',
      count: count || 1,
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

// Profiles are keyed by registered user id (stable + unspoofable), not display
// name. Guests (no user id) are neither trained nor served.
export function getPlayerProfile(userId: string): MLModelData | null {
  const db = load();
  return db.mlProfiles?.[userId] ?? null;
}

export function trainPlayerProfiles(
  updates: Array<{ userId: string | null; move: number; lastMove: number | undefined }>
): void {
  const db = load();
  if (!db.mlProfiles) db.mlProfiles = {};
  for (const { userId, move, lastMove } of updates) {
    if (!userId) continue; // guests have no durable identity to train
    const key = userId;
    if (!db.mlProfiles[key]) {
      db.mlProfiles[key] = {
        freq: [0, 1, 1, 1, 1, 1, 1],
        transitions: Array.from({ length: 7 }, () => [0, 1, 1, 1, 1, 1, 1]),
      };
    }
    const model = db.mlProfiles[key];
    for (let i = 1; i <= 6; i++) model.freq[i] *= 0.95;
    model.freq[move] = (model.freq[move] ?? 0) + 1;
    if (lastMove !== undefined) {
      for (let i = 1; i <= 6; i++) model.transitions[lastMove][i] *= 0.95;
      model.transitions[lastMove][move] = (model.transitions[lastMove][move] ?? 0) + 1;
    }
  }
  saveSoon();
}
