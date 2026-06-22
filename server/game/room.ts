import type { GameState, Phase, TossCall, GameOverPayload } from '@cric/types';

export interface RoomPlayer {
  id: string;
  name: string;
  userId: string | null;
  /** Stable per-browser id; used to rejoin guests, who have no userId. */
  clientId?: string | null;
  /** A computer-controlled player — the server drives its toss/choice/moves. */
  isBot?: boolean;
  /** A bot's personality label (e.g. "Aggressive"); biases its play on top of the
   *  shared adaptive brain. Stored as the label so publicState can pass it through. */
  botStyle?: string;
}

export interface BallLog {
  batMove: number;
  bowlMove: number;
  scored: number;
  isOut: boolean;
}

export interface RoomInnings {
  score: number;
  balls: number;
  isOut: boolean;
  wicketsLost: number;
  moves: number[];
  /** Ball-by-ball record for building the scorecard. */
  log: BallLog[];
}

export interface Room {
  players: RoomPlayer[];
  overs: number;
  wickets: number;
  phase: Phase;
  tossCallerId: string | null;
  tossCall: TossCall | null;
  tossWinnerId: string | null;
  batsmanIdx: number | null;
  bowlerIdx: number | null;
  /** Toss winner's name and what they elected, captured once for spectator/scorecard display. */
  tossWinnerName?: string;
  tossDecision?: 'bat' | 'bowl';
  innings: [RoomInnings, RoomInnings];
  currentInnings: number;
  pendingMoves: Record<string, number>;
  rematchRequests?: Set<number> | null;
  _graceTimers?: Record<string, NodeJS.Timeout>;
  mlLastMoves?: Record<string, number>;
  tournamentId?: string;
  tournamentMatchIdx?: number;
  /** Set when at least one player is a bot — enables bot driving + move tracking. */
  hasBot?: boolean;
  /** Set for a Quick Match (random-pair) casual game — awards coins on completion. */
  isQuickMatch?: boolean;
  /** Per-player-index frequency of each number played, for bot adaptation. */
  botMoveCounts?: Record<number, number[]>;
  /** Per-player-index live "brain" state a bot carries through the match:
   *  its recent moves, a momentum/confidence value, balls seen, and (for the
   *  Chaos style) a transient sub-style it has temporarily adopted. */
  botBrain?: Record<
    number,
    {
      recent: number[];
      momentum: number;
      ballsSeen: number;
      mode: { aggression: number; volatility: number; until: number } | null;
    }
  >;
  /** The final result, kept so a player who reconnects after the game ended
   *  (e.g. a blip on the last ball) is shown the result instead of a dead screen. */
  lastGameOver?: GameOverPayload;
  /** Human finalist socket ids we're waiting on to tap "Start the Final" before
   *  the bot opponent begins; cleared once everyone's ready (or a fallback fires). */
  finalAwaiting?: Set<string>;
  _finalStartTimer?: NodeJS.Timeout;
  /** Knockout Super Over attempt counter (0/undefined = main match). */
  superOver?: number;
}

export function makeRoomId(used?: { has(id: string): boolean }): string {
  let id: string;
  do {
    id = Math.random().toString(36).substring(2, 7).toUpperCase();
  } while (used?.has(id));
  return id;
}

/** Normalise a client-supplied display name: trim, cap length, fall back. */
export function cleanName(name: unknown): string {
  return (typeof name === 'string' ? name.trim() : '').slice(0, 20) || 'Player';
}

/**
 * Coerce a client-supplied over/wicket count to a sane integer in [1, max].
 * Without this a crafted client could request, e.g., overs=1e9 and create a
 * game that never ends. `max` matches the largest value the UI offers (10).
 */
export function clampCount(value: unknown, fallback: number, max = 10): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function freshInnings(): RoomInnings {
  return { score: 0, balls: 0, isOut: false, wicketsLost: 0, moves: [], log: [] };
}

export function createRoom(overs: number, wickets: number): Room {
  return {
    players: [],
    overs,
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

export function totalBalls(room: Room): number {
  return room.overs * 6;
}

export function batsmanId(room: Room): string {
  return room.players[room.batsmanIdx!].id;
}

export function bowlerId(room: Room): string {
  return room.players[room.bowlerIdx!].id;
}

/**
 * A player's in-room identity is their socket.id, which changes on reconnect.
 * Every field that stores it must be remapped together — missing one (the toss
 * caller/winner, an in-flight move) silently breaks gating for the reconnected
 * player and can freeze the match. Centralised so new socket-id fields are
 * remapped in one place rather than re-introducing the bug at each call site.
 */
export function remapSocketId(room: Room, oldId: string, newId: string): void {
  if (oldId === newId) return;
  const player = room.players.find((p) => p.id === oldId);
  if (player) player.id = newId;
  if (room.tossCallerId === oldId) room.tossCallerId = newId;
  if (room.tossWinnerId === oldId) room.tossWinnerId = newId;
  if (room.pendingMoves[oldId] !== undefined) {
    room.pendingMoves[newId] = room.pendingMoves[oldId];
    delete room.pendingMoves[oldId];
  }
  if (room._graceTimers?.[oldId]) {
    clearTimeout(room._graceTimers[oldId]);
    delete room._graceTimers[oldId];
  }
}

export function publicState(room: Room, roomId: string): GameState {
  const inn = room.innings[room.currentInnings];
  const target = room.currentInnings === 1 ? room.innings[0].score + 1 : null;
  return {
    roomId,
    phase: room.phase,
    players: room.players.map((p) => p.name),
    playerIds: room.players.map((p) => p.userId),
    overs: room.overs,
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
    innings: room.innings.map((i) => ({
      score: i.score,
      balls: i.balls,
      isOut: i.isOut,
      wicketsLost: i.wicketsLost,
    })),
    superOver: room.superOver ?? 0,
  };
}
