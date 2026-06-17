// Terminal stand-in for the web client's localStorage (client/src/App.tsx,
// client/src/socket.ts): a single JSON file holding the logged-in user, the
// stable guest clientId, and the active room for reconnect-on-restart.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DIR = join(homedir(), '.cric-cli');
const FILE = join(DIR, 'session.json');

export interface StoredUser {
  id: string;
  username: string;
  token: string;
}

export interface StoredActiveRoom {
  roomId: string;
  myPlayerIdx: number | null;
  isTournamentMatch: boolean;
}

interface SessionFile {
  user: StoredUser | null;
  clientId: string;
  activeRoom: StoredActiveRoom | null;
}

function load(): SessionFile {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<SessionFile>;
    return {
      user: parsed.user ?? null,
      clientId: parsed.clientId ?? randomUUID(),
      activeRoom: parsed.activeRoom ?? null,
    };
  } catch {
    return { user: null, clientId: randomUUID(), activeRoom: null };
  }
}

const session = load();

function persist(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(session, null, 2));
}

if (!existsSync(FILE)) persist();

export function getClientId(): string {
  return session.clientId;
}

export function getStoredUser(): StoredUser | null {
  return session.user;
}

export function saveUser(user: StoredUser): void {
  session.user = user;
  persist();
}

export function clearUser(): void {
  session.user = null;
  persist();
}

export function getActiveRoom(): StoredActiveRoom | null {
  return session.activeRoom;
}

export function saveActiveRoom(room: StoredActiveRoom): void {
  session.activeRoom = room;
  persist();
}

export function clearActiveRoom(): void {
  session.activeRoom = null;
  persist();
}
