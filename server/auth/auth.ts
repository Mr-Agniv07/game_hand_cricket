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
    const parts = hash.split(':');
    let salt: string;
    let storedKey: string;
    let keyLen: number;

    if (parts.length === 3) {
      // Current format: "<keyLen>:<salt>:<key>"
      [, salt, storedKey] = parts;
      keyLen = Number(parts[0]);
    } else if (parts.length === 2) {
      // Legacy format: "<salt>:<key>" (no keyLen prefix). Derive the key length
      // from the stored key so accounts created before the format change still
      // verify instead of being locked out.
      [salt, storedKey] = parts;
      keyLen = Buffer.from(storedKey, 'hex').length;
    } else {
      return false;
    }

    if (!salt || !storedKey || !Number.isInteger(keyLen) || keyLen < 1) return false;
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
