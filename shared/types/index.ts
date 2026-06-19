// Shared contract between the Cric Flick server and client.
// Type-only: every consumer imports these via `import type`, so nothing here is
// ever loaded at runtime — it exists purely to type the socket/API payloads once.

// ─── Core domain ────────────────────────────────────────────────────────────

export type Phase = 'waiting' | 'toss_call' | 'bat_bowl' | 'innings' | 'result';
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
  /** Registered user id per player slot, or null for guests. Aligns with `players`. */
  playerIds: (string | null)[];
  overs: number;
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
  /** >0 when this is a knockout Super Over (the Nth attempt); 0/undefined otherwise. */
  superOver?: number;
}

// ─── Auth / user ────────────────────────────────────────────────────────────

export interface UserStats {
  gamesPlayed: number;
  wins: number;
  losses: number;
  ties: number;
  runsScored: number;
  highScore: number;
  /** Total wickets taken while bowling (across all matches). */
  wicketsTaken: number;
  /** Total boundaries hit while batting (fours + fives + sixes). */
  boundaries: number;
  /** Total balls bowled — denominator for economy. */
  ballsBowled: number;
  /** Total runs conceded while bowling — numerator for economy. */
  runsConceded: number;
}

/** One row of the global leaderboard. Derived metrics (ratio, economy) are computed client-side. */
export interface LeaderboardEntry {
  id: string;
  username: string;
  stats: UserStats;
}

/**
 * Career honours a player has accumulated — the personal "hall of fame".
 * All are tournament-derived (the only matches that count toward records/badges).
 */
export interface UserAchievements {
  tournamentsPlayed: number;
  tournamentsWon: number;
  orangeCaps: number;
  purpleCaps: number;
  mostSixesAwards: number;
  playerOfTournament: number;
}

/** A single global record holder (e.g. the highest total in 2-over games). */
export interface GameRecord {
  /** Balls for fastest-50/100; runs for highest/lowest total. */
  value: number;
  holderName: string;
  /** Registered user's id, or null for a bot/guest holder (won't show on a personal page). */
  holderId: string | null;
  overs: number;
  wickets: number;
  date: string;
}

/** The four records tracked within one overs bucket. */
export interface OversRecords {
  fastest50: GameRecord | null;
  fastest100: GameRecord | null;
  highestTotal: GameRecord | null;
  lowestTotal: GameRecord | null;
}

/** Global records, bucketed by overs count ("1" | "2" | "3" | "5" | "10"). */
export interface GlobalRecords {
  byOvers: Record<string, OversRecords>;
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
  stats: UserStats;
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
  overs: number;
  wickets: number;
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

export type InningsEndReason = 'out' | 'all_out' | 'overs_complete' | 'target_reached';

export interface InningsEndPayload {
  inningsNumber: number;
  score: number;
  reason: InningsEndReason;
}

// ─── Scorecard ───────────────────────────────────────────────────────────────

export interface FallOfWicket {
  wicket: number;
  score: number;
  ball: number;
}

export interface InningsScorecard {
  batter: string;
  bowler: string;
  runs: number;
  balls: number;
  wickets: number;
  fours: number;
  fives: number;
  sixes: number;
  fallOfWickets: FallOfWicket[];
  /** Runs scored in each over (index 0 = over 1). */
  perOver: number[];
}

export interface MatchScorecard {
  innings: InningsScorecard[];
}

export interface GameOverPayload {
  winnerId: string | null;
  /** Winner's index in `players`/`scores`, or null on a tie. Stable across reconnects. */
  winnerIdx: number | null;
  winnerName: string | null;
  resultText: string;
  scores: number[];
  players: string[];
  scorecard?: MatchScorecard;
}

export interface ChallengeReceivedPayload {
  challengeId: string;
  from: { id: string; username: string };
  overs: number;
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

// ─── Tournament ──────────────────────────────────────────────────────────────

export type TournamentPhase = 'waiting' | 'in_progress' | 'complete';
export type FixtureStatus = 'upcoming' | 'live' | 'done';

export interface TournamentPlayer {
  id: string;
  name: string;
}

export type FixtureStage = 'group' | 'semi' | 'final';

export interface FixtureMatch {
  matchNum: number;
  player1Idx: number;
  player2Idx: number;
  status: FixtureStatus;
  result: 'p1' | 'p2' | 'tie' | null;
  p1Score: number;
  p2Score: number;
  /** The playoff decider. */
  isFinal?: boolean;
  /** Which stage this fixture belongs to. */
  stage?: FixtureStage;
  /** Group label for group-stage matches in multi-group (8-player) tournaments. */
  group?: 'A' | 'B';
  /** Display label for knockout matches, e.g. "Semi Final 1". */
  label?: string;
  /** True if a tied knockout was decided by a Super Over. */
  superOver?: boolean;
  /** Per-match scorecard, available once the match is done. */
  scorecard?: MatchScorecard;
}

export interface PointsTableEntry {
  played: number;
  won: number;
  lost: number;
  tied: number;
  points: number;
  runsScored: number;
  ballsFaced: number;
  runsConceded: number;
  ballsBowled: number;
  nrr: number;
}

export interface LiveMatchScore {
  batsmanName: string;
  bowlerName: string;
  score: number;
  balls: number;
  overs: number;
  wicketsLost: number;
  wickets: number;
  target: number | null;
  currentInnings: number;
  lastBall: { scored: number; isOut: boolean; batsmanMove: number; bowlerMove: number } | null;
}

export interface TournamentAwards {
  /** Most total runs across the tournament. */
  orangeCap: { name: string; runs: number } | null;
  /** Most sixes across the tournament (null if nobody hit one). */
  mostSixes: { name: string; sixes: number } | null;
  /** Most wickets taken across the tournament (null if nobody took one). */
  purpleCap: { name: string; wickets: number } | null;
  /** Best overall impact (runs + sixes + wickets). */
  playerOfTournament: { name: string; runs: number; sixes: number; wickets: number } | null;
}

export interface TournamentState {
  id: string;
  code: string;
  overs: number;
  wickets: number;
  /** Number of players: 4 (single group) or 8 (two groups). */
  size: number;
  /** Player-index arrays per group; e.g. [[0,2,5,7],[1,3,4,6]] for 8 players. Empty until assigned. */
  groups: number[][];
  players: TournamentPlayer[];
  phase: TournamentPhase;
  fixtures: FixtureMatch[];
  currentMatchIndex: number;
  pointsTable: Record<string, PointsTableEntry>;
  liveScore: LiveMatchScore | null;
  /** Final winner's player id once the final is decided; null until then. */
  champion?: string | null;
  /** Batting awards, computed when the tournament completes. */
  awards?: TournamentAwards | null;
}

export interface TournamentMatchStartingPayload {
  roomId: string;
  opponentName: string;
  matchNum: number;
  myPlayerIdx: number;
  /** This is the playoff final — the client shows a GRAND FINALE intro first. */
  isFinal?: boolean;
}

export interface TournamentCompletePayload {
  players: TournamentPlayer[];
  pointsTable: Record<string, PointsTableEntry>;
}

export interface CreateTournamentPayload {
  playerName: string;
  overs: number;
  wickets: number;
  /** 4 (single group + final) or 8 (two groups + semis + final). Defaults to 4. */
  size?: number;
}

export interface JoinTournamentPayload {
  code: string;
  playerName: string;
}

// ─── Socket event maps ───────────────────────────────────────────────────────

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
  super_over: (p: { attempt: number }) => void;
  challenge_received: (p: ChallengeReceivedPayload) => void;
  challenge_room_start: (p: ChallengeRoomStartPayload) => void;
  challenge_expired: (p: ChallengeExpiredPayload) => void;
  challenge_declined: (p: ChallengeDeclinedPayload) => void;
  challenge_error: (p: ChallengeErrorPayload) => void;
  rematch_requested: (p: RematchRequestedPayload) => void;
  rematch_start: (p: RematchStartPayload) => void;
  opponent_disconnected: (p: OpponentDisconnectedPayload) => void;
  error: (p: ErrorPayload) => void;
  tournament_created: (p: TournamentState) => void;
  tournament_state: (p: TournamentState) => void;
  tournament_match_starting: (p: TournamentMatchStartingPayload) => void;
  tournament_complete: (p: TournamentCompletePayload) => void;
}

// ─── Client → server event payloads ─────────────────────────────────────────

export interface CreateRoomPayload {
  playerName: string;
  overs: number | string;
  wickets: number | string;
}

export interface PlayVsBotPayload {
  playerName: string;
  overs: number | string;
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
  wickets: number | string;
}

export interface RespondChallengePayload {
  challengeId: string;
  accept: boolean;
}

export interface RejoinRoomPayload {
  roomId: string;
}

export interface ClientToServerEvents {
  create_room: (p: CreateRoomPayload) => void;
  play_vs_bot: (p: PlayVsBotPayload) => void;
  join_room: (p: JoinRoomPayload) => void;
  rejoin_room: (p: RejoinRoomPayload) => void;
  leave_room: () => void;
  toss_call: (p: TossCallPayload) => void;
  bat_bowl_choice: (p: BatBowlChoicePayload) => void;
  play_move: (p: PlayMovePayload) => void;
  declare: () => void;
  final_ready: () => void;
  send_challenge: (p: SendChallengePayload) => void;
  respond_challenge: (p: RespondChallengePayload) => void;
  request_rematch: () => void;
  create_tournament: (p: CreateTournamentPayload) => void;
  join_tournament: (p: JoinTournamentPayload) => void;
  start_tournament_with_bots: () => void;
}
