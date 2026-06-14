import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { authRouter } from './auth/routes.ts';
import { friendsRouter } from './friends/routes.ts';
import { registerGameHandlers } from './game/handlers.ts';
import type { SocketData } from './game/handlers.ts';
import type { ServerToClientEvents, ClientToServerEvents } from '@cric/types';
import type { DefaultEventsMap } from 'socket.io';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../client/dist')));
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>(
  httpServer,
  { cors: { origin: '*', methods: ['GET', 'POST'] } }
);

app.use(authRouter);
app.use(friendsRouter);
registerGameHandlers(io);

app.get('/{*path}', (_req, res) => {
  res.sendFile(join(__dirname, '../client/dist/index.html'));
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
