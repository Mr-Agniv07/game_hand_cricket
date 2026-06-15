import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { findByToken, saveToken } from '../db.ts';

const SALT_LEN = 16;
const KEY_LEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN).toString('hex');
  const key = scryptSync(password, salt, KEY_LEN).toString('hex');
  return `${salt}:${key}`;
}

export function verifyPassword(password: string, hash: string): boolean {
  try {
    const [salt, storedKey] = hash.split(':');
    if (!salt || !storedKey) return false;
    const key = scryptSync(password, salt, KEY_LEN);
    const stored = Buffer.from(storedKey, 'hex');
    // timingSafeEqual throws on length mismatch; bail cleanly on a corrupt hash
    // so a bad record yields a 401, not an unhandled 500.
    if (stored.length !== key.length) return false;
    return timingSafeEqual(key, stored);
  } catch {
    return false;
  }
}

// In-memory cache for fast lookup; db.json is the source of truth
const sessions = new Map<string, string>(); // token -> userId

export function createToken(userId: string): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, userId);
  saveToken(userId, token); // persist so it survives server restarts
  return token;
}

export function verifyToken(token: string): string | null {
  const cached = sessions.get(token);
  if (cached !== undefined) return cached;
  // Server was restarted — fall back to db.json
  const user = findByToken(token);
  if (user) {
    sessions.set(token, user.id); // warm the cache
    return user.id;
  }
  return null;
}
