// Mirrors client/src/socket.ts — same auth shape ({ token?, clientId }), same
// autoConnect: false (the caller decides when to connect after restoring session).
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@cric/types';
import { SERVER_URL } from './api.ts';
import { getClientId } from './storage.ts';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const socket: AppSocket = io(SERVER_URL, { autoConnect: false });

export function setSocketAuth(token?: string | null): void {
  socket.auth = token ? { token, clientId: getClientId() } : { clientId: getClientId() };
}
