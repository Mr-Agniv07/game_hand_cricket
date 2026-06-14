import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { authRouter } from './auth/routes.ts';
import { friendsRouter } from './friends/routes.ts';
import { registerGameHandlers } from './game/handlers.ts';
import type { SocketData } from './game/handlers.ts';
import type { ServerToClientEvents, ClientToServerEvents } from '@cric/types';
import type { DefaultEventsMap } from 'socket.io';

const app = express();
app.use(cors());
app.use(express.json());
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>(
  httpServer,
  { cors: { origin: '*', methods: ['GET', 'POST'] } },
);

app.use(authRouter);
app.use(friendsRouter);
registerGameHandlers(io);

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
