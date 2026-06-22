import type { UserStats } from '@cric/types';

/** The logged-in user as the client holds it (token included). */
export interface ClientUser {
  id: string;
  username: string;
  token: string;
  stats: UserStats;
  coins: number;
  unlocks: string[];
}

/** The client's own screen state machine, driven by server events. */
export type AppPhase =
  | 'loading'
  | 'auth'
  | 'lobby'
  | 'tournament_lobby'
  | 'tournament_awards'
  | 'tournament_result'
  | 'waiting'
  | 'toss_call'
  | 'bat_bowl'
  | 'innings'
  | 'result';

export type RematchState = null | 'waiting' | 'opponent_wants';
