import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { findByToken, saveToken } from './db.js';

const SALT_LEN = 16;
const KEY_LEN = 32;

export function hashPassword(password) {
  const salt = randomBytes(SALT_LEN).toString('hex');
  const key = scryptSync(password, salt, KEY_LEN).toString('hex');
  return `${salt}:${key}`;
}

export function verifyPassword(password, hash) {
  const [salt, storedKey] = hash.split(':');
  const key = scryptSync(password, salt, KEY_LEN);
  const stored = Buffer.from(storedKey, 'hex');
  return timingSafeEqual(key, stored);
}

// In-memory cache for fast lookup; db.json is the source of truth
const sessions = new Map(); // token -> userId

export function createToken(userId) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, userId);
  saveToken(userId, token); // persist so it survives server restarts
  return token;
}

export function verifyToken(token) {
  if (sessions.has(token)) return sessions.get(token);
  // Server was restarted — fall back to db.json
  const user = findByToken(token);
  if (user) {
    sessions.set(token, user.id); // warm the cache
    return user.id;
  }
  return null;
}
