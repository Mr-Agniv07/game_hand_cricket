import { randomUUID } from 'crypto';
import type { Server, Socket, DefaultEventsMap } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, Mode, InningsEndReason, RoomCreatedPayload } from '@cric/types';
import { findById, updateGameStats } from '../db.ts';
import { verifyToken } from '../auth/auth.ts';
import { type Room, makeRoomId, freshInnings, createRoom, totalBalls, batsmanId, bowlerId, publicState } from './room.ts';

export interface SocketData {
  userId: string | null;
  roomId?: string;
  playerName?: string;
}

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

interface PendingChallenge {
  challengerId: string;
  challengerSocketId: string;
  toUserId: string;
  overs: number;
  mode: Mode;
  wickets: number;
  timeout: NodeJS.Timeout;
}

export const onlineUsers = new Map<string, string>();      // userId → socketId
const pendingChallenges = new Map<string, PendingChallenge>();
const rooms = new Map<string, Room>();

export function registerGameHandlers(io: GameServer): void {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    socket.data.userId = token ? (verifyToken(token) ?? null) : null;
    next();
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
      const result = (Math.random() < 0.5 ? 'heads' : 'tails') as 'heads' | 'tails';
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

      if (room.pendingMoves[socket.id] !== undefined) return;

      room.pendingMoves[socket.id] = number;
      socket.emit('move_received', { number });

      const batMove = room.pendingMoves[batsmanId(room)];
      const bowlMove = room.pendingMoves[bowlerId(room)];
      if (batMove === undefined || bowlMove === undefined) return;

      room.pendingMoves = {};

      const inn = room.innings[room.currentInnings];
      inn.balls += 1;

      if (batMove === bowlMove) {
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
          endInnings(io, roomId, room, room.mode === 'wickets' ? 'all_out' : 'out');
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

        if (room.currentInnings === 1) {
          const target = room.innings[0].score + 1;
          if (inn.score >= target) {
            endInnings(io, roomId, room, 'target_reached');
            return;
          }
        }

        if (room.mode === 'overs' && inn.balls >= totalBalls(room)) {
          endInnings(io, roomId, room, 'overs_complete');
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

      const roomId = makeRoomId();
      const room = createRoom(ch.overs, ch.mode, ch.wickets);
      const challenger = findById(ch.challengerId);
      const challenged = socket.data.userId ? findById(socket.data.userId) : null;

      room.players.push({ id: ch.challengerSocketId, name: challenger?.username || 'Player 1', userId: ch.challengerId });
      room.players.push({ id: socket.id, name: challenged?.username || 'Player 2', userId: socket.data.userId });
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
      socket.to(roomId).emit('rematch_requested', { from: room.players[playerIdx].name });
      if (room.rematchRequests.size >= 2) startRematch(io, roomId, room);
    });

    socket.on('disconnect', () => {
      if (socket.data.userId) onlineUsers.delete(socket.data.userId);
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

      // Grace period: brief disconnect (HMR, StrictMode remount, network blip)
      // should not destroy the game.
      const GRACE_MS = 8000;
      room._graceTimers = room._graceTimers || {};
      room._graceTimers[socket.id] = setTimeout(() => {
        if (!rooms.has(roomId)) return;
        io.to(roomId).emit('opponent_disconnected', { name: socket.data.playerName });
        rooms.delete(roomId);
      }, GRACE_MS);
    });
  });
}

function endInnings(io: GameServer, roomId: string, room: Room, reason: InningsEndReason): void {
  const inn = room.innings[room.currentInnings];
  io.to(roomId).emit('innings_end', {
    inningsNumber: room.currentInnings + 1,
    score: inn.score,
    reason,
  });

  if (room.currentInnings === 0) {
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
      if (inn2.score >= inn1.score + 1) {
        winnerId = room.players[room.batsmanIdx!].id;
        winnerName = room.players[room.batsmanIdx!].name;
        resultText = `${winnerName} won!`;
      } else if (inn2.score === inn1.score) {
        resultText = 'Match tied!';
        winnerId = null;
        winnerName = null;
      } else {
        // First innings team wins; roles were swapped, so bowlerIdx batted 1st
        const firstBatsmanIdx = room.bowlerIdx!;
        winnerId = room.players[firstBatsmanIdx].id;
        winnerName = room.players[firstBatsmanIdx].name;
        const margin = inn1.score - inn2.score;
        resultText = `${winnerName} won by ${margin} run${margin !== 1 ? 's' : ''}!`;
      }
    }

    // Align scores to player array order, not innings order (roles swapped at innings break)
    const playerScores: [number, number] = [0, 0];
    playerScores[room.bowlerIdx!] = inn1.score;
    playerScores[room.batsmanIdx!] = inn2.score;

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

function startRematch(io: GameServer, roomId: string, room: Room): void {
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
