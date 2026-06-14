import { randomUUID } from 'crypto';
import type { Server, Socket, DefaultEventsMap } from 'socket.io';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  Mode,
  InningsEndReason,
  RoomCreatedPayload,
  TournamentState,
  TournamentPlayer,
  FixtureMatch,
  PointsTableEntry,
  LiveMatchScore,
} from '@cric/types';
import { findById, updateGameStats } from '../db.ts';
import { verifyToken } from '../auth/auth.ts';
import {
  type Room,
  makeRoomId,
  freshInnings,
  createRoom,
  totalBalls,
  batsmanId,
  bowlerId,
  publicState,
} from './room.ts';

export interface SocketData {
  userId: string | null;
  roomId?: string;
  playerName?: string;
  tournamentId?: string;
}

// ─── Tournament state ─────────────────────────────────────────────────────────

interface TournamentPlayerEntry {
  id: string;
  name: string;
  userId: string | null;
}

interface InternalFixtureMatch {
  matchNum: number;
  player1Idx: number;
  player2Idx: number;
  status: 'upcoming' | 'live' | 'done';
  result: 'p1' | 'p2' | 'tie' | null;
  p1Score: number;
  p2Score: number;
  roomId: string | null;
}

interface InternalPointsEntry {
  played: number;
  won: number;
  lost: number;
  tied: number;
  points: number;
  runsScored: number;
  ballsFaced: number;
  runsConceded: number;
  ballsBowled: number;
}

interface Tournament {
  id: string;
  code: string;
  overs: number;
  mode: Mode;
  wickets: number;
  players: TournamentPlayerEntry[];
  phase: 'waiting' | 'in_progress' | 'complete';
  fixtures: InternalFixtureMatch[];
  currentMatchIndex: number;
  pointsTable: Record<string, InternalPointsEntry>;
  liveScore: LiveMatchScore | null;
}

const tournaments = new Map<string, Tournament>(); // keyed by tournament code

// Round-robin home+away: 12 matches total, each pair plays twice
const FIXTURE_TEMPLATE: [number, number][] = [
  [0, 1],
  [2, 3],
  [0, 2],
  [1, 3],
  [0, 3],
  [1, 2],
  [1, 0],
  [3, 2],
  [2, 0],
  [3, 1],
  [3, 0],
  [2, 1],
];

function computeNRR(e: InternalPointsEntry): number {
  if (e.ballsFaced === 0 || e.ballsBowled === 0) return 0;
  return (e.runsScored * 6) / e.ballsFaced - (e.runsConceded * 6) / e.ballsBowled;
}

function publicTournamentState(t: Tournament): TournamentState {
  return {
    id: t.id,
    code: t.code,
    overs: t.overs,
    mode: t.mode,
    wickets: t.wickets,
    players: t.players.map((p): TournamentPlayer => ({ id: p.id, name: p.name })),
    phase: t.phase,
    fixtures: t.fixtures.map(
      (f): FixtureMatch => ({
        matchNum: f.matchNum,
        player1Idx: f.player1Idx,
        player2Idx: f.player2Idx,
        status: f.status,
        result: f.result,
        p1Score: f.p1Score,
        p2Score: f.p2Score,
      })
    ),
    currentMatchIndex: t.currentMatchIndex,
    pointsTable: Object.fromEntries(
      Object.entries(t.pointsTable).map(([id, e]): [string, PointsTableEntry] => [
        id,
        { ...e, nrr: computeNRR(e) },
      ])
    ),
    liveScore: t.liveScore,
  };
}

function generateFixture(tournament: Tournament): void {
  tournament.fixtures = FIXTURE_TEMPLATE.map(([p1Idx, p2Idx], i) => ({
    matchNum: i + 1,
    player1Idx: p1Idx,
    player2Idx: p2Idx,
    status: 'upcoming' as const,
    result: null,
    p1Score: 0,
    p2Score: 0,
    roomId: null,
  }));
  for (const p of tournament.players) {
    tournament.pointsTable[p.id] = {
      played: 0,
      won: 0,
      lost: 0,
      tied: 0,
      points: 0,
      runsScored: 0,
      ballsFaced: 0,
      runsConceded: 0,
      ballsBowled: 0,
    };
  }
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

export const onlineUsers = new Map<string, string>(); // userId → socketId
const pendingChallenges = new Map<string, PendingChallenge>();
const rooms = new Map<string, Room>();

function pushLiveScore(
  io: GameServer,
  room: Room,
  lastBall: LiveMatchScore['lastBall']
): void {
  if (!room.tournamentId) return;
  const tournament = tournaments.get(room.tournamentId);
  if (!tournament) return;
  const inn = room.innings[room.currentInnings];
  tournament.liveScore = {
    batsmanName: room.players[room.batsmanIdx!].name,
    bowlerName: room.players[room.bowlerIdx!].name,
    score: inn.score,
    balls: inn.balls,
    overs: room.overs,
    wicketsLost: inn.wicketsLost,
    mode: room.mode,
    wickets: room.wickets,
    target: room.currentInnings === 1 ? room.innings[0].score + 1 : null,
    currentInnings: room.currentInnings + 1,
    lastBall,
  };
  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
}

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
      if (room.phase !== 'waiting')
        return socket.emit('error', { message: 'Game already started.' });

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

      const inn = room.innings[room.currentInnings];
      inn.balls += 1;

      if (batMove === bowlMove) {
        inn.wicketsLost += 1;
        // Innings ends when all wickets fall (both modes) or overs run out (overs mode only).
        const ovComplete = room.mode === 'overs' && inn.balls >= totalBalls(room);
        const allOut = inn.wicketsLost >= room.wickets;
        const inningsOver = ovComplete || allOut;

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
          inn.isOut = allOut;
          endInnings(io, roomId, room, allOut ? 'all_out' : 'overs_complete');
        } else {
          io.to(roomId).emit('state', publicState(room, roomId));
          pushLiveScore(io, room, { scored: 0, isOut: true, batsmanMove: batMove, bowlerMove: bowlMove });
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
          return;
        }

        pushLiveScore(io, room, { scored: batMove, isOut: false, batsmanMove: batMove, bowlerMove: bowlMove });
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
        challengerSocket?.emit('challenge_declined', {
          username: decliner?.username || 'Opponent',
        });
        return;
      }

      const roomId = makeRoomId();
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

    socket.on('create_tournament', ({ playerName, overs, mode, wickets }) => {
      const code = makeRoomId();
      const tournamentId = randomUUID();
      const tournament: Tournament = {
        id: tournamentId,
        code,
        overs: Number(overs) || 2,
        mode: mode || 'overs',
        wickets: Number(wickets) || 2,
        players: [{ id: socket.id, name: playerName, userId: socket.data.userId }],
        phase: 'waiting',
        fixtures: [],
        currentMatchIndex: 0,
        pointsTable: {},
        liveScore: null,
      };
      tournaments.set(code, tournament);
      socket.join('t:' + tournamentId);
      socket.data.tournamentId = tournamentId;
      socket.emit('tournament_created', publicTournamentState(tournament));
    });

    socket.on('join_tournament', ({ code, playerName }) => {
      const tournament = tournaments.get(code.toUpperCase());
      if (!tournament) return socket.emit('error', { message: 'Tournament not found.' });
      if (tournament.phase !== 'waiting')
        return socket.emit('error', { message: 'Tournament already started.' });

      // Already in tournament with same socket (no-op)
      if (tournament.players.some((p) => p.id === socket.id)) return;

      // Reconnection: logged-in user whose socket.id changed after a refresh
      const reconnIdx = socket.data.userId !== null
        ? tournament.players.findIndex(p => p.userId === socket.data.userId)
        : -1;

      if (reconnIdx !== -1) {
        tournament.players[reconnIdx].id = socket.id;
        socket.join('t:' + tournament.id);
        socket.data.tournamentId = tournament.id;
        // Use tournament_created so the client transitions to tournament_lobby phase
        socket.emit('tournament_created', publicTournamentState(tournament));
        io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
        return;
      }

      if (tournament.players.length >= 4) return socket.emit('error', { message: 'Tournament is full.' });

      tournament.players.push({ id: socket.id, name: playerName, userId: socket.data.userId });
      socket.join('t:' + tournament.id);
      socket.data.tournamentId = tournament.id;

      // Use tournament_created so the joining socket transitions to tournament_lobby phase;
      // tournament_state alone doesn't trigger the phase change on the client.
      socket.emit('tournament_created', publicTournamentState(tournament));
      io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));

      if (tournament.players.length === 4) {
        generateFixture(tournament);
        tournament.phase = 'in_progress';
        io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
        startTournamentMatch(io, rooms, tournament, 0);
      }
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

    const matchCount = room.mode === 'overs' ? room.overs : room.wickets;
    updateGameStats([
      {
        userId: room.players[0].userId,
        win: winnerId === room.players[0].id,
        tie: winnerId === null,
        runsScored: playerScores[0],
        opponentName: room.players[1].name,
        opponentScore: playerScores[1],
        mode: room.mode,
        count: matchCount,
      },
      {
        userId: room.players[1].userId,
        win: winnerId === room.players[1].id,
        tie: winnerId === null,
        runsScored: playerScores[1],
        opponentName: room.players[0].name,
        opponentScore: playerScores[0],
        mode: room.mode,
        count: matchCount,
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
      winnerName,
      resultText,
      scores: playerScores,
      players: room.players.map((p) => p.name),
    });
    io.to(roomId).emit('state', publicState(room, roomId));
  }
}

function finalizeTournament(io: GameServer, tournament: Tournament): void {
  tournament.phase = 'complete';
  const state = publicTournamentState(tournament);
  io.to('t:' + tournament.id).emit('tournament_state', state);
  io.to('t:' + tournament.id).emit('tournament_complete', {
    players: state.players,
    pointsTable: state.pointsTable,
  });
}

function startTournamentMatch(
  io: GameServer,
  rooms: Map<string, Room>,
  tournament: Tournament,
  matchIndex: number
): void {
  if (matchIndex >= tournament.fixtures.length) {
    finalizeTournament(io, tournament);
    return;
  }

  tournament.currentMatchIndex = matchIndex;
  const fixture = tournament.fixtures[matchIndex];
  fixture.status = 'live';

  const p1 = tournament.players[fixture.player1Idx];
  const p2 = tournament.players[fixture.player2Idx];
  const p1Socket = io.sockets.sockets.get(p1.id);
  const p2Socket = io.sockets.sockets.get(p2.id);

  if (!p1Socket || !p2Socket) {
    // Forfeit for the disconnected player, continue to next match
    fixture.status = 'done';
    const p1Gone = !p1Socket;
    fixture.result = p1Gone ? 'p2' : 'p1';
    const winnerId = p1Gone ? p2.id : p1.id;
    const loserId = p1Gone ? p1.id : p2.id;
    const we = tournament.pointsTable[winnerId];
    const le = tournament.pointsTable[loserId];
    if (we) {
      we.played += 1;
      we.won += 1;
      we.points += 2;
    }
    if (le) {
      le.played += 1;
      le.lost += 1;
    }
    io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
    setTimeout(() => {
      const next = matchIndex + 1;
      if (next >= tournament.fixtures.length) finalizeTournament(io, tournament);
      else startTournamentMatch(io, rooms, tournament, next);
    }, 1000);
    return;
  }

  const roomId = makeRoomId();
  const room = createRoom(tournament.overs, tournament.mode, tournament.wickets);
  room.players.push({ id: p1.id, name: p1.name, userId: p1.userId });
  room.players.push({ id: p2.id, name: p2.name, userId: p2.userId });
  room.tournamentId = tournament.code;
  room.tournamentMatchIdx = matchIndex;
  rooms.set(roomId, room);
  fixture.roomId = roomId;

  p1Socket.join(roomId);
  p1Socket.data.roomId = roomId;
  p2Socket.join(roomId);
  p2Socket.data.roomId = roomId;

  p1Socket.emit('tournament_match_starting', {
    roomId,
    opponentName: p2.name,
    matchNum: fixture.matchNum,
    myPlayerIdx: 0,
  });
  p2Socket.emit('tournament_match_starting', {
    roomId,
    opponentName: p1.name,
    matchNum: fixture.matchNum,
    myPlayerIdx: 1,
  });

  const callerIdx = Math.floor(Math.random() * 2);
  room.tossCallerId = room.players[callerIdx].id;
  room.phase = 'toss_call';

  io.to(roomId).emit('state', publicState(room, roomId));
  io.to(roomId).emit('toss_start', {
    callerId: room.tossCallerId,
    callerName: room.players[callerIdx].name,
  });

  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
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
