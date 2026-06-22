import { randomUUID } from 'crypto';
import type { Server, Socket, DefaultEventsMap } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, RoomCreatedPayload } from '@cric/types';
import { findById } from '../db.ts';
import { verifyTokenGetUserId } from '../auth/auth.ts';
import {
  type Room,
  makeRoomId,
  cleanName,
  clampCount,
  createRoom,
  batsmanId,
  bowlerId,
  publicState,
  remapSocketId,
} from './room.ts';
import type { SocketData } from './types.ts';
import {
  tournaments,
  publicTournamentState,
  forfeitTournamentMatch,
  remapTournamentSocketId,
  registerTournamentHandlers,
} from '../tournament/handlers.ts';
import {
  resolveBall,
  forfeitGame,
  startRematch,
  applyTossCall,
  applyBatBowlChoice,
  driveBots,
} from './logic.ts';
import { makeBotPlayer, isBot } from './bot.ts';

export type { SocketData };

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

interface PendingChallenge {
  challengerId: string;
  challengerSocketId: string;
  toUserId: string;
  overs: number;
  wickets: number;
  timeout: NodeJS.Timeout;
}

export const onlineUsers = new Map<string, string>(); // userId → socketId
const pendingChallenges = new Map<string, PendingChallenge>();
const rooms = new Map<string, Room>();

// ─── Quick Match (random pairing) ─────────────────────────────────────────────

interface QueueEntry {
  socketId: string;
  name: string;
  userId: string | null;
  clientId: string | null;
}
// Players waiting for a random opponent, keyed by mode (`overs|wickets`).
const matchQueue = new Map<string, QueueEntry[]>();

/** Drop a socket from whatever Quick Match queue it's sitting in (idempotent). */
function removeFromQueue(socketId: string): void {
  for (const [key, q] of matchQueue) {
    const i = q.findIndex((e) => e.socketId === socketId);
    if (i !== -1) q.splice(i, 1);
    if (q.length === 0) matchQueue.delete(key);
  }
}

// The taunt emojis players can send in a match (server validates against this).
const ALLOWED_EMOTES = new Set(['😎', '🔥', '😂', '🧊', '👏', '😱', '🤡', '💪']);
const EMOTE_COOLDOWN_MS = 800;

export function registerGameHandlers(io: GameServer): void {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    socket.data.userId = token ? (verifyTokenGetUserId(token) ?? null) : null;
    const clientId = socket.handshake.auth?.clientId;
    socket.data.clientId = typeof clientId === 'string' ? clientId : null;
    next();
  });

  io.on('connection', (socket: GameSocket) => {
    console.log('connected', socket.id);
    if (socket.data.userId) onlineUsers.set(socket.data.userId, socket.id);

    socket.on('create_room', ({ playerName, overs, wickets }) => {
      removeFromQueue(socket.id);
      const name = cleanName(playerName);
      const roomId = makeRoomId(rooms);
      const room = createRoom(clampCount(overs, 1), clampCount(wickets, 1));
      room.players.push({ id: socket.id, name, userId: socket.data.userId, clientId: socket.data.clientId });
      rooms.set(roomId, room);
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerName = name;
      socket.emit('room_created', { roomId } satisfies RoomCreatedPayload);
      socket.emit('state', publicState(room, roomId));
    });

    socket.on('play_vs_bot', ({ playerName, overs, wickets }) => {
      removeFromQueue(socket.id);
      const name = cleanName(playerName);
      const roomId = makeRoomId(rooms);
      const room = createRoom(clampCount(overs, 1), clampCount(wickets, 1));
      room.hasBot = true;
      room.players.push({ id: socket.id, name, userId: socket.data.userId, clientId: socket.data.clientId });
      room.players.push(makeBotPlayer([name]));
      rooms.set(roomId, room);
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerName = name;

      // The human is player 0; room_created sets that on the client. Then jump
      // straight into the toss (no "waiting for opponent" — the bot is here).
      socket.emit('room_created', { roomId } satisfies RoomCreatedPayload);

      const callerIdx = Math.floor(Math.random() * 2);
      room.tossCallerId = room.players[callerIdx].id;
      room.phase = 'toss_call';
      io.to(roomId).emit('state', publicState(room, roomId));
      io.to(roomId).emit('toss_start', { callerId: room.tossCallerId, callerName: room.players[callerIdx].name });
      driveBots(io, roomId, room, rooms);
    });

    // Quick Match: pick a mode and get paired with whoever's waiting in it.
    socket.on('find_match', ({ playerName, overs, wickets }) => {
      if (socket.data.roomId && rooms.has(socket.data.roomId)) return; // already in a game
      const name = cleanName(playerName);
      const ov = clampCount(overs, 2);
      const wk = clampCount(wickets, 2);
      const key = `${ov}|${wk}`;

      removeFromQueue(socket.id); // dedupe double-clicks / mode switches

      // Find a still-valid opponent already waiting in this exact mode.
      const q = matchQueue.get(key) ?? [];
      let opp: { entry: QueueEntry; sock: GameSocket } | null = null;
      while (q.length) {
        const cand = q.shift()!;
        if (cand.socketId === socket.id) continue;
        const cs = io.sockets.sockets.get(cand.socketId) as GameSocket | undefined;
        if (!cs || cs.data.roomId) continue; // gone, or already pulled into a game
        if (cand.userId && cand.userId === socket.data.userId) continue; // same account, two tabs
        opp = { entry: cand, sock: cs };
        break;
      }
      if (q.length === 0) matchQueue.delete(key);
      else matchQueue.set(key, q);

      if (!opp) {
        // No one waiting — join the queue and sit tight.
        const list = matchQueue.get(key) ?? [];
        list.push({ socketId: socket.id, name, userId: socket.data.userId, clientId: socket.data.clientId });
        matchQueue.set(key, list);
        socket.data.matchKey = key;
        socket.emit('match_waiting', { overs: ov, wickets: wk });
        return;
      }

      // Pair them up and start the toss (mirrors challenge accept).
      socket.data.matchKey = undefined;
      opp.sock.data.matchKey = undefined;
      const roomId = makeRoomId(rooms);
      const room = createRoom(ov, wk);
      room.players.push({ id: opp.entry.socketId, name: opp.entry.name, userId: opp.entry.userId, clientId: opp.entry.clientId });
      room.players.push({ id: socket.id, name, userId: socket.data.userId, clientId: socket.data.clientId });
      rooms.set(roomId, room);

      opp.sock.join(roomId);
      opp.sock.data.roomId = roomId;
      opp.sock.data.playerName = opp.entry.name;
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerName = name;

      opp.sock.emit('match_found', { roomId, myPlayerIdx: 0 });
      socket.emit('match_found', { roomId, myPlayerIdx: 1 });

      const callerIdx = Math.floor(Math.random() * 2);
      room.tossCallerId = room.players[callerIdx].id;
      room.phase = 'toss_call';
      io.to(roomId).emit('state', publicState(room, roomId));
      io.to(roomId).emit('toss_start', { callerId: room.tossCallerId, callerName: room.players[callerIdx].name });
    });

    socket.on('cancel_match', () => {
      removeFromQueue(socket.id);
      socket.data.matchKey = undefined;
    });

    socket.on('join_room', ({ roomId, playerName }) => {
      removeFromQueue(socket.id);
      const room = rooms.get(roomId);
      if (!room) return socket.emit('error', { message: 'Room not found.' });
      if (room.players.length >= 2) return socket.emit('error', { message: 'Room is full.' });
      if (room.phase !== 'waiting') return socket.emit('error', { message: 'Game already started.' });

      const name = cleanName(playerName);
      room.players.push({ id: socket.id, name, userId: socket.data.userId, clientId: socket.data.clientId });
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerName = name;

      const callerIdx = Math.floor(Math.random() * 2);
      room.tossCallerId = room.players[callerIdx].id;
      room.phase = 'toss_call';

      io.to(roomId).emit('state', publicState(room, roomId));
      io.to(roomId).emit('toss_start', { callerId: room.tossCallerId, callerName: room.players[callerIdx].name });
    });

    socket.on('toss_call', ({ call }) => {
      const roomId = socket.data.roomId;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room || !roomId || room.phase !== 'toss_call') return;
      if (socket.id !== room.tossCallerId) return;
      applyTossCall(io, roomId, room, rooms, call);
    });

    socket.on('bat_bowl_choice', ({ choice }) => {
      const roomId = socket.data.roomId;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room || !roomId || room.phase !== 'bat_bowl') return;
      if (socket.id !== room.tossWinnerId) return;
      applyBatBowlChoice(io, roomId, room, rooms, choice);
    });

    socket.on('play_move', ({ number }) => {
      if (!Number.isInteger(number) || number < 1 || number > 6) return;
      const roomId = socket.data.roomId;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room || !roomId || room.phase !== 'innings') return;

      const playerIdx = room.players.findIndex((p) => p.id === socket.id);
      if (playerIdx === -1) return;
      if (playerIdx !== room.batsmanIdx && playerIdx !== room.bowlerIdx) return;
      if (room.pendingMoves[socket.id] !== undefined) return;

      room.pendingMoves[socket.id] = number;
      socket.emit('move_received', { number });

      const batMove = room.pendingMoves[batsmanId(room)];
      const bowlMove = room.pendingMoves[bowlerId(room)];
      if (batMove === undefined || bowlMove === undefined) {
        // Opponent still to play — if it's a bot, prompt it to respond.
        if (room.hasBot) driveBots(io, roomId, room, rooms);
        return;
      }

      room.pendingMoves = {};
      resolveBall(io, roomId, room, rooms, batMove, bowlMove);
      // Pre-arm the bot for the next ball (human triggers the resolve by playing).
      if (room.hasBot) driveBots(io, roomId, room, rooms);
    });

    socket.on('send_emote', ({ emote }) => {
      if (typeof emote !== 'string' || !ALLOWED_EMOTES.has(emote)) return;
      const roomId = socket.data.roomId;
      if (!roomId || !rooms.has(roomId)) return;
      // Per-socket rate limit so a custom client can't spam the room.
      const now = Date.now();
      if (socket.data.lastEmoteAt && now - socket.data.lastEmoteAt < EMOTE_COOLDOWN_MS) return;
      socket.data.lastEmoteAt = now;
      // Relay to everyone else in the room (the sender shows their own locally).
      socket.to(roomId).emit('emote_received', {
        emote,
        fromName: socket.data.playerName ?? 'Opponent',
        fromId: socket.id,
      });
    });

    socket.on('final_ready', () => {
      const roomId = socket.data.roomId;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room || !roomId || !room.finalAwaiting) return;
      room.finalAwaiting.delete(socket.id);
      if (room.finalAwaiting.size === 0) {
        room.finalAwaiting = undefined;
        if (room._finalStartTimer) {
          clearTimeout(room._finalStartTimer);
          room._finalStartTimer = undefined;
        }
        driveBots(io, roomId, room, rooms);
      }
    });

    socket.on('declare', () => {
      const roomId = socket.data.roomId;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room || !roomId) return;
      if (room.phase === 'waiting' || room.phase === 'result') return;
      if (room.players.length < 2) return;
      const declarerIdx = room.players.findIndex((p) => p.id === socket.id);
      if (declarerIdx === -1) return;

      // Tournament matches advance the bracket via the tournament forfeit path
      // (same as a disconnect), so the standings stay consistent.
      if (room.tournamentId !== undefined && room.tournamentMatchIdx !== undefined) {
        const tournament = tournaments.get(room.tournamentId);
        if (tournament) forfeitTournamentMatch(io, rooms, tournament, room.tournamentMatchIdx, socket.id);
        rooms.delete(roomId);
        return;
      }

      forfeitGame(io, roomId, room, declarerIdx, rooms);
    });

    socket.on('send_challenge', ({ toUserId, overs, wickets }) => {
      if (!socket.data.userId) return;
      const toSocketId = onlineUsers.get(toUserId);
      if (!toSocketId) return socket.emit('challenge_error', { message: 'Player is offline' });

      const challenger = findById(socket.data.userId);
      if (!challenger) return;

      // Clamp once so the stored challenge and the payload sent to the opponent
      // can't drift apart.
      const challengeOvers = clampCount(overs, 2);
      const challengeWickets = clampCount(wickets, 2);

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
        overs: challengeOvers,
        wickets: challengeWickets,
        timeout,
      });

      io.to(toSocketId).emit('challenge_received', {
        challengeId,
        from: { id: socket.data.userId, username: challenger.username },
        overs: challengeOvers,
        wickets: challengeWickets,
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

      // Challenger may have disconnected during the 30s window; don't build a
      // room around a dead socket that the accepter would be stuck waiting in.
      if (!challengerSocket) {
        return socket.emit('challenge_error', { message: 'Challenger is no longer available.' });
      }

      const roomId = makeRoomId(rooms);
      const room = createRoom(ch.overs, ch.wickets);
      const challenger = findById(ch.challengerId);
      const challenged = socket.data.userId ? findById(socket.data.userId) : null;

      room.players.push({ id: ch.challengerSocketId, name: challenger?.username || 'Player 1', userId: ch.challengerId });
      room.players.push({ id: socket.id, name: challenged?.username || 'Player 2', userId: socket.data.userId });
      rooms.set(roomId, room);

      challengerSocket.join(roomId);
      challengerSocket.data.roomId = roomId;
      challengerSocket.data.playerName = challenger?.username;
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerName = challenged?.username;

      challengerSocket.emit('challenge_room_start', { roomId, myPlayerIdx: 0 });
      socket.emit('challenge_room_start', { roomId, myPlayerIdx: 1 });

      const callerIdx = Math.floor(Math.random() * 2);
      room.tossCallerId = room.players[callerIdx].id;
      room.phase = 'toss_call';

      io.to(roomId).emit('state', publicState(room, roomId));
      io.to(roomId).emit('toss_start', { callerId: room.tossCallerId, callerName: room.players[callerIdx].name });
    });

    socket.on('request_rematch', () => {
      const roomId = socket.data.roomId;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room || !roomId || room.phase !== 'result') return;
      const playerIdx = room.players.findIndex((p) => p.id === socket.id);
      if (playerIdx === -1) return;
      if (!room.rematchRequests) room.rematchRequests = new Set<number>();
      room.rematchRequests.add(playerIdx);
      // A bot opponent always accepts a rematch instantly.
      room.players.forEach((p, i) => {
        if (isBot(p)) room.rematchRequests!.add(i);
      });
      socket.to(roomId).emit('rematch_requested', { from: room.players[playerIdx].name });
      if (room.rematchRequests.size >= 2) startRematch(io, roomId, room, rooms);
    });

    socket.on('rejoin_room', ({ roomId }) => {
      const room = rooms.get(roomId);
      console.log(`[rejoin] room=${roomId} found=${!!room} uid=${socket.data.userId} cid=${socket.data.clientId}`);
      if (!room) return;

      // Match by registered userId when present, else by the stable per-browser
      // clientId so guests (no userId) can also recover their slot after a blip.
      const playerIdx = room.players.findIndex(
        (p) =>
          (p.userId !== null && p.userId === socket.data.userId) ||
          (p.clientId != null && p.clientId === socket.data.clientId)
      );
      console.log(`[rejoin] matchedIdx=${playerIdx} players=${JSON.stringify(room.players.map((p) => ({ uid: p.userId, cid: p.clientId })))}`);
      if (playerIdx === -1) return;

      const oldId = room.players[playerIdx].id;
      // Remap every socket-id-keyed field (players, toss caller/winner,
      // in-flight move) and cancel the disconnect grace timer in one shot.
      remapSocketId(room, oldId, socket.id);
      socket.data.roomId = roomId;
      socket.data.playerName = room.players[playerIdx].name;
      socket.join(roomId);

      // A blip during a tournament match emits rejoin_room (not join_tournament),
      // so keep the tournament's identity in sync too, else lobby highlighting
      // and points updates would target the dead socket id.
      if (room.tournamentId) {
        const tournament = tournaments.get(room.tournamentId);
        if (tournament) {
          remapTournamentSocketId(tournament, oldId, socket.id);
          socket.join('t:' + tournament.id);
          io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
        }
      }

      socket.emit('state', publicState(room, roomId));

      // Re-sync the reconnecting client to the live screen so a blip can't strand
      // it on a stale "waiting" view:
      if (room.phase === 'innings' && room.batsmanIdx !== null && room.bowlerIdx !== null) {
        // Refresh the in-game screen (phase + batsman/bowler/target).
        socket.emit('innings_start', {
          inningsNumber: room.currentInnings + 1,
          batsmanName: room.players[room.batsmanIdx].name,
          bowlerName: room.players[room.bowlerIdx].name,
          target: room.currentInnings === 1 ? room.innings[0].score + 1 : null,
        });
        // A reconnect can leave BOTH moves pending with nothing left to trigger
        // the resolve — finish that ball now. Otherwise make sure the bot is
        // (re)scheduled so the game can't stall waiting on a lost timer.
        const bm = room.pendingMoves[batsmanId(room)];
        const wm = room.pendingMoves[bowlerId(room)];
        if (bm !== undefined && wm !== undefined) {
          room.pendingMoves = {};
          resolveBall(io, roomId, room, rooms, bm, wm);
        } else if (room.hasBot) {
          driveBots(io, roomId, room, rooms);
        }
      } else if (room.phase === 'result' && room.lastGameOver) {
        // Missed the finish while away — deliver it so the client leaves the game.
        socket.emit('game_over', room.lastGameOver);
      }
    });

    socket.on('leave_room', () => {
      const roomId = socket.data.roomId;
      socket.data.roomId = undefined;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      socket.leave(roomId);

      // Cancel any pending disconnect-grace timer for this socket so it can't
      // fire against a room we've already left.
      if (room._graceTimers?.[socket.id]) {
        clearTimeout(room._graceTimers[socket.id]);
        delete room._graceTimers[socket.id];
      }

      // Tournament match rooms are owned by the tournament scheduler (it deletes
      // them on advance); don't tear those down here.
      if (room.tournamentId) return;

      // Drop the player and reap the room once empty. Without this, a normal
      // game that ends with both players clicking "Back to Lobby" would leak its
      // Room in the in-memory map until their sockets eventually disconnect.
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) room.players.splice(idx, 1);
      if (room.players.length === 0) rooms.delete(roomId);
    });

    socket.on('disconnect', () => {
      // Only clear the online entry if it still points at THIS socket. A fast
      // reconnect assigns a new socket id and re-sets the entry before the old
      // socket's disconnect fires; an unguarded delete would clobber the live
      // mapping and make the user look offline (and unchallengeable).
      if (socket.data.userId && onlineUsers.get(socket.data.userId) === socket.id)
        onlineUsers.delete(socket.data.userId);
      removeFromQueue(socket.id);
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

      // If this socket's slot was already reclaimed by a reconnect (its id no
      // longer appears in the room), do nothing — a fast refresh can rejoin
      // BEFORE the old socket's disconnect fires, and arming a timer here would
      // tear down a game the player has already recovered.
      if (!room.players.some((p) => p.id === socket.id)) {
        console.log(`[disconnect] ${socket.id} already reclaimed in ${roomId} — no teardown`);
        return;
      }

      // Grace period: a brief disconnect (page refresh, HMR, network blip)
      // should not destroy the game. The reconnecting socket emits rejoin_room,
      // which remaps the player's id and clears this timer.
      const GRACE_MS = 15000;
      console.log(`[disconnect] arming ${GRACE_MS}ms grace for ${socket.id} in ${roomId}`);
      room._graceTimers ??= {};
      room._graceTimers[socket.id] = setTimeout(() => {
        if (!rooms.has(roomId)) return;
        // Reclaimed while we waited? The player is back — don't tear down.
        if (!room.players.some((p) => p.id === socket.id)) return;
        console.log(`[grace] tearing down room ${roomId} — ${socket.id} never returned`);
        rooms.delete(roomId);
        io.to(roomId).emit('opponent_disconnected', { name: socket.data.playerName });

        // A live tournament match can't just vanish — forfeit it to the
        // surviving player and advance the bracket, or the tournament stalls
        // on this fixture forever. ('result' means endInnings already advanced.)
        if (room.tournamentId && room.tournamentMatchIdx !== undefined && room.phase !== 'result') {
          const tournament = tournaments.get(room.tournamentId);
          if (tournament) forfeitTournamentMatch(io, rooms, tournament, room.tournamentMatchIdx, socket.id);
        }
      }, GRACE_MS);
    });
  });

  registerTournamentHandlers(io, rooms);
}
