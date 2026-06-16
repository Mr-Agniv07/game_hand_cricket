import { randomUUID } from 'crypto';
import type { Server, DefaultEventsMap } from 'socket.io';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  TournamentState,
  TournamentPlayer,
  FixtureMatch,
  PointsTableEntry,
  LiveMatchScore,
} from '@cric/types';
import { makeRoomId, createRoom, publicState, cleanName, clampCount, type Room } from '../game/room.ts';
import { makeBotId, randomBotName, isBot } from '../game/bot.ts';
import { driveBots } from '../game/logic.ts';
import type { SocketData } from '../game/types.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TournamentPlayerEntry {
  id: string;
  name: string;
  userId: string | null;
  /** Stable per-browser id; lets guests (no userId) reconnect to the tournament. */
  clientId?: string | null;
  /** Computer-controlled entrant — fills empty slots and auto-plays its matches. */
  isBot?: boolean;
}

export interface InternalFixtureMatch {
  matchNum: number;
  player1Idx: number;
  player2Idx: number;
  status: 'upcoming' | 'live' | 'done';
  result: 'p1' | 'p2' | 'tie' | null;
  p1Score: number;
  p2Score: number;
  roomId: string | null;
  isFinal?: boolean;
}

export interface InternalPointsEntry {
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

export interface Tournament {
  id: string;
  code: string;
  overs: number;
  wickets: number;
  players: TournamentPlayerEntry[];
  phase: 'waiting' | 'in_progress' | 'complete';
  fixtures: InternalFixtureMatch[];
  currentMatchIndex: number;
  pointsTable: Record<string, InternalPointsEntry>;
  liveScore: LiveMatchScore | null;
  /** True once the playoff final has been appended to fixtures. */
  finalCreated?: boolean;
  /** Final winner's player id (set when the final is decided). */
  champion?: string | null;
}

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

// ─── State ───────────────────────────────────────────────────────────────────

export const tournaments = new Map<string, Tournament>(); // keyed by tournament code

// ─── Fixture template ─────────────────────────────────────────────────────────

// Round-robin home+away: 12 matches total, each pair plays twice
const FIXTURE_TEMPLATE: [number, number][] = [
  [0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2],
  [1, 0], [3, 2], [2, 0], [3, 1], [3, 0], [2, 1],
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeNRR(e: InternalPointsEntry): number {
  if (e.ballsFaced === 0 || e.ballsBowled === 0) return 0;
  return (e.runsScored * 6) / e.ballsFaced - (e.runsConceded * 6) / e.ballsBowled;
}

/** Player indices ranked by league standing: points desc, then NRR desc. */
function rankedPlayerIndices(t: Tournament): number[] {
  return t.players
    .map((p, idx) => ({ idx, e: t.pointsTable[p.id] }))
    .sort((a, b) => {
      if (!a.e || !b.e) return 0;
      if (b.e.points !== a.e.points) return b.e.points - a.e.points;
      return computeNRR(b.e) - computeNRR(a.e);
    })
    .map((x) => x.idx);
}

/**
 * Append the playoff final between the top-2 league finishers. player1 is the
 * higher seed (rank 1), so a tied final is awarded to the better league side.
 * The final does NOT count toward the league points table.
 */
function setupFinal(io: GameServer, t: Tournament): void {
  t.finalCreated = true;
  const [top1, top2] = rankedPlayerIndices(t);
  t.fixtures.push({
    matchNum: t.fixtures.length + 1,
    player1Idx: top1,
    player2Idx: top2,
    status: 'upcoming',
    result: null,
    p1Score: 0,
    p2Score: 0,
    roomId: null,
    isFinal: true,
  });
  io.to('t:' + t.id).emit('tournament_state', publicTournamentState(t));
}

/**
 * Advance the bracket after `completedIdx` finished: play the next scheduled
 * fixture, else set up the final (once the round-robin is done), else finalize.
 * Centralised so every completion path (normal end, forfeit, missing player)
 * agrees on what comes next.
 */
export function advanceTournament(
  io: GameServer,
  rooms: Map<string, Room>,
  t: Tournament,
  completedIdx: number
): void {
  const next = completedIdx + 1;
  if (next < t.fixtures.length) {
    startTournamentMatch(io, rooms, t, next);
  } else if (!t.finalCreated) {
    setupFinal(io, t);
    startTournamentMatch(io, rooms, t, t.fixtures.length - 1);
  } else {
    finalizeTournament(io, t);
  }
}

/**
 * A tournament player's identity is their socket.id, stored in both
 * players[].id and as the pointsTable key. Remap both together when the socket
 * id changes on reconnect, or lobby highlighting and points updates land on a
 * dead id. Centralised so the join_tournament and rejoin_room paths agree.
 */
export function remapTournamentSocketId(t: Tournament, oldId: string, newId: string): void {
  if (oldId === newId) return;
  const player = t.players.find((p) => p.id === oldId);
  if (player) player.id = newId;
  const entry = t.pointsTable[oldId];
  if (entry) {
    t.pointsTable[newId] = entry;
    delete t.pointsTable[oldId];
  }
}

export function publicTournamentState(t: Tournament): TournamentState {
  return {
    id: t.id,
    code: t.code,
    overs: t.overs,
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
        isFinal: f.isFinal ?? false,
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
    champion: t.champion ?? null,
  };
}

export function generateFixture(tournament: Tournament): void {
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

export function pushLiveScore(
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
    wickets: room.wickets,
    target: room.currentInnings === 1 ? room.innings[0].score + 1 : null,
    currentInnings: room.currentInnings + 1,
    lastBall,
  };
  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
}

export function finalizeTournament(io: GameServer, tournament: Tournament): void {
  tournament.phase = 'complete';
  // Defensive: if we somehow finalized without a recorded champion, fall back to
  // the league topper so the result screen always has a winner.
  if (!tournament.champion) {
    const topIdx = rankedPlayerIndices(tournament)[0];
    tournament.champion = tournament.players[topIdx]?.id ?? null;
  }
  const state = publicTournamentState(tournament);
  io.to('t:' + tournament.id).emit('tournament_state', state);
  io.to('t:' + tournament.id).emit('tournament_complete', {
    players: state.players,
    pointsTable: state.pointsTable,
  });
}

/**
 * A player abandoned a live match (disconnect grace elapsed without reconnect).
 * Award the fixture to the surviving player and schedule the next match —
 * without this the whole tournament stalls on this fixture forever, since
 * nothing else advances `currentMatchIndex` once the room is gone.
 * `advanceDelayMs` defaults long enough for the surviving client to clear its
 * "opponent disconnected" screen (3s) and return to the tournament lobby first.
 */
export function forfeitTournamentMatch(
  io: GameServer,
  rooms: Map<string, Room>,
  tournament: Tournament,
  matchIndex: number,
  loserId: string,
  advanceDelayMs = 4000
): void {
  const fixture = tournament.fixtures[matchIndex];
  if (!fixture || fixture.status === 'done') return;

  fixture.status = 'done';
  const p1Id = tournament.players[fixture.player1Idx].id;
  const p2Id = tournament.players[fixture.player2Idx].id;
  const p1Lost = p1Id === loserId;
  fixture.result = p1Lost ? 'p2' : 'p1';
  const winnerId = p1Lost ? p2Id : p1Id;

  if (fixture.isFinal) {
    // A forfeited final: the surviving player is champion; no league points.
    tournament.champion = winnerId;
  } else {
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
  }

  tournament.liveScore = null;
  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));

  setTimeout(() => advanceTournament(io, rooms, tournament, matchIndex), advanceDelayMs);
}

export function startTournamentMatch(
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
  // Bots have no socket; a human is "present" only if their socket is live.
  const p1Socket = isBot(p1) ? undefined : io.sockets.sockets.get(p1.id);
  const p2Socket = isBot(p2) ? undefined : io.sockets.sockets.get(p2.id);
  const p1Present = isBot(p1) || !!p1Socket;
  const p2Present = isBot(p2) || !!p2Socket;

  if (!p1Present || !p2Present) {
    // A human player vanished — forfeit to the present side, continue to next match.
    fixture.status = 'done';
    const p1Gone = !p1Present;
    fixture.result = p1Gone ? 'p2' : 'p1';
    const winnerId = p1Gone ? p2.id : p1.id;
    const loserId = p1Gone ? p1.id : p2.id;
    if (fixture.isFinal) {
      tournament.champion = winnerId;
    } else {
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
    }
    io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
    setTimeout(() => advanceTournament(io, rooms, tournament, matchIndex), 1000);
    return;
  }

  const roomId = makeRoomId(rooms);
  const room = createRoom(tournament.overs, tournament.wickets);
  // Carry clientId through so a guest (no userId) whose socket id changes on a
  // blip can still be matched by rejoin_room; without it their reconnect fails
  // and the grace timer forfeits the match.
  room.players.push({ id: p1.id, name: p1.name, userId: p1.userId, clientId: p1.clientId, isBot: p1.isBot });
  room.players.push({ id: p2.id, name: p2.name, userId: p2.userId, clientId: p2.clientId, isBot: p2.isBot });
  room.hasBot = isBot(p1) || isBot(p2);
  room.tournamentId = tournament.code;
  room.tournamentMatchIdx = matchIndex;
  rooms.set(roomId, room);
  fixture.roomId = roomId;

  // Only real sockets join the match room / get the start event; bots need neither.
  if (p1Socket) {
    p1Socket.join(roomId);
    p1Socket.data.roomId = roomId;
    p1Socket.emit('tournament_match_starting', {
      roomId,
      opponentName: p2.name,
      matchNum: fixture.matchNum,
      myPlayerIdx: 0,
      isFinal: fixture.isFinal,
    });
  }
  if (p2Socket) {
    p2Socket.join(roomId);
    p2Socket.data.roomId = roomId;
    p2Socket.emit('tournament_match_starting', {
      roomId,
      opponentName: p1.name,
      matchNum: fixture.matchNum,
      myPlayerIdx: 1,
      isFinal: fixture.isFinal,
    });
  }

  const callerIdx = Math.floor(Math.random() * 2);
  room.tossCallerId = room.players[callerIdx].id;
  room.phase = 'toss_call';

  io.to(roomId).emit('state', publicState(room, roomId));
  io.to(roomId).emit('toss_start', {
    callerId: room.tossCallerId,
    callerName: room.players[callerIdx].name,
  });

  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));

  // Drive any bot(s) — for bot-vs-bot this plays the whole match automatically.
  driveBots(io, roomId, room, rooms);
}

// ─── Socket handlers ──────────────────────────────────────────────────────────

export function registerTournamentHandlers(io: GameServer, rooms: Map<string, Room>): void {
  io.on('connection', (socket) => {
    socket.on('create_tournament', ({ playerName, overs, wickets }) => {
      const code = makeRoomId(tournaments);
      const tournamentId = randomUUID();
      const tournament: Tournament = {
        id: tournamentId,
        code,
        overs: clampCount(overs, 2),
        wickets: clampCount(wickets, 2),
        players: [
          {
            id: socket.id,
            name: cleanName(playerName),
            userId: socket.data.userId,
            clientId: socket.data.clientId,
          },
        ],
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

      // Already in tournament with same socket (no-op)
      if (tournament.players.some((p) => p.id === socket.id)) return;

      // Reconnection: a logged-in player whose socket.id changed (refresh, or a
      // between-match / spectator network blip). This MUST run before the
      // phase guard below — otherwise an in-progress tournament rejects the
      // rejoin and the player's dead socket id is never remapped, so their
      // upcoming fixtures forfeit when startTournamentMatch can't find them.
      const reconnIdx = tournament.players.findIndex(
        (p) =>
          (socket.data.userId !== null && p.userId === socket.data.userId) ||
          (socket.data.clientId !== null && p.clientId === socket.data.clientId)
      );

      if (reconnIdx !== -1) {
        remapTournamentSocketId(tournament, tournament.players[reconnIdx].id, socket.id);
        socket.join('t:' + tournament.id);
        socket.data.tournamentId = tournament.id;
        // Use tournament_created so the client transitions to tournament_lobby phase
        socket.emit('tournament_created', publicTournamentState(tournament));
        io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
        return;
      }

      // New joiner — only allowed while the tournament is still gathering players.
      if (tournament.phase !== 'waiting')
        return socket.emit('error', { message: 'Tournament already started.' });

      if (tournament.players.length >= 4)
        return socket.emit('error', { message: 'Tournament is full.' });

      tournament.players.push({
        id: socket.id,
        name: cleanName(playerName),
        userId: socket.data.userId,
        clientId: socket.data.clientId,
      });
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

    socket.on('start_tournament_with_bots', () => {
      // Find the tournament this socket is hosting.
      const tournament = [...tournaments.values()].find((t) => t.players[0]?.id === socket.id);
      if (!tournament || tournament.phase !== 'waiting') return;
      if (tournament.players.length < 1 || tournament.players.length >= 4) return;

      // Fill the remaining seats with uniquely-named bots.
      while (tournament.players.length < 4) {
        const taken = tournament.players.map((p) => p.name);
        tournament.players.push({
          id: makeBotId(),
          name: randomBotName(taken),
          userId: null,
          isBot: true,
        });
      }

      generateFixture(tournament);
      tournament.phase = 'in_progress';
      io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
      startTournamentMatch(io, rooms, tournament, 0);
    });
  });
}
