// Mirrors client/src/types.ts.
export type AppPhase =
  | 'loading'
  | 'auth'
  | 'lobby'
  | 'tournament_lobby'
  | 'tournament_result'
  | 'waiting'
  | 'toss_call'
  | 'bat_bowl'
  | 'innings'
  | 'result';

export type RematchState = null | 'waiting' | 'opponent_wants';
