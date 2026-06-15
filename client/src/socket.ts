import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@cric/types';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const CLIENT_ID_KEY = 'cric_client_id';

/**
 * A stable per-browser id used to recover a room after a reconnect — including
 * for guests, who have no account to match on. crypto.randomUUID() is only
 * available in secure contexts (the app also runs over http on LAN IPs), so
 * fall back to a plain random string there.
 */
export function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export const socket: AppSocket = io(import.meta.env.VITE_SERVER_URL || '', { autoConnect: false });
