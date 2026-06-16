import type { Server, DefaultEventsMap } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, InningsEndReason, TossCall } from '@cric/types';
import { updateGameStats, trainPlayerProfiles } from '../db.ts';
import {
  type Room,
  type RoomInnings,
  totalBalls,
  publicState,
  freshInnings,
  batsmanId,
  bowlerId,
} from './room.ts';
import { isBot, pickBotMove, recordMoveCounts } from './bot.ts';
import type { SocketData } from './types.ts';
import {
  tournaments,
  publicTournamentState,
  pushLiveScore,
  advanceTournament,
} from '../tournament/handlers.ts';

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

/** Delay before a bot acts, so its toss/choice/moves feel paced rather than instant. */
const BOT_DELAY_MS = 650;

/**
 * Schedule a bot action. The body is wrapped in try/catch because an uncaught
 * throw inside a setTimeout callback crashes the whole Node process (taking
 * every live game down with it). Catching keeps one bad ball from freezing
 * everything; the player can refresh to re-trigger via rejoin_room.
 */
function botTimer(fn: () => void): void {
  setTimeout(() => {
    try {
      fn();
    } catch (err) {
      console.error('[bot] action failed:', err);
    }
  }, BOT_DELAY_MS);
}

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

  // Track per-player move frequencies so any bot in this room can adapt.
  if (room.hasBot) recordMoveCounts(room, batIdx, batMove, bowlIdx, bowlMove);

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
    if (room.hasBot) driveBots(io, roomId, room, rooms);
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

          if (fixture.stage === 'final') {
            // The final decides the champion and does NOT count toward the league
            // table. A tied final goes to the higher seed (player1).
            tournament.champion = winnerId ?? tournament.players[fixture.player1Idx].id;
          } else if (fixture.stage === 'group') {
            // ICC-style NRR: a side that's all out is treated as having faced its
            // FULL over quota, regardless of how few balls it actually used. A side
            // that wasn't all out (overs completed, or a successful chase) counts
            // its actual balls. The bowling side is credited the same effective
            // ball count for the innings it bowled.
            const quota = totalBalls(room);
            const eff1 = inn1.isOut ? quota : inn1.balls;
            const eff2 = inn2.isOut ? quota : inn2.balls;

            updateEntry(inn1PId, inn1.score, eff1, inn2.score, eff2, !tied && winnerId === inn1PId, tied);
            updateEntry(inn2PId, inn2.score, eff2, inn1.score, eff1, !tied && winnerId === inn2PId, tied);
          }
          // semi: no points table change; fixture.result (set above) decides who advances.

          tournament.liveScore = null;
          io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));

          setTimeout(() => {
            // The match is over; drop its room so finished tournament rooms
            // don't pile up in the map for the tournament's lifetime.
            rooms.delete(roomId);
            advanceTournament(io, rooms, tournament, matchIdx);
          }, 5000);
        }
      }
    }

    room.phase = 'result';
    const gameOver = {
      winnerId,
      winnerIdx: winnerId === null ? null : room.players.findIndex((p) => p.id === winnerId),
      winnerName,
      resultText,
      scores: playerScores,
      players: room.players.map((p) => p.name),
    };
    room.lastGameOver = gameOver;
    io.to(roomId).emit('game_over', gameOver);
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
  const gameOver = {
    winnerId: winner.id,
    winnerIdx,
    winnerName: winner.name,
    resultText: `${loser.name} declared — you win!`,
    scores: playerScores,
    players: room.players.map((p) => p.name),
  };
  room.lastGameOver = gameOver;
  io.to(winner.id).emit('game_over', gameOver);
  rooms.delete(roomId);
}

// ─── Toss / bat-bowl resolution (shared by socket handlers and the bot driver) ──

/** Resolve the toss for the current caller's call, then advance to bat/bowl. */
export function applyTossCall(
  io: GameServer,
  roomId: string,
  room: Room,
  rooms: Map<string, Room>,
  call: TossCall
): void {
  if (room.phase !== 'toss_call' || !room.tossCallerId) return;
  room.tossCall = call;
  const result: TossCall = Math.random() < 0.5 ? 'heads' : 'tails';
  const callerId = room.tossCallerId;
  const won = result === call;
  room.tossWinnerId = won ? callerId : room.players.find((p) => p.id !== callerId)!.id;
  room.phase = 'bat_bowl';

  io.to(roomId).emit('toss_result', {
    call,
    result,
    winnerId: room.tossWinnerId,
    winnerName: room.players.find((p) => p.id === room.tossWinnerId)!.name,
  });
  io.to(roomId).emit('state', publicState(room, roomId));
  if (room.hasBot) driveBots(io, roomId, room, rooms);
}

/** Apply the toss winner's bat/bowl choice and start the first innings. */
export function applyBatBowlChoice(
  io: GameServer,
  roomId: string,
  room: Room,
  rooms: Map<string, Room>,
  choice: 'bat' | 'bowl'
): void {
  if (room.phase !== 'bat_bowl' || room.tossWinnerId === null) return;
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
  if (room.hasBot) driveBots(io, roomId, room, rooms);
}

// ─── Bot driver ────────────────────────────────────────────────────────────────

/** Still the same live room at this id? Guards against timers firing post-teardown. */
function roomAlive(rooms: Map<string, Room>, roomId: string, room: Room): boolean {
  return rooms.get(roomId) === room;
}

/**
 * Schedule whatever the bot(s) need to do next for the room's current phase:
 * call the toss, choose bat/bowl, or play the ball. Safe to call after any
 * state change — it only acts for bot slots that haven't acted yet.
 */
export function driveBots(
  io: GameServer,
  roomId: string,
  room: Room,
  rooms: Map<string, Room>
): void {
  if (!roomAlive(rooms, roomId, room)) return;

  if (room.phase === 'toss_call') {
    const caller = room.players.find((p) => p.id === room.tossCallerId);
    if (caller && isBot(caller)) {
      botTimer(() => {
        if (roomAlive(rooms, roomId, room) && room.phase === 'toss_call') {
          applyTossCall(io, roomId, room, rooms, Math.random() < 0.5 ? 'heads' : 'tails');
        }
      });
    }
    return;
  }

  if (room.phase === 'bat_bowl') {
    const winner = room.players.find((p) => p.id === room.tossWinnerId);
    if (winner && isBot(winner)) {
      botTimer(() => {
        if (roomAlive(rooms, roomId, room) && room.phase === 'bat_bowl') {
          applyBatBowlChoice(io, roomId, room, rooms, Math.random() < 0.5 ? 'bat' : 'bowl');
        }
      });
    }
    return;
  }

  if (room.phase === 'innings') {
    scheduleBotMove(io, roomId, room, rooms, room.batsmanIdx!);
    scheduleBotMove(io, roomId, room, rooms, room.bowlerIdx!);
  }
}

/** If the player at `idx` is a bot that hasn't submitted this ball, schedule it. */
function scheduleBotMove(
  io: GameServer,
  roomId: string,
  room: Room,
  rooms: Map<string, Room>,
  idx: number
): void {
  const player = room.players[idx];
  if (!isBot(player) || room.pendingMoves[player.id] !== undefined) return;
  botTimer(() => {
    if (!roomAlive(rooms, roomId, room) || room.phase !== 'innings') return;
    if (room.pendingMoves[player.id] !== undefined) return;
    room.pendingMoves[player.id] = pickBotMove(room, idx);

    const batMove = room.pendingMoves[batsmanId(room)];
    const bowlMove = room.pendingMoves[bowlerId(room)];
    if (batMove === undefined || bowlMove === undefined) return; // still waiting on the other side

    room.pendingMoves = {};
    resolveBall(io, roomId, room, rooms, batMove, bowlMove);
    // Bot-vs-bot: keep the match rolling. (Human games are driven by play_move.)
    if (roomAlive(rooms, roomId, room) && room.phase === 'innings' && room.players.every(isBot)) {
      driveBots(io, roomId, room, rooms);
    }
  });
}

export function startRematch(
  io: GameServer,
  roomId: string,
  room: Room,
  rooms: Map<string, Room>
): void {
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
  room.botMoveCounts = {};

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
  if (room.hasBot) driveBots(io, roomId, room, rooms);
}
