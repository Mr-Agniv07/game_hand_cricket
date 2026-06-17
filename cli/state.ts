// The terminal equivalent of client/src/App.tsx: a single mutable state bag plus
// a set of socket listeners bound exactly once at startup that keep it in sync.
// Screens (screens/*.ts) read `state`, prompt for input, and emit socket events;
// they never compute game logic themselves — same rule as the web client.
import { EventEmitter } from 'node:events';
import type {
  GameState,
  TossStartPayload,
  TossResultPayload,
  InningsStartPayload,
  BallPlayedPayload,
  GameOverPayload,
  InningsEndPayload,
  ChallengeReceivedPayload,
  TournamentState,
  UserStats,
} from '@cric/types';
import type { AppPhase, RematchState } from './types.ts';
import { socket } from './socket.ts';
import { apiGet } from './api.ts';
import {
  getStoredUser,
  saveUser,
  clearUser,
  getActiveRoom,
  saveActiveRoom,
  clearActiveRoom,
  type StoredUser,
} from './storage.ts';

export interface AppUser extends StoredUser {
  stats: UserStats;
}

export interface AppState {
  phase: AppPhase;
  user: AppUser | null;
  myId: string | null;
  myPlayerIdx: number | null;
  roomId: string | null;
  gameState: GameState | null;
  tossInfo: TossStartPayload | null;
  tossResult: TossResultPayload | null;
  inningsInfo: InningsStartPayload | null;
  lastBall: BallPlayedPayload | null;
  /** Bumped on every ball_played so screens can detect "a new ball resolved". */
  ballSeq: number;
  gameOver: GameOverPayload | null;
  inningsEnd: InningsEndPayload | null;
  tournamentState: TournamentState | null;
  isTournamentMatch: boolean;
  /** True once a final's tournament_match_starting has arrived; the server holds
   *  the bot opponent until we emit final_ready (mirrors the tap-to-start overlay). */
  awaitingFinalReady: boolean;
  rematchState: RematchState;
  pendingChallenges: ChallengeReceivedPayload[];
  recovering: boolean;
}

export const state: AppState = {
  phase: 'loading',
  user: null,
  myId: null,
  myPlayerIdx: null,
  roomId: null,
  gameState: null,
  tossInfo: null,
  tossResult: null,
  inningsInfo: null,
  lastBall: null,
  ballSeq: 0,
  gameOver: null,
  inningsEnd: null,
  tournamentState: null,
  isTournamentMatch: false,
  awaitingFinalReady: false,
  rematchState: null,
  pendingChallenges: [],
  recovering: false,
};

// ── Tiny pub-sub so screens can `await` the next state change instead of polling ──
const events = new EventEmitter();
events.setMaxListeners(0);

export function setPhase(phase: AppPhase): void {
  state.phase = phase;
  events.emit('tick');
}

/** Resolves on the next state change of any kind (a "re-render" signal). */
export function waitForTick(): Promise<void> {
  return new Promise((resolve) => events.once('tick', resolve));
}

/** Blocks until `state.phase` is no longer `phase` — lets a screen emit an action
 *  and wait for the server-driven transition instead of racing the dispatch loop. */
export async function waitWhilePhase(phase: AppPhase): Promise<void> {
  while (state.phase === phase) await waitForTick();
}

function tick(): void {
  events.emit('tick');
}

// ── Room persistence (mirrors saveActiveRoom/clearActiveRoom in App.tsx) ──────
function persistRoom(): void {
  if (state.roomId) {
    saveActiveRoom({
      roomId: state.roomId,
      myPlayerIdx: state.myPlayerIdx,
      isTournamentMatch: state.isTournamentMatch,
    });
  } else {
    clearActiveRoom();
  }
}

export function setRoomId(roomId: string | null): void {
  state.roomId = roomId;
  persistRoom();
  tick();
}

export function setMyPlayerIdx(idx: number | null): void {
  state.myPlayerIdx = idx;
  persistRoom();
  tick();
}

// ── Reset helpers (mirror resetGameState/resetState/resetToLobby in App.tsx) ──
export function resetGameState(): void {
  state.gameState = null;
  state.tossInfo = null;
  state.tossResult = null;
  state.inningsInfo = null;
  state.lastBall = null;
  state.gameOver = null;
  state.inningsEnd = null;
  state.myPlayerIdx = null;
  state.rematchState = null;
  state.roomId = null;
  persistRoom();
}

export function resetState(): void {
  resetGameState();
  state.isTournamentMatch = false;
  state.tournamentState = null;
}

async function refreshStats(): Promise<void> {
  if (!state.user) return;
  try {
    const data = await apiGet<{ stats: UserStats }>('/api/me', state.user.token);
    state.user = { ...state.user, stats: data.stats };
  } catch {
    // ignore — stats just stay stale until next successful refresh
  }
}

export async function resetToLobby(): Promise<void> {
  if (state.roomId) socket.emit('leave_room');
  resetState();
  setPhase('lobby');
  await refreshStats();
  tick();
}

export function resetToTournamentLobby(): void {
  resetGameState();
  state.isTournamentMatch = false;
  setPhase('tournament_lobby');
}

// ── Global socket listeners — bound exactly once ───────────────────────────────
let bound = false;

export function bindSocketListeners(): void {
  if (bound) return;
  bound = true;

  socket.on('connect', () => {
    state.myId = socket.id ?? null;
    const room = getActiveRoom();
    if (room) {
      socket.emit('rejoin_room', { roomId: room.roomId });
    } else if (state.tournamentState?.code) {
      socket.emit('join_tournament', {
        code: state.tournamentState.code,
        playerName: state.user?.username ?? '',
      });
    }
    tick();
  });

  socket.on('connect_error', (err) => {
    console.warn('[socket] connect_error:', err.message);
  });

  socket.on('room_created', ({ roomId }) => {
    setRoomId(roomId);
    setMyPlayerIdx(0);
    setPhase('waiting');
  });

  socket.on('state', (snapshot) => {
    state.gameState = snapshot;
    setRoomId(snapshot.roomId);

    if (!state.recovering) {
      tick();
      return;
    }
    // First snapshot after a reconnect-driven rejoin: rebuild the screen since the
    // one-shot toss_start/innings_start events that normally drive this won't refire.
    state.recovering = false;
    const names = snapshot.players;
    const myIdx = state.myPlayerIdx;
    if (snapshot.phase === 'waiting') {
      setPhase('waiting');
    } else if (snapshot.phase === 'toss_call') {
      const iAmCaller = snapshot.tossCallerId === socket.id;
      const callerName =
        myIdx !== null ? (iAmCaller ? names[myIdx] : names[1 - myIdx]) : (names[0] ?? '');
      state.tossInfo = { callerId: snapshot.tossCallerId ?? '', callerName };
      setPhase('toss_call');
    } else if (snapshot.phase === 'bat_bowl') {
      setPhase('bat_bowl');
    } else if (
      snapshot.phase === 'innings' &&
      snapshot.batsmanIdx !== null &&
      snapshot.bowlerIdx !== null
    ) {
      state.inningsInfo = {
        inningsNumber: snapshot.currentInnings + 1,
        batsmanName: names[snapshot.batsmanIdx],
        bowlerName: names[snapshot.bowlerIdx],
        target: snapshot.target,
      };
      setPhase('innings');
    } else {
      clearActiveRoom();
      state.roomId = null;
      setPhase(state.user ? 'lobby' : 'auth');
    }
  });

  socket.on('toss_start', (info) => {
    state.tossInfo = info;
    state.tossResult = null;
    setPhase('toss_call');
  });

  socket.on('toss_result', (result) => {
    state.tossResult = result;
    console.log(
      `\nToss: called ${result.call}, landed ${result.result} — ${result.winnerName} won the toss!`
    );
    setTimeout(() => setPhase((state.phase === 'toss_call' ? 'bat_bowl' : state.phase) as AppPhase), 2500);
  });

  socket.on('innings_start', (info) => {
    state.inningsInfo = info;
    state.lastBall = null;
    console.log(
      `\nInnings ${info.inningsNumber}: ${info.batsmanName} batting, ${info.bowlerName} bowling.` +
        (info.target !== null ? ` Target: ${info.target}` : '')
    );
    setPhase('innings');
  });

  socket.on('ball_played', (data) => {
    state.lastBall = data;
    state.ballSeq += 1;
    if (data.isOut) {
      console.log(`OUT! (bat ${data.batsmanMove} = bowl ${data.bowlerMove}) — score ${data.score}/${data.balls} balls`);
    } else {
      console.log(
        `${data.scored} run${data.scored === 1 ? '' : 's'} (bat ${data.batsmanMove}, bowl ${data.bowlerMove}) — score ${data.score} after ${data.balls} balls`
      );
    }
    tick();
  });

  socket.on('move_received', () => {
    console.log('Move locked in. Waiting for opponent...');
  });

  socket.on('super_over', ({ attempt }) => {
    console.log(`\n🔥 SUPER OVER (attempt ${attempt}) — scores level, one over decides it!`);
    tick();
  });

  socket.on('innings_end', (data) => {
    state.inningsEnd = data;
    console.log(`\nInnings ${data.inningsNumber} over (${data.reason}): ${data.score} runs.`);
    tick();
  });

  socket.on('game_over', (data) => {
    state.gameOver = data;
    console.log(`\n${data.resultText}`);
    setPhase('result');
  });

  socket.on('challenge_received', (data) => {
    state.pendingChallenges.push(data);
    console.log(
      `\n⚡ ${data.from.username} challenged you! (${data.overs} overs, ${data.wickets} wickets) — see the lobby menu to respond.`
    );
    tick();
  });

  socket.on('challenge_room_start', ({ roomId, myPlayerIdx }) => {
    setRoomId(roomId);
    setMyPlayerIdx(myPlayerIdx);
  });

  socket.on('challenge_declined', ({ username }) => {
    console.log(`\n${username} declined your challenge.`);
    tick();
  });

  socket.on('challenge_expired', () => {
    console.log('\nChallenge expired (no response).');
    tick();
  });

  socket.on('challenge_error', ({ message }) => {
    console.log(`\nChallenge error: ${message}`);
    tick();
  });

  socket.on('rematch_requested', () => {
    state.rematchState = 'opponent_wants';
    console.log('\nOpponent wants a rematch!');
    tick();
  });

  socket.on('rematch_start', ({ roomId, myPlayerIdx }) => {
    state.gameOver = null;
    state.rematchState = null;
    setRoomId(roomId);
    setMyPlayerIdx(myPlayerIdx);
    // phase transitions via the incoming toss_start
  });

  socket.on('opponent_disconnected', ({ name }) => {
    console.log(`\n${name ?? 'Opponent'} disconnected. Game ended.`);
    setTimeout(() => {
      if (state.isTournamentMatch) resetToTournamentLobby();
      else void resetToLobby();
    }, 3000);
  });

  socket.on('error', ({ message }) => {
    console.log(`\n[error] ${message}`);
    tick();
  });

  socket.on('tournament_created', (t) => {
    state.tournamentState = t;
    setPhase('tournament_lobby');
  });

  socket.on('tournament_state', (t) => {
    state.tournamentState = t;
    if (t.phase === 'complete') {
      setPhase('tournament_result');
    } else if (state.phase === 'lobby') {
      setPhase('tournament_lobby');
    } else {
      tick();
    }
  });

  socket.on('tournament_match_starting', ({ roomId, myPlayerIdx, isFinal }) => {
    setRoomId(roomId);
    setMyPlayerIdx(myPlayerIdx);
    state.isTournamentMatch = true;
    if (isFinal) {
      console.log('\n🏆 GRAND FINALE — the top two face off for the title!');
      // The server holds the bot opponent until we emit final_ready; only the
      // finalist's tournamentLobbyScreen sees roomId set with no game in progress.
      state.awaitingFinalReady = true;
    }
    tick();
    // phase transitions via the incoming toss_start
  });

  socket.on('tournament_complete', () => {
    setPhase('tournament_result');
  });
}

// ── Boot: restore session/room from disk (mirrors App.tsx's recovery effect) ──
export interface RestoredSession {
  hasToken: boolean;
  hasActiveRoom: boolean;
}

export async function restoreSession(): Promise<RestoredSession> {
  const stored = getStoredUser();
  const room = getActiveRoom();

  if (room) {
    state.recovering = true;
    state.roomId = room.roomId;
    state.myPlayerIdx = room.myPlayerIdx;
    state.isTournamentMatch = room.isTournamentMatch;
  }

  if (stored?.token) {
    try {
      const data = await apiGet<{ stats: UserStats }>('/api/me', stored.token);
      state.user = { ...stored, stats: data.stats };
    } catch {
      clearUser();
      return { hasToken: false, hasActiveRoom: !!room };
    }
  }

  return { hasToken: !!stored?.token, hasActiveRoom: !!room };
}

export { saveUser, clearUser };
