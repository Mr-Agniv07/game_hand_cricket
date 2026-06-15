import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { findByToken, saveToken } from '../db.ts';

// Format: "<keyLen>:<salt>:<key>" — keyLen is stored so verification is
// independent of the constant value.
export function hashPassword(password: string): string {
  const saltLen = 16;
  const keyLen = 32;
  const salt = randomBytes(saltLen).toString('hex');
  const key = scryptSync(password, salt, keyLen).toString('hex');
  return `${keyLen}:${salt}:${key}`;
}

export function verifyPassword(password: string, hash: string): boolean {
  try {
    const [keyLenStr, salt, storedKey] = hash.split(':');
    if (!keyLenStr || !salt || !storedKey) return false;
    const keyLen = Number(keyLenStr);
    if (!Number.isInteger(keyLen) || keyLen < 1) return false;
    const key = scryptSync(password, salt, keyLen);
    const stored = Buffer.from(storedKey, 'hex');
    if (stored.length !== key.length) return false;
    return timingSafeEqual(key, stored);
  } catch {
    return false;
  }
}

// cache; db.json is the source of truth
const sessions = new Map<string, string>(); // token -> userId

export function createToken(userId: string): string {
  // Revoke any prior token for this user
  for (const [tok, uid] of sessions) {
    if (uid === userId) sessions.delete(tok);
  }
  const token = randomBytes(32).toString('hex');
  sessions.set(token, userId);
  saveToken(userId, token);
  return token;
}

export function verifyTokenGetUserId(token: string): string | null {
  const cached = sessions.get(token);
  if (cached !== undefined) return cached;

  const user = findByToken(token);
  if (user) {
    sessions.set(token, user.id);
    return user.id;
  }
  return null;
}
