// Shared contract between the Cric Flick server and client.
// Type-only: every consumer imports these via `import type`, so nothing here is
// ever loaded at runtime — it exists purely to type the socket/API payloads once.

// ─── Core domain ────────────────────────────────────────────────────────────

export type Phase = 'waiting' | 'toss_call' | 'bat_bowl' | 'innings' | 'result';
export type Mode = 'overs' | 'wickets';
export type TossCall = 'heads' | 'tails';
export type BatBowlChoice = 'bat' | 'bowl';

/** Per-innings summary as exposed to clients (no raw moves). */
export interface InningsSummary {
  score: number;
  balls: number;
  isOut: boolean;
  wicketsLost: number;
}

/** Authoritative game snapshot — the payload of every `state` event. */
export interface GameState {
  roomId: string;
  phase: Phase;
  players: string[];
  overs: number;
  mode: Mode;
  wickets: number;
  currentInnings: number;
  score: number;
  balls: number;
  wicketsLost: number;
  target: number | null;
  batsmanIdx: number | null;
  bowlerIdx: number | null;
  tossCallerId: string | null;
  tossWinnerId: string | null;
  innings: InningsSummary[];
}

// ─── Auth / user ────────────────────────────────────────────────────────────

export interface UserStats {
  gamesPlayed: number;
  wins: number;
  losses: number;
  ties: number;
  runsScored: number;
  highScore: number;
}

export interface AuthResponse {
  id: string;
  username: string;
  token: string;
  stats: UserStats;
}

export interface PublicUser {
  id: string;
  username: string;
  stats?: UserStats;
}

export interface Friend extends PublicUser {
  online: boolean;
}

export interface SearchResult extends PublicUser {
  isFriend: boolean;
  online: boolean;
}

export type MatchResult = 'win' | 'loss' | 'tie';

export interface MatchHistoryEntry {
  opponent: string;
  result: MatchResult;
  myScore: number;
  oppScore: number;
  mode: Mode;
  count: number;
  date: string;
}

// ─── Server → client event payloads ─────────────────────────────────────────

export interface RoomCreatedPayload {
  roomId: string;
}

export interface TossStartPayload {
  callerId: string;
  callerName: string;
}

export interface TossResultPayload {
  call: TossCall;
  result: TossCall;
  winnerId: string;
  winnerName: string;
}

export interface InningsStartPayload {
  inningsNumber: number;
  batsmanName: string;
  bowlerName: string;
  target: number | null;
}

export interface BallPlayedPayload {
  batsmanMove: number;
  bowlerMove: number;
  scored: number;
  isOut: boolean;
  wicketsLost?: number;
  score: number;
  balls: number;
}

export interface MoveReceivedPayload {
  number: number;
}

export type InningsEndReason =
  | 'out'
  | 'all_out'
  | 'overs_complete'
  | 'target_reached';

export interface InningsEndPayload {
  inningsNumber: number;
  score: number;
  reason: InningsEndReason;
}

export interface GameOverPayload {
  winnerId: string | null;
  winnerName: string | null;
  resultText: string;
  scores: number[];
  players: string[];
}

export interface ChallengeReceivedPayload {
  challengeId: string;
  from: { id: string; username: string };
  overs: number;
  mode: Mode;
  wickets: number;
}

export interface ChallengeRoomStartPayload {
  roomId: string;
  myPlayerIdx: number;
}

export interface ChallengeExpiredPayload {
  challengeId?: string;
}

export interface ChallengeDeclinedPayload {
  username: string;
}

export interface ChallengeErrorPayload {
  message: string;
}

export interface RematchRequestedPayload {
  from: string;
}

export interface RematchStartPayload {
  roomId: string;
  myPlayerIdx: number;
}

export interface OpponentDisconnectedPayload {
  name: string | undefined;
}

export interface ErrorPayload {
  message: string;
}

export interface ServerToClientEvents {
  room_created: (p: RoomCreatedPayload) => void;
  state: (p: GameState) => void;
  toss_start: (p: TossStartPayload) => void;
  toss_result: (p: TossResultPayload) => void;
  innings_start: (p: InningsStartPayload) => void;
  ball_played: (p: BallPlayedPayload) => void;
  move_received: (p: MoveReceivedPayload) => void;
  innings_end: (p: InningsEndPayload) => void;
  game_over: (p: GameOverPayload) => void;
  challenge_received: (p: ChallengeReceivedPayload) => void;
  challenge_room_start: (p: ChallengeRoomStartPayload) => void;
  challenge_expired: (p: ChallengeExpiredPayload) => void;
  challenge_declined: (p: ChallengeDeclinedPayload) => void;
  challenge_error: (p: ChallengeErrorPayload) => void;
  rematch_requested: (p: RematchRequestedPayload) => void;
  rematch_start: (p: RematchStartPayload) => void;
  opponent_disconnected: (p: OpponentDisconnectedPayload) => void;
  error: (p: ErrorPayload) => void;
}

// ─── Client → server event payloads ─────────────────────────────────────────

export interface CreateRoomPayload {
  playerName: string;
  overs: number | string;
  mode: Mode;
  wickets: number | string;
}

export interface JoinRoomPayload {
  roomId: string;
  playerName: string;
}

export interface TossCallPayload {
  call: TossCall;
}

export interface BatBowlChoicePayload {
  choice: BatBowlChoice;
}

export interface PlayMovePayload {
  number: number;
}

export interface SendChallengePayload {
  toUserId: string;
  overs: number | string;
  mode: Mode;
  wickets: number | string;
}

export interface RespondChallengePayload {
  challengeId: string;
  accept: boolean;
}

export interface ClientToServerEvents {
  create_room: (p: CreateRoomPayload) => void;
  join_room: (p: JoinRoomPayload) => void;
  toss_call: (p: TossCallPayload) => void;
  bat_bowl_choice: (p: BatBowlChoicePayload) => void;
  play_move: (p: PlayMovePayload) => void;
  send_challenge: (p: SendChallengePayload) => void;
  respond_challenge: (p: RespondChallengePayload) => void;
  request_rematch: () => void;
}
