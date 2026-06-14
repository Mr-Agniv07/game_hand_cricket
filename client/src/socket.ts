import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@cric/types';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const socket: AppSocket = io(import.meta.env.VITE_SERVER_URL || '', { autoConnect: false });
