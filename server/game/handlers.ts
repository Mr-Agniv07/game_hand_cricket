import { randomUUID } from 'crypto';
import type { Server, Socket, DefaultEventsMap } from 'socket.io';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  Mode,
  InningsEndReason,
  RoomCreatedPayload,
} from '@cric/types';
import { findById, updateGameStats, trainPlayerProfiles } from '../db.ts';
import { verifyToken } from '../auth/auth.ts';
import {
  type Room,
  makeRoomId,
  cleanName,
  freshInnings,
  createRoom,
  totalBalls,
  batsmanId,
  bowlerId,
  publicState,
  remapSocketId,
} from './room.ts';
import type { SocketData } from './types.ts';
import {
  tournaments,
  publicTournamentState,
  pushLiveScore,
  finalizeTournament,
  startTournamentMatch,
  forfeitTournamentMatch,
  remapTournamentSocketId,
  registerTournamentHandlers,
} from '../tournament/handlers.ts';

export type { SocketData };

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

export const onlineUsers = new Map<string, string>(); // userId → socketId
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
      const name = cleanName(playerName);
      const roomId = makeRoomId(rooms);
      const room = createRoom(Number(overs) || 1, mode || 'overs', Number(wickets) || 1);
      room.players.push({ id: socket.id, name, userId: socket.data.userId });
      rooms.set(roomId, room);
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerName = name;
      socket.emit('room_created', { roomId } satisfies RoomCreatedPayload);
      socket.emit('state', publicState(room, roomId));
    });

    socket.on('join_room', ({ roomId, playerName }) => {
      const room = rooms.get(roomId);
      if (!room) return socket.emit('error', { message: 'Room not found.' });
      if (room.players.length >= 2) return socket.emit('error', { message: 'Room is full.' });
      if (room.phase !== 'waiting')
        return socket.emit('error', { message: 'Game already started.' });

      const name = cleanName(playerName);
      room.players.push({ id: socket.id, name, userId: socket.data.userId });
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerName = name;

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
      room.tossWinnerId = won ? socket.id : room.players.find((p) => p.id !== socket.id)!.id;
      room.phase = 'bat_bowl';

      io.to(roomId).emit('toss_result', {
        call,
        result,
        winnerId: room.tossWinnerId,
        winnerName: room.players.find((p) => p.id === room.tossWinnerId)!.name,
      });
      io.to(roomId).emit('state', publicState(room, roomId));
    });

    socket.on('bat_bowl_choice', ({ choice }) => {
      const roomId = socket.data.roomId;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room || !roomId || room.phase !== 'bat_bowl') return;
      if (socket.id !== room.tossWinnerId) return;

      const winnerIdx = room.players.findIndex((p) => p.id === room.tossWinnerId);
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
      if (!Number.isInteger(number) || number < 1 || number > 6) return;
      const roomId = socket.data.roomId;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room || !roomId || room.phase !== 'innings') return;

      const playerIdx = room.players.findIndex((p) => p.id === socket.id);
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

      // Train global player profiles on every ball of every game.
      // Track each player's previous move by their array index, not name —
      // two players sharing a display name would otherwise clobber each
      // other's Markov "last move" within the room.
      if (!room.mlLastMoves) room.mlLastMoves = {};
      const batIdx = room.batsmanIdx!;
      const bowlIdx = room.bowlerIdx!;
      trainPlayerProfiles([
        { userId: room.players[batIdx].userId, move: batMove, lastMove: room.mlLastMoves[batIdx] },
        { userId: room.players[bowlIdx].userId, move: bowlMove, lastMove: room.mlLastMoves[bowlIdx] },
      ]);
      room.mlLastMoves[batIdx] = batMove;
      room.mlLastMoves[bowlIdx] = bowlMove;

      const inn = room.innings[room.currentInnings];

      // Defensive: if the previous ball already completed the overs but endInnings
      // somehow wasn't triggered, catch it here before the next ball lands.
      if (inn.balls >= totalBalls(room)) {
        endInnings(io, roomId, room, 'overs_complete');
        return;
      }

      inn.balls += 1;

      if (batMove === bowlMove) {
        inn.wicketsLost += 1;

        io.to(roomId).emit('ball_played', {
          batsmanMove: batMove,
          bowlerMove: bowlMove,
          scored: 0,
          isOut: true,
          wicketsLost: inn.wicketsLost,
          score: inn.score,
          balls: inn.balls,
        });

        // The innings ends as soon as EITHER limit is reached — the wicket
        // quota falls or the over quota is bowled, whichever comes first.
        const allOut = inn.wicketsLost >= room.wickets;
        const ovComplete = inn.balls >= totalBalls(room);

        if (allOut || ovComplete) {
          inn.isOut = allOut;
          endInnings(io, roomId, room, allOut ? 'all_out' : 'overs_complete');
        } else {
          io.to(roomId).emit('state', publicState(room, roomId));
          pushLiveScore(io, room, {
            scored: 0,
            isOut: true,
            batsmanMove: batMove,
            bowlerMove: bowlMove,
          });
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

        if (inn.balls >= totalBalls(room)) {
          endInnings(io, roomId, room, 'overs_complete');
          return;
        }

        pushLiveScore(io, room, {
          scored: batMove,
          isOut: false,
          batsmanMove: batMove,
          bowlerMove: bowlMove,
        });
      }
    });

    socket.on('declare', () => {
      const roomId = socket.data.roomId;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room || !roomId) return;
      // Only meaningful while a match is actually in progress with two players.
      if (room.phase === 'waiting' || room.phase === 'result') return;
      if (room.players.length < 2) return;
      const declarerIdx = room.players.findIndex((p) => p.id === socket.id);
      if (declarerIdx === -1) return;

      // Tournament matches advance the bracket via the tournament forfeit path
      // (same as a disconnect), so the standings stay consistent.
      if (room.tournamentId !== undefined && room.tournamentMatchIdx !== undefined) {
        const tournament = tournaments.get(room.tournamentId);
        if (tournament) {
          forfeitTournamentMatch(io, rooms, tournament, room.tournamentMatchIdx, socket.id);
        }
        rooms.delete(roomId);
        return;
      }

      forfeitGame(io, roomId, room, declarerIdx);
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
        challengerSocket?.emit('challenge_declined', {
          username: decliner?.username || 'Opponent',
        });
        return;
      }

      // Challenger may have disconnected during the 30s window; don't build a
      // room around a dead socket that the accepter would be stuck waiting in.
      if (!challengerSocket) {
        return socket.emit('challenge_error', { message: 'Challenger is no longer available.' });
      }

      const roomId = makeRoomId(rooms);
      const room = createRoom(ch.overs, ch.mode, ch.wickets);
      const challenger = findById(ch.challengerId);
      const challenged = socket.data.userId ? findById(socket.data.userId) : null;

      room.players.push({
        id: ch.challengerSocketId,
        name: challenger?.username || 'Player 1',
        userId: ch.challengerId,
      });
      room.players.push({
        id: socket.id,
        name: challenged?.username || 'Player 2',
        userId: socket.data.userId,
      });
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
      const playerIdx = room.players.findIndex((p) => p.id === socket.id);
      if (playerIdx === -1) return;
      if (!room.rematchRequests) room.rematchRequests = new Set<number>();
      room.rematchRequests.add(playerIdx);
      socket.to(roomId).emit('rematch_requested', { from: room.players[playerIdx].name });
      if (room.rematchRequests.size >= 2) startRematch(io, roomId, room);
    });

    socket.on('rejoin_room', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || !socket.data.userId) return;

      const playerIdx = room.players.findIndex(
        (p) => p.userId !== null && p.userId === socket.data.userId
      );
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
    });

    socket.on('disconnect', () => {
      // Only clear the online entry if it still points at THIS socket. A fast
      // reconnect assigns a new socket id and re-sets the entry before the old
      // socket's disconnect fires; an unguarded delete would clobber the live
      // mapping and make the user look offline (and unchallengeable).
      if (socket.data.userId && onlineUsers.get(socket.data.userId) === socket.id)
        onlineUsers.delete(socket.data.userId);
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
        rooms.delete(roomId);
        io.to(roomId).emit('opponent_disconnected', { name: socket.data.playerName });

        // A live tournament match can't just vanish — forfeit it to the
        // surviving player and advance the bracket, or the tournament stalls
        // on this fixture forever. ('result' means endInnings already advanced.)
        if (room.tournamentId && room.tournamentMatchIdx !== undefined && room.phase !== 'result') {
          const tournament = tournaments.get(room.tournamentId);
          if (tournament) {
            forfeitTournamentMatch(io, rooms, tournament, room.tournamentMatchIdx, socket.id);
          }
        }
      }, GRACE_MS);
    });
  });

  registerTournamentHandlers(io, rooms);
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
    room.mlLastMoves = {};

    // Clear live score at innings break; spectators will see it again from the first ball of innings 2
    if (room.tournamentId) {
      const t = tournaments.get(room.tournamentId);
      if (t) t.liveScore = null;
    }

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

    updateGameStats([
      {
        userId: room.players[0].userId,
        win: winnerId === room.players[0].id,
        tie: winnerId === null,
        runsScored: playerScores[0],
        opponentName: room.players[1].name,
        opponentScore: playerScores[1],
        overs: room.overs,
        wickets: room.wickets,
      },
      {
        userId: room.players[1].userId,
        win: winnerId === room.players[1].id,
        tie: winnerId === null,
        runsScored: playerScores[1],
        opponentName: room.players[0].name,
        opponentScore: playerScores[0],
        overs: room.overs,
        wickets: room.wickets,
      },
    ]);

    // Update tournament if this is a tournament match.
    // At game over: room.bowlerIdx batted in innings 1; room.batsmanIdx batted in innings 2.
    if (room.tournamentId !== undefined && room.tournamentMatchIdx !== undefined) {
      const tournament = tournaments.get(room.tournamentId);
      if (tournament) {
        const matchIdx = room.tournamentMatchIdx;
        const fixture = tournament.fixtures[matchIdx];
        if (fixture) {
          fixture.status = 'done';
          const p1Id = tournament.players[fixture.player1Idx].id;
          const inn1PlayerId = room.players[room.bowlerIdx!].id;

          if (p1Id === inn1PlayerId) {
            fixture.p1Score = inn1.score;
            fixture.p2Score = inn2.score;
          } else {
            fixture.p1Score = inn2.score;
            fixture.p2Score = inn1.score;
          }
          fixture.result = winnerId === null ? 'tie' : winnerId === p1Id ? 'p1' : 'p2';

          const updateEntry = (
            pid: string,
            rs: number,
            bf: number,
            rc: number,
            bb: number,
            won: boolean,
            tied: boolean
          ) => {
            const e = tournament.pointsTable[pid];
            if (!e) return;
            e.played += 1;
            e.runsScored += rs;
            e.ballsFaced += bf;
            e.runsConceded += rc;
            e.ballsBowled += bb;
            if (tied) {
              e.tied += 1;
              e.points += 1;
            } else if (won) {
              e.won += 1;
              e.points += 2;
            } else {
              e.lost += 1;
            }
          };

          const tied = winnerId === null;
          const inn1PId = room.players[room.bowlerIdx!].id;
          const inn2PId = room.players[room.batsmanIdx!].id;
          updateEntry(
            inn1PId,
            inn1.score,
            inn1.balls,
            inn2.score,
            inn2.balls,
            !tied && winnerId === inn1PId,
            tied
          );
          updateEntry(
            inn2PId,
            inn2.score,
            inn2.balls,
            inn1.score,
            inn1.balls,
            !tied && winnerId === inn2PId,
            tied
          );

          tournament.liveScore = null;
          io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));

          setTimeout(() => {
            // The match is over; drop its room so finished tournament rooms
            // don't pile up in the map for the tournament's lifetime.
            rooms.delete(roomId);
            const next = matchIdx + 1;
            if (next >= tournament.fixtures.length) finalizeTournament(io, tournament);
            else startTournamentMatch(io, rooms, tournament, next);
          }, 5000);
        }
      }
    }

    room.phase = 'result';
    io.to(roomId).emit('game_over', {
      winnerId,
      winnerIdx: winnerId === null ? null : room.players.findIndex((p) => p.id === winnerId),
      winnerName,
      resultText,
      scores: playerScores,
      players: room.players.map((p) => p.name),
    });
    io.to(roomId).emit('state', publicState(room, roomId));
  }
}

/**
 * A player declared (forfeited): the opponent wins immediately. Records the
 * result with best-effort scores (whatever has been scored so far) and emits
 * game_over to the *opponent only* — the declarer is returning to the lobby on
 * their own client, so they shouldn't be dropped onto the result screen.
 */
function forfeitGame(io: GameServer, roomId: string, room: Room, declarerIdx: number): void {
  const winnerIdx = declarerIdx === 0 ? 1 : 0;
  const winner = room.players[winnerIdx];
  const loser = room.players[declarerIdx];

  // Align whatever has been scored so far to player-array order. Roles swap at
  // the innings break, so innings[0] belongs to the current bowler in innings 2.
  const playerScores: [number, number] = [0, 0];
  if (room.batsmanIdx !== null && room.bowlerIdx !== null) {
    if (room.currentInnings === 0) {
      playerScores[room.batsmanIdx] = room.innings[0].score;
    } else {
      playerScores[room.bowlerIdx] = room.innings[0].score;
      playerScores[room.batsmanIdx] = room.innings[1].score;
    }
  }

  updateGameStats([
    {
      userId: room.players[0].userId,
      win: winnerIdx === 0,
      tie: false,
      runsScored: playerScores[0],
      opponentName: room.players[1].name,
      opponentScore: playerScores[1],
      overs: room.overs,
      wickets: room.wickets,
    },
    {
      userId: room.players[1].userId,
      win: winnerIdx === 1,
      tie: false,
      runsScored: playerScores[1],
      opponentName: room.players[0].name,
      opponentScore: playerScores[0],
      overs: room.overs,
      wickets: room.wickets,
    },
  ]);

  room.phase = 'result';
  io.to(winner.id).emit('game_over', {
    winnerId: winner.id,
    winnerIdx,
    winnerName: winner.name,
    resultText: `${loser.name} declared — you win!`,
    scores: playerScores,
    players: room.players.map((p) => p.name),
  });
  rooms.delete(roomId);
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
  room.mlLastMoves = {};

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
