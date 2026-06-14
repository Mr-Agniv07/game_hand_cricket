import type { GameState, Mode, Phase, TossCall } from '@cric/types';

export interface RoomPlayer {
  id: string;
  name: string;
  userId: string | null;
}

export interface RoomInnings {
  score: number;
  balls: number;
  isOut: boolean;
  wicketsLost: number;
  moves: number[];
}

export interface Room {
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
  tournamentId?: string;
  tournamentMatchIdx?: number;
}

export function makeRoomId(): string {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

export function freshInnings(): RoomInnings {
  return { score: 0, balls: 0, isOut: false, wicketsLost: 0, moves: [] };
}

export function createRoom(overs: number, mode: Mode, wickets: number): Room {
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

export function totalBalls(room: Room): number {
  return room.overs * 6;
}

export function batsmanId(room: Room): string {
  return room.players[room.batsmanIdx!].id;
}

export function bowlerId(room: Room): string {
  return room.players[room.bowlerIdx!].id;
}

export function publicState(room: Room, roomId: string): GameState {
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
