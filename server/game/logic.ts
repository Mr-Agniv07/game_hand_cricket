import type { Server, DefaultEventsMap } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, InningsEndReason } from '@cric/types';
import { updateGameStats, trainPlayerProfiles } from '../db.ts';
import { type Room, type RoomInnings, totalBalls, publicState, freshInnings } from './room.ts';
import type { SocketData } from './types.ts';
import {
  tournaments,
  publicTournamentState,
  pushLiveScore,
  finalizeTournament,
  startTournamentMatch,
} from '../tournament/handlers.ts';

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

export function resolveBall(
  io: GameServer,
  roomId: string,
  room: Room,
  rooms: Map<string, Room>,
  batMove: number,
  bowlMove: number
): void {
  const inn = room.innings[room.currentInnings];

  // Defensive: if the previous ball already completed the overs but endInnings
  // somehow wasn't triggered, catch it here before the next ball lands. Bail
  // BEFORE training so a discarded (uncounted) ball can't pollute the models.
  if (inn.balls >= totalBalls(room)) {
    endInnings(io, roomId, room, rooms, 'overs_complete');
    return;
  }

  // Train global player profiles on every ball of every game.
  // Track each player's previous move by their array index, not name —
  // two players sharing a display name would otherwise clobber each
  // other's Markov "last move" within the room.
  room.mlLastMoves ??= {};
  const batIdx = room.batsmanIdx!;
  const bowlIdx = room.bowlerIdx!;
  trainPlayerProfiles([
    {
      userId: room.players[batIdx].userId,
      role: 'bat',
      move: batMove,
      lastMove: room.mlLastMoves[batIdx],
    },
    {
      userId: room.players[bowlIdx].userId,
      role: 'bowl',
      move: bowlMove,
      lastMove: room.mlLastMoves[bowlIdx],
    },
  ]);
  room.mlLastMoves[batIdx] = batMove;
  room.mlLastMoves[bowlIdx] = bowlMove;

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
      endInnings(io, roomId, room, rooms, allOut ? 'all_out' : 'overs_complete');
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

    if (room.currentInnings === 1 && inn.score >= room.innings[0].score + 1) {
      endInnings(io, roomId, room, rooms, 'target_reached');
      return;
    }

    if (inn.balls >= totalBalls(room)) {
      endInnings(io, roomId, room, rooms, 'overs_complete');
      return;
    }

    pushLiveScore(io, room, { scored: batMove, isOut: false, batsmanMove: batMove, bowlerMove: bowlMove });
  }
}

function determineResult(
  room: Room,
  reason: InningsEndReason,
  inn1: RoomInnings,
  inn2: RoomInnings
): { winnerId: string | null; winnerName: string | null; resultText: string } {
  if (reason === 'target_reached') {
    const winner = room.players[room.batsmanIdx!];
    return { winnerId: winner.id, winnerName: winner.name, resultText: `${winner.name} won by chasing the target!` };
  }
  if (inn2.score >= inn1.score + 1) {
    const winner = room.players[room.batsmanIdx!];
    return { winnerId: winner.id, winnerName: winner.name, resultText: `${winner.name} won!` };
  }
  if (inn2.score === inn1.score) {
    return { winnerId: null, winnerName: null, resultText: 'Match tied!' };
  }
  // First innings team wins; roles were swapped, so bowlerIdx batted 1st
  const firstBatsman = room.players[room.bowlerIdx!];
  const margin = inn1.score - inn2.score;
  return {
    winnerId: firstBatsman.id,
    winnerName: firstBatsman.name,
    resultText: `${firstBatsman.name} won by ${margin} run${margin !== 1 ? 's' : ''}!`,
  };
}

export function endInnings(
  io: GameServer,
  roomId: string,
  room: Room,
  rooms: Map<string, Room>,
  reason: InningsEndReason
): void {
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
    const { winnerId, winnerName, resultText } = determineResult(room, reason, inn1, inn2);

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
          updateEntry(inn1PId, inn1.score, inn1.balls, inn2.score, inn2.balls, !tied && winnerId === inn1PId, tied);
          updateEntry(inn2PId, inn2.score, inn2.balls, inn1.score, inn1.balls, !tied && winnerId === inn2PId, tied);

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
export function forfeitGame(
  io: GameServer,
  roomId: string,
  room: Room,
  declarerIdx: number,
  rooms: Map<string, Room>
): void {
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

export function startRematch(io: GameServer, roomId: string, room: Room): void {
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
