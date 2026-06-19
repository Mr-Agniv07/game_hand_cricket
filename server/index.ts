import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { authRouter } from './auth/routes.ts';
import { friendsRouter } from './friends/routes.ts';
import { leaderboardRouter } from './leaderboard/routes.ts';
import { recordsRouter } from './records/routes.ts';
import { registerGameHandlers } from './game/handlers.ts';
import { initDb } from './db.ts';
import type { SocketData } from './game/types.ts';
import type { ServerToClientEvents, ClientToServerEvents } from '@cric/types';
import type { DefaultEventsMap } from 'socket.io';

const app = express();
app.use(cors());
app.use(express.json());
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(__dirname, '../client/dist')));
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>(
  httpServer,
  { cors: { origin: '*', methods: ['GET', 'POST'] } }
);

app.use(authRouter);
app.use(friendsRouter);
app.use(leaderboardRouter);
app.use(recordsRouter);
registerGameHandlers(io);

app.get('/{*path}', (_req, res) => {
  res.sendFile(join(__dirname, '../client/dist/index.html'));
});

const PORT = process.env.PORT || 3001;
// Load the database into memory before accepting connections; refuse to start if
// the DB is unreachable (better a clear boot failure than silently empty state).
initDb()
  .then(() => httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch((err) => {
    console.error('[db] failed to initialize — is DATABASE_URL set and reachable?\n', err);
    process.exit(1);
  });
