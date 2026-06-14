import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { randomUUID } from 'crypto';
import {
  findByUsername, findById, createUser, updateGameStats, getMatchHistory,
  addFriend, removeFriend, getFriends, searchUsers,
} from './db.ts';
import { hashPassword, verifyPassword, createToken, verifyToken } from './auth.ts';
import type { Request, Response, NextFunction } from 'express';
import type { Socket, DefaultEventsMap } from 'socket.io';
import type {
  ServerToClientEvents, ClientToServerEvents, GameState, Mode, Phase,
  TossCall, InningsEndReason, RoomCreatedPayload,
} from '@cric/types';

const app = express();
app.use(cors());
app.use(express.json());
const httpServer = createServer(app);

// Data attached to each socket beyond socket.id.
interface SocketData {
  userId: string | null;
  roomId?: string;
  playerName?: string;
}

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

const io = new Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>(
  httpServer,
  { cors: { origin: '*', methods: ['GET', 'POST'] } },
);

// Express Request augmented by requireAuth.
interface AuthRequest extends Request {
  userId?: string;
}

// ─── Auth HTTP routes ─────────────────────────────────────────────────────────

app.post('/api/signup', (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'Username must be 2–20 characters.' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  const user = createUser(username.trim(), hashPassword(password));
  if (!user) return res.status(409).json({ error: 'Username already taken.' });
  const token = createToken(user.id);
  res.json({ id: user.id, username: user.username, token, stats: user.stats });
});

app.post('/api/login', (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const user = findByUsername(username.trim());
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
  if (!verifyPassword(password, user.passwordHash)) return res.status(401).json({ error: 'Invalid username or password.' });
  const token = createToken(user.id);
  res.json({ id: user.id, username: user.username, token, stats: user.stats });
});

app.get('/api/me', (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token.' });
  const userId = verifyToken(token);
  if (!userId) return res.status(401).json({ error: 'Invalid or expired token.' });
  const user = findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ id: user.id, username: user.username, stats: user.stats });
});

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const userId = verifyToken(token);
  if (!userId) return res.status(401).json({ error: 'Invalid token' });
  (req as AuthRequest).userId = userId;
  next();
}

// ─── Friends HTTP routes ──────────────────────────────────────────────────────

app.get('/api/friends', requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthRequest).userId!;
  const friends = getFriends(userId);
  res.json(friends.map(f => ({ ...f, online: onlineUsers.has(f.id) })));
});

app.get('/api/users/search', requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthRequest).userId!;
  const q = (typeof req.query.q === 'string' ? req.query.q : '').trim();
  if (q.length < 2) return res.json([]);
  const results = searchUsers(q, userId);
  const myFriendIds = new Set(getFriends(userId).map(f => f.id));
  res.json(results.map(u => ({ ...u, isFriend: myFriendIds.has(u.id), online: onlineUsers.has(u.id) })));
});

app.post('/api/friends/add', requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthRequest).userId!;
  const { friendId } = req.body || {};
  if (!friendId) return res.status(400).json({ error: 'friendId required' });
  if (friendId === userId) return res.status(400).json({ error: 'Cannot add yourself' });
  const ok = addFriend(userId, friendId);
  if (!ok) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

app.delete('/api/friends/:friendId', requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthRequest).userId!;
  removeFriend(userId, req.params.friendId as string);
  res.json({ ok: true });
});

app.get('/api/history', requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthRequest).userId!;
  const history = getMatchHistory(userId);
  res.json([...history].reverse()); // newest first
});

// ─── Runtime state ────────────────────────────────────────────────────────────

const onlineUsers = new Map<string, string>();      // userId → socketId

interface PendingChallenge {
  challengerId: string;
  challengerSocketId: string;
  toUserId: string;
  overs: number;
  mode: Mode;
  wickets: number;
  timeout: NodeJS.Timeout;
}
const pendingChallenges = new Map<string, PendingChallenge>(); // challengeId → challenge object

// ─── roomId -> gameState ──────────────────────────────────────────────────────

interface RoomPlayer {
  id: string;
  name: string;
  userId: string | null;
}

interface RoomInnings {
  score: number;
  balls: number;
  isOut: boolean;
  wicketsLost: number;
  moves: number[];
}

interface Room {
  players: RoomPlayer[];
  overs: number;
  mode: Mode;
  wickets: number;
  phase: Phase;
  tossCallerId: string | null;
  tossCall: TossCall | null;
  tossWinnerId: string | null;
  batsmanIdx: number | null;
  bowlerIdx: number | null;
  innings: [RoomInnings, RoomInnings];
  currentInnings: number;
  pendingMoves: Record<string, number>;
  rematchRequests?: Set<number> | null;
  _graceTimers?: Record<string, NodeJS.Timeout>;
}

const rooms = new Map<string, Room>();

function makeRoomId(): string {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function freshInnings(): RoomInnings {
  return { score: 0, balls: 0, isOut: false, wicketsLost: 0, moves: [] };
}

function createRoom(overs: number, mode: Mode, wickets: number): Room {
  return {
    players: [],
    overs,
    mode: mode || 'overs',
    wickets: wickets || 1,
    phase: 'waiting',
    tossCallerId: null,
    tossCall: null,
    tossWinnerId: null,
    batsmanIdx: null,
    bowlerIdx: null,
    innings: [freshInnings(), freshInnings()],
    currentInnings: 0,
    pendingMoves: {},
  };
}

function totalBalls(room: Room): number {
  return room.overs * 6;
}

function batsmanId(room: Room): string {
  return room.players[room.batsmanIdx!].id;
}

function bowlerId(room: Room): string {
  return room.players[room.bowlerIdx!].id;
}

function publicState(room: Room, roomId: string): GameState {
  const inn = room.innings[room.currentInnings];
  const target = room.currentInnings === 1 ? room.innings[0].score + 1 : null;
  return {
    roomId,
    phase: room.phase,
    players: room.players.map(p => p.name),
    overs: room.overs,
    mode: room.mode,
    wickets: room.wickets,
    currentInnings: room.currentInnings,
    score: inn.score,
    balls: inn.balls,
    wicketsLost: inn.wicketsLost,
    target,
    batsmanIdx: room.batsmanIdx,
    bowlerIdx: room.bowlerIdx,
    tossCallerId: room.tossCallerId,
    tossWinnerId: room.tossWinnerId,
    innings: room.innings.map(i => ({ score: i.score, balls: i.balls, isOut: i.isOut, wicketsLost: i.wicketsLost })),
  };
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  socket.data.userId = token ? (verifyToken(token) ?? null) : null;
  next(); // guests (no token) are allowed; stats just won't be tracked
});

io.on('connection', (socket: GameSocket) => {
  console.log('connected', socket.id);
  if (socket.data.userId) onlineUsers.set(socket.data.userId, socket.id);

  socket.on('create_room', ({ playerName, overs, mode, wickets }) => {
    const roomId = makeRoomId();
    const room = createRoom(Number(overs) || 1, mode || 'overs', Number(wickets) || 1);
    room.players.push({ id: socket.id, name: playerName, userId: socket.data.userId });
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;
    socket.emit('room_created', { roomId } satisfies RoomCreatedPayload);
    socket.emit('state', publicState(room, roomId));
  });

  socket.on('join_room', ({ roomId, playerName }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', { message: 'Room not found.' });
    if (room.players.length >= 2) return socket.emit('error', { message: 'Room is full.' });
    if (room.phase !== 'waiting') return socket.emit('error', { message: 'Game already started.' });

    room.players.push({ id: socket.id, name: playerName, userId: socket.data.userId });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;

    // Both players joined — start toss
    const callerIdx = Math.floor(Math.random() * 2);
    room.tossCallerId = room.players[callerIdx].id;
    room.phase = 'toss_call';

    io.to(roomId).emit('state', publicState(room, roomId));
    io.to(roomId).emit('toss_start', {
      callerId: room.tossCallerId,
      callerName: room.players[callerIdx].name,
    });
  });

  socket.on('toss_call', ({ call }) => {
    const roomId = socket.data.roomId;
    const room = roomId ? rooms.get(roomId) : undefined;
    if (!room || !roomId || room.phase !== 'toss_call') return;
    if (socket.id !== room.tossCallerId) return;

    room.tossCall = call;
    const result: TossCall = Math.random() < 0.5 ? 'heads' : 'tails';
    const won = result === call;
    room.tossWinnerId = won ? socket.id : room.players.find(p => p.id !== socket.id)!.id;
    room.phase = 'bat_bowl';

    io.to(roomId).emit('toss_result', {
      call,
      result,
      winnerId: room.tossWinnerId,
      winnerName: room.players.find(p => p.id === room.tossWinnerId)!.name,
    });
    io.to(roomId).emit('state', publicState(room, roomId));
  });

  socket.on('bat_bowl_choice', ({ choice }) => {
    const roomId = socket.data.roomId;
    const room = roomId ? rooms.get(roomId) : undefined;
    if (!room || !roomId || room.phase !== 'bat_bowl') return;
    if (socket.id !== room.tossWinnerId) return;

    const winnerIdx = room.players.findIndex(p => p.id === room.tossWinnerId);
    const otherIdx = winnerIdx === 0 ? 1 : 0;

    if (choice === 'bat') {
      room.batsmanIdx = winnerIdx;
      room.bowlerIdx = otherIdx;
    } else {
      room.bowlerIdx = winnerIdx;
      room.batsmanIdx = otherIdx;
    }

    room.phase = 'innings';
    io.to(roomId).emit('innings_start', {
      inningsNumber: 1,
      batsmanName: room.players[room.batsmanIdx].name,
      bowlerName: room.players[room.bowlerIdx].name,
      target: null,
    });
    io.to(roomId).emit('state', publicState(room, roomId));
  });

  socket.on('play_move', ({ number }) => {
    const roomId = socket.data.roomId;
    const room = roomId ? rooms.get(roomId) : undefined;
    if (!room || !roomId || room.phase !== 'innings') return;

    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx === -1) return;

    const isBatsman = playerIdx === room.batsmanIdx;
    const isBowler = playerIdx === room.bowlerIdx;
    if (!isBatsman && !isBowler) return;

    // Prevent double submission
    if (room.pendingMoves[socket.id] !== undefined) return;

    room.pendingMoves[socket.id] = number;
    socket.emit('move_received', { number });

    // Both submitted?
    const batMove = room.pendingMoves[batsmanId(room)];
    const bowlMove = room.pendingMoves[bowlerId(room)];
    if (batMove === undefined || bowlMove === undefined) return;

    // Reset pending
    room.pendingMoves = {};

    const inn = room.innings[room.currentInnings];
    inn.balls += 1;

    if (batMove === bowlMove) {
      // Wicket
      inn.wicketsLost += 1;
      const inningsOver = room.mode !== 'wickets' || inn.wicketsLost >= room.wickets;

      io.to(roomId).emit('ball_played', {
        batsmanMove: batMove,
        bowlerMove: bowlMove,
        scored: 0,
        isOut: true,
        wicketsLost: inn.wicketsLost,
        score: inn.score,
        balls: inn.balls,
      });

      if (inningsOver) {
        inn.isOut = true;
        endInnings(roomId, room, room.mode === 'wickets' ? 'all_out' : 'out');
      } else {
        io.to(roomId).emit('state', publicState(room, roomId));
      }
    } else {
      inn.score += batMove;
      io.to(roomId).emit('ball_played', {
        batsmanMove: batMove,
        bowlerMove: bowlMove,
        scored: batMove,
        isOut: false,
        score: inn.score,
        balls: inn.balls,
      });
      io.to(roomId).emit('state', publicState(room, roomId));

      // Check if target chased in 2nd innings
      if (room.currentInnings === 1) {
        const target = room.innings[0].score + 1;
        if (inn.score >= target) {
          endInnings(roomId, room, 'target_reached');
          return;
        }
      }

      // Overs limit only applies in overs mode
      if (room.mode === 'overs' && inn.balls >= totalBalls(room)) {
        endInnings(roomId, room, 'overs_complete');
      }
    }
  });

  socket.on('send_challenge', ({ toUserId, overs, mode, wickets }) => {
    if (!socket.data.userId) return;
    const toSocketId = onlineUsers.get(toUserId);
    if (!toSocketId) return socket.emit('challenge_error', { message: 'Player is offline' });

    const challenger = findById(socket.data.userId);
    if (!challenger) return;

    const challengeId = randomUUID();
    const timeout = setTimeout(() => {
      if (!pendingChallenges.has(challengeId)) return;
      pendingChallenges.delete(challengeId);
      socket.emit('challenge_expired', {});
      io.to(toSocketId).emit('challenge_expired', { challengeId });
    }, 30000);

    pendingChallenges.set(challengeId, {
      challengerId: socket.data.userId,
      challengerSocketId: socket.id,
      toUserId,
      overs: Number(overs) || 2,
      mode: mode || 'overs',
      wickets: Number(wickets) || 2,
      timeout,
    });

    io.to(toSocketId).emit('challenge_received', {
      challengeId,
      from: { id: socket.data.userId, username: challenger.username },
      overs: Number(overs) || 2,
      mode: mode || 'overs',
      wickets: Number(wickets) || 2,
    });
  });

  socket.on('respond_challenge', ({ challengeId, accept }) => {
    const ch = pendingChallenges.get(challengeId);
    if (!ch) return;
    clearTimeout(ch.timeout);
    pendingChallenges.delete(challengeId);

    const challengerSocket = io.sockets.sockets.get(ch.challengerSocketId);

    if (!accept) {
      const decliner = socket.data.userId ? findById(socket.data.userId) : null;
      challengerSocket?.emit('challenge_declined', { username: decliner?.username || 'Opponent' });
      return;
    }

    // Build and start the room for both players
    const roomId = makeRoomId();
    const room = createRoom(ch.overs, ch.mode, ch.wickets);
    const challenger = findById(ch.challengerId);
    const challenged = socket.data.userId ? findById(socket.data.userId) : null;

    room.players.push({ id: ch.challengerSocketId, name: challenger?.username || 'Player 1', userId: ch.challengerId });
    room.players.push({ id: socket.id,             name: challenged?.username || 'Player 2', userId: socket.data.userId });
    rooms.set(roomId, room);

    if (challengerSocket) {
      challengerSocket.join(roomId);
      challengerSocket.data.roomId = roomId;
      challengerSocket.data.playerName = challenger?.username;
    }
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = challenged?.username;

    challengerSocket?.emit('challenge_room_start', { roomId, myPlayerIdx: 0 });
    socket.emit('challenge_room_start', { roomId, myPlayerIdx: 1 });

    const callerIdx = Math.floor(Math.random() * 2);
    room.tossCallerId = room.players[callerIdx].id;
    room.phase = 'toss_call';

    io.to(roomId).emit('state', publicState(room, roomId));
    io.to(roomId).emit('toss_start', {
      callerId: room.tossCallerId,
      callerName: room.players[callerIdx].name,
    });
  });

  socket.on('request_rematch', () => {
    const roomId = socket.data.roomId;
    const room = roomId ? rooms.get(roomId) : undefined;
    if (!room || !roomId || room.phase !== 'result') return;
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx === -1) return;
    if (!room.rematchRequests) room.rematchRequests = new Set<number>();
    room.rematchRequests.add(playerIdx);
    // Notify the other player that this one wants rematch
    socket.to(roomId).emit('rematch_requested', { from: room.players[playerIdx].name });
    if (room.rematchRequests.size >= 2) startRematch(roomId, room);
  });

  socket.on('disconnect', () => {
    if (socket.data.userId) onlineUsers.delete(socket.data.userId);
    // Cancel any challenge this socket sent
    for (const [id, ch] of pendingChallenges) {
      if (ch.challengerSocketId === socket.id) {
        clearTimeout(ch.timeout);
        pendingChallenges.delete(id);
      }
    }

    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    // Grace period: a quick disconnect/reconnect (dev HMR, React StrictMode
    // remount, a brief network blip) should NOT instantly destroy the game.
    // Only tear the room down if the player is still gone after the window.
    const GRACE_MS = 8000;
    room._graceTimers = room._graceTimers || {};
    room._graceTimers[socket.id] = setTimeout(() => {
      // Still gone? End the game for the remaining player.
      if (!rooms.has(roomId)) return;
      io.to(roomId).emit('opponent_disconnected', {
        name: socket.data.playerName,
      });
      rooms.delete(roomId);
    }, GRACE_MS);
  });
});

function endInnings(roomId: string, room: Room, reason: InningsEndReason): void {
  const inn = room.innings[room.currentInnings];
  io.to(roomId).emit('innings_end', {
    inningsNumber: room.currentInnings + 1,
    score: inn.score,
    reason,
  });

  if (room.currentInnings === 0) {
    // Start 2nd innings — swap roles
    room.currentInnings = 1;
    const tmp = room.batsmanIdx;
    room.batsmanIdx = room.bowlerIdx;
    room.bowlerIdx = tmp;
    room.pendingMoves = {};

    const target = room.innings[0].score + 1;
    io.to(roomId).emit('innings_start', {
      inningsNumber: 2,
      batsmanName: room.players[room.batsmanIdx!].name,
      bowlerName: room.players[room.bowlerIdx!].name,
      target,
    });
    io.to(roomId).emit('state', publicState(room, roomId));
  } else {
    // Game over
    const inn1 = room.innings[0];
    const inn2 = room.innings[1];
    let winnerId: string | null;
    let winnerName: string | null;
    let resultText: string;

    if (reason === 'target_reached') {
      winnerId = room.players[room.batsmanIdx!].id;
      winnerName = room.players[room.batsmanIdx!].name;
      resultText = `${winnerName} won by chasing the target!`;
    } else {
      // 2nd innings ended via out or overs — check scores
      if (inn2.score >= inn1.score + 1) {
        winnerId = room.players[room.batsmanIdx!].id;
        winnerName = room.players[room.batsmanIdx!].name;
        resultText = `${winnerName} won!`;
      } else if (inn2.score === inn1.score) {
        resultText = 'Match tied!';
        winnerId = null;
        winnerName = null;
      } else {
        // First innings team wins
        const firstBatsmanIdx = room.bowlerIdx!; // they were batting in 1st innings (roles swapped)
        winnerId = room.players[firstBatsmanIdx].id;
        winnerName = room.players[firstBatsmanIdx].name;
        const margin = inn1.score - inn2.score;
        resultText = `${winnerName} won by ${margin} run${margin !== 1 ? 's' : ''}!`;
      }
    }

    // Align scores to the players array (player order), not innings order.
    // At game over, roles are swapped: bowlerIdx batted innings 1, batsmanIdx
    // batted innings 2.
    const playerScores: [number, number] = [0, 0];
    playerScores[room.bowlerIdx!] = inn1.score;
    playerScores[room.batsmanIdx!] = inn2.score;

    // Persist stats for both players in a single DB read/write
    const matchCount = room.mode === 'overs' ? room.overs : room.wickets;
    updateGameStats([
      { userId: room.players[0].userId, win: winnerId === room.players[0].id, tie: winnerId === null, runsScored: playerScores[0], opponentName: room.players[1].name, opponentScore: playerScores[1], mode: room.mode, count: matchCount },
      { userId: room.players[1].userId, win: winnerId === room.players[1].id, tie: winnerId === null, runsScored: playerScores[1], opponentName: room.players[0].name, opponentScore: playerScores[0], mode: room.mode, count: matchCount },
    ]);

    room.phase = 'result';
    io.to(roomId).emit('game_over', {
      winnerId,
      winnerName,
      resultText,
      scores: playerScores,
      players: room.players.map(p => p.name),
    });
    io.to(roomId).emit('state', publicState(room, roomId));
  }
}

function startRematch(roomId: string, room: Room): void {
  room.innings = [freshInnings(), freshInnings()];
  room.currentInnings = 0;
  room.pendingMoves = {};
  room.tossCallerId = null;
  room.tossCall = null;
  room.tossWinnerId = null;
  room.batsmanIdx = null;
  room.bowlerIdx = null;
  room.rematchRequests = null;

  room.players.forEach((p, idx) => {
    io.to(p.id).emit('rematch_start', { roomId, myPlayerIdx: idx });
  });

  const callerIdx = Math.floor(Math.random() * 2);
  room.tossCallerId = room.players[callerIdx].id;
  room.phase = 'toss_call';
  io.to(roomId).emit('state', publicState(room, roomId));
  io.to(roomId).emit('toss_start', {
    callerId: room.tossCallerId,
    callerName: room.players[callerIdx].name,
  });
}

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
