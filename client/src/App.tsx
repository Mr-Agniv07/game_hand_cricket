import { useState, useEffect, useRef } from 'react';
import { socket, getClientId } from './socket';
import { apiGet } from './api';
import AuthScreen from './auth/AuthScreen';
import FriendsPanel from './friends/FriendsPanel';
import ProfilePanel from './profile/ProfilePanel';
import Lobby from './lobby/Lobby';
import TossScreen from './toss/TossScreen';
import BatBowlScreen from './game/BatBowlScreen';
import GameScreen from './game/GameScreen';
import ResultScreen from './result/ResultScreen';
import InningsEndOverlay from './game/InningsEndOverlay';
import TournamentLobby from './tournament/TournamentLobby';
import TournamentResult from './tournament/TournamentResult';
import AwardsCeremony, { wonAwardsFor } from './tournament/AwardsCeremony';
import type { CeremonyAward } from './tournament/AwardsCeremony';
import type {
  GameState,
  TossStartPayload,
  TossResultPayload,
  InningsStartPayload,
  BallPlayedPayload,
  GameOverPayload,
  InningsEndPayload,
  ChallengeReceivedPayload,
  AuthResponse,
  TournamentState,
} from '@cric/types';
import type { ClientUser, AppPhase, RematchState } from './types';
import type { OppRole } from './game/autoplayML';
import { sounds, initAudio, isMuted, toggleMute } from './sound';
import './App.css';

type TrainEvent = { move: number; role: OppRole; seq: number };

const STORED_KEY = 'cric_user';
// Remembers the room you're currently in so a full page refresh can rejoin the
// live match (the server matches you back by userId/clientId). Without this the
// reconnect machinery only survives transient blips, not actual reloads.
const STORED_ROOM_KEY = 'cric_active_room';

interface StoredRoom {
  roomId: string;
  myPlayerIdx: number | null;
  isTournamentMatch: boolean;
}

function saveActiveRoom(room: StoredRoom): void {
  try {
    localStorage.setItem(STORED_ROOM_KEY, JSON.stringify(room));
  } catch {
    // ignore storage failures (private mode etc.)
  }
}

function clearActiveRoom(): void {
  try {
    localStorage.removeItem(STORED_ROOM_KEY);
  } catch {
    // ignore
  }
}

// Remembers the tournament you're in so a full page refresh — even while waiting
// in the lobby between matches — can re-announce you (join_tournament) before
// your next match starts, instead of the server forfeiting you for being absent.
const STORED_TOURNAMENT_KEY = 'cric_active_tournament';
const TOURNAMENT_TTL_MS = 30 * 60_000; // ignore a stale code older than this

function saveTournamentCode(code: string): void {
  try {
    localStorage.setItem(STORED_TOURNAMENT_KEY, JSON.stringify({ code, ts: Date.now() }));
  } catch {
    // ignore storage failures
  }
}

function clearTournamentCode(): void {
  try {
    localStorage.removeItem(STORED_TOURNAMENT_KEY);
  } catch {
    // ignore
  }
}

/** The stored tournament code if still fresh, else null (and cleans up stale entries). */
function loadTournamentCode(): string | null {
  try {
    const raw = localStorage.getItem(STORED_TOURNAMENT_KEY);
    if (!raw) return null;
    const { code, ts } = JSON.parse(raw) as { code: string; ts: number };
    if (!code || Date.now() - ts > TOURNAMENT_TTL_MS) {
      clearTournamentCode();
      return null;
    }
    return code;
  } catch {
    return null;
  }
}

export default function App() {
  const [phase, setPhase] = useState<AppPhase>('loading');
  const [user, setUser] = useState<ClientUser | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [myPlayerIdx, setMyPlayerIdx] = useState<number | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [tossInfo, setTossInfo] = useState<TossStartPayload | null>(null);
  const [tossResult, setTossResult] = useState<TossResultPayload | null>(null);
  const [inningsInfo, setInningsInfo] = useState<InningsStartPayload | null>(null);
  const [lastBall, setLastBall] = useState<BallPlayedPayload | null>(null);
  const [gameOver, setGameOver] = useState<GameOverPayload | null>(null);
  const [inningsEnd, setInningsEnd] = useState<InningsEndPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [incomingChallenge, setIncomingChallenge] = useState<ChallengeReceivedPayload | null>(null);
  const [rematchState, setRematchState] = useState<RematchState>(null);
  const [tournamentState, setTournamentState] = useState<TournamentState | null>(null);
  const [isTournamentMatch, setIsTournamentMatch] = useState(false);
  const isTournamentMatchRef = useRef(false);
  // True only while the current tournament match is the FINAL — used to suppress
  // the "next match starting…" notice on the result screen after the final.
  const [isFinalMatch, setIsFinalMatch] = useState(false);
  // Awards the local player won, shown in the ceremony between the final and the
  // tournament summary. Empty when they won none (ceremony is skipped).
  const [myAwards, setMyAwards] = useState<CeremonyAward[]>([]);
  const [isAutoPlay, setIsAutoPlay] = useState(false);
  // Stage-intro overlay: 'finalist' = tap-to-start GRAND FINALE (you're playing),
  // 'spectator' = brief timed GRAND FINALE (watching), 'knockouts' = brief timed
  // KNOCKOUTS bumper when the semis begin.
  const [grandFinale, setGrandFinale] = useState<
    null | 'finalist' | 'spectator' | 'knockouts' | 'superover'
  >(null);
  const [muted, setMuted] = useState(isMuted());
  // Opponent-move feed for ML training. Captured at ball_played from pre-swap
  // refs and never nulled mid-match, so GameScreen trains on every ball
  // (including the innings-ending one) regardless of React's event batching.
  const [trainEvent, setTrainEvent] = useState<TrainEvent | null>(null);

  const bound = useRef(false);
  // True while we're trying to restore a live match after a page refresh. The
  // first `state` to arrive reconstructs the phase, then this is cleared.
  const recovering = useRef(false);
  const roomIdRef = useRef<string | null>(null);
  const tournamentCodeRef = useRef<string | null>(null);
  const userRef = useRef<ClientUser | null>(null);
  const gameStateRef = useRef<GameState | null>(null);
  const myPlayerIdxRef = useRef<number | null>(null);
  const trainSeqRef = useRef(0);
  // Guards the champion fanfare so it plays at most once per tournament.
  const championCelebrated = useRef(false);
  // Guards the awards ceremony so completing (incl. reconnect re-emits) routes
  // through it only once per tournament.
  const awardsHandledRef = useRef(false);
  // Guards the spectator GRAND FINALE splash so it shows once per tournament.
  const grandFinaleShownRef = useRef(false);
  // Guards the KNOCKOUTS bumper so it shows once per tournament (when semis begin).
  const knockoutsShownRef = useRef(false);
  // Whether we've actually entered a room this session. Guards the persist effect
  // from clearing the saved room on the INITIAL mount (when roomId starts null) —
  // doing so would wipe localStorage before refresh-recovery gets to read it.
  const hasEnteredRoom = useRef(false);
  // Same idea for the tournament: guards the persist effect from clearing the
  // saved code on the initial mount (before refresh-recovery reads it).
  const hasEnteredTournament = useRef(false);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  // Persist (or clear) the active match room so a refresh can rejoin it.
  useEffect(() => {
    if (roomId) {
      console.log('[recover] saved active room', roomId, 'idx', myPlayerIdx);
      saveActiveRoom({ roomId, myPlayerIdx, isTournamentMatch });
      hasEnteredRoom.current = true;
    } else if (hasEnteredRoom.current) {
      // Only clear after we've genuinely been in (and left) a room — never on the
      // first mount, or we'd erase the room a refresh is trying to recover.
      console.log('[recover] cleared active room');
      clearActiveRoom();
    }
  }, [roomId, myPlayerIdx, isTournamentMatch]);

  useEffect(() => {
    const code = tournamentState?.code ?? null;
    tournamentCodeRef.current = code;
    // Persist while an active tournament is running; clear once it's complete or
    // we've left. Guarded so the initial mount (code null) can't wipe a saved
    // code before the connect handler gets to recover from it.
    if (code && tournamentState?.phase !== 'complete') {
      saveTournamentCode(code);
      hasEnteredTournament.current = true;
    } else if (hasEnteredTournament.current) {
      clearTournamentCode();
    }
  }, [tournamentState]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    myPlayerIdxRef.current = myPlayerIdx;
  }, [myPlayerIdx]);

  useEffect(() => {
    if (bound.current) return;
    bound.current = true;

    // Browsers keep the AudioContext suspended until a user gesture — unlock it
    // on the first interaction so game sounds can play.
    const unlock = () => initAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    // ── Bind all socket listeners once ──────────────────────────────────────
    socket.on('connect', () => {
      setMyId(socket.id ?? null);
      // An active match room takes priority: rejoin_room restores the live game
      // AND re-syncs tournament identity (it remaps the tournament socket id and
      // emits tournament_state, which preserves the match phase). We must NOT
      // also emit join_tournament here — its reconnection path re-emits
      // tournament_created, which forces the client to 'tournament_lobby' and
      // ejects the player from the live match screen mid-game.
      console.log('[recover] connected id=%s rejoinRoom=%s', socket.id, roomIdRef.current);
      // Fall back to the persisted code so a HARD REFRESH in the tournament lobby
      // (which wipes the in-memory ref) still re-announces us before our match.
      const tournamentCode = tournamentCodeRef.current ?? loadTournamentCode();
      if (roomIdRef.current) {
        socket.emit('rejoin_room', { roomId: roomIdRef.current });
      } else if (tournamentCode) {
        // No active match room (between matches / spectating): re-sync tournament
        // identity. The server remaps by userId or the stable clientId, so guests
        // recover too. playerName is unused on the reconnection path (it only
        // matters for a fresh join).
        socket.emit('join_tournament', {
          code: tournamentCode,
          playerName: userRef.current?.username ?? '',
        });
      }
    });

    // connect_error only ever signals a transport/network failure — the server
    // middleware never rejects a connection over a bad token (it just leaves
    // userId null). So leave the session intact and let socket.io retry;
    // a genuinely invalid token is handled by the /api/me 401 path below.
    socket.on('connect_error', (err) => {
      console.warn('socket connect_error:', err.message);
    });

    socket.on('room_created', ({ roomId }) => {
      setRoomId(roomId);
      setMyPlayerIdx(0);
      setPhase('waiting');
    });

    socket.on('state', (state) => {
      setGameState(state);
      // Sync roomId from the authoritative snapshot so EVERY player (including a
      // joiner, who otherwise never sets it) persists the active room and can
      // recover it on refresh.
      setRoomId(state.roomId);
      if (!recovering.current) return;
      // First snapshot after a refresh-driven rejoin: rebuild the screen from the
      // authoritative state, since the one-shot toss_start/innings_start events
      // that normally set these won't fire again.
      console.log('[recover] got state, rebuilding phase=%s', state.phase);
      recovering.current = false;
      const names = state.players;
      const myIdx = myPlayerIdxRef.current;
      if (state.phase === 'waiting') {
        setPhase('waiting');
      } else if (state.phase === 'toss_call') {
        const iAmCaller = state.tossCallerId === socket.id;
        const callerName =
          myIdx !== null ? (iAmCaller ? names[myIdx] : names[1 - myIdx]) : (names[0] ?? '');
        setTossInfo({ callerId: state.tossCallerId ?? '', callerName });
        setPhase('toss_call');
      } else if (state.phase === 'bat_bowl') {
        setPhase('bat_bowl');
      } else if (state.phase === 'innings' && state.batsmanIdx !== null && state.bowlerIdx !== null) {
        setInningsInfo({
          inningsNumber: state.currentInnings + 1,
          batsmanName: names[state.batsmanIdx],
          bowlerName: names[state.bowlerIdx],
          target: state.target,
        });
        setPhase('innings');
      } else {
        // 'result' (or an unexpected snapshot) isn't resumable without a
        // game_over payload — return to the lobby/auth.
        clearActiveRoom();
        roomIdRef.current = null;
        setRoomId(null);
        setPhase(userRef.current ? 'lobby' : 'auth');
      }
    });

    socket.on('toss_start', (info) => {
      setTossInfo(info);
      setTossResult(null);
      // Fresh match — drop any opponent-move feed left over from a prior game so
      // the next game's model starts clean. Toss always precedes the first ball.
      setTrainEvent(null);
      setPhase('toss_call');
    });

    socket.on('toss_result', (result) => {
      setTossResult(result);
      sounds.toss();
      setTimeout(() => setPhase((p) => (p === 'toss_call' ? 'bat_bowl' : p)), 2500);
    });

    socket.on('innings_start', (info) => {
      setInningsInfo(info);
      setLastBall(null);
      setPhase('innings');
    });

    socket.on('ball_played', (data) => {
      setLastBall(data);
      // Sound matches the outcome: wicket, boundary (4/6), or a normal run.
      if (data.isOut) sounds.out();
      else if (data.scored >= 4) sounds.boundary();
      else sounds.run();
      // Capture the opponent's move + role NOW, from refs holding the pre-swap
      // state, before innings_start/state coalesce and flip roles in the same
      // React commit. Feeds ML training in GameScreen via a value that's never
      // nulled, so the innings-ending ball isn't dropped and the role is right.
      const gs = gameStateRef.current;
      const myIdx = myPlayerIdxRef.current;
      if (gs && myIdx !== null && gs.batsmanIdx !== null) {
        const iAmBatsman = myIdx === gs.batsmanIdx;
        setTrainEvent({
          move: iAmBatsman ? data.bowlerMove : data.batsmanMove,
          role: iAmBatsman ? 'bowl' : 'bat',
          seq: ++trainSeqRef.current,
        });
      }
    });

    socket.on('super_over', () => {
      // A tied knockout — play on in a 1-over decider. innings_start follows.
      sounds.toss();
      setGrandFinale('superover');
      setTimeout(() => setGrandFinale((m) => (m === 'superover' ? null : m)), 2500);
    });

    socket.on('innings_end', (data) => {
      setInningsEnd(data);
      sounds.inningsEnd();
      setTimeout(() => setInningsEnd(null), 5000);
    });

    socket.on('game_over', (data) => {
      setGameOver(data);
      // Win/lose/tie jingle, keyed off the player index (stable across reconnects).
      if (data.winnerIdx === null) sounds.tie();
      else if (data.winnerIdx === myPlayerIdxRef.current) sounds.win();
      else sounds.lose();
      setPhase('result');
    });

    socket.on('challenge_received', (data) => setIncomingChallenge(data));

    socket.on('challenge_room_start', ({ roomId, myPlayerIdx }) => {
      setRoomId(roomId);
      setMyPlayerIdx(myPlayerIdx);
      setIncomingChallenge(null);
      setFriendsOpen(false);
    });

    socket.on('rematch_requested', () => setRematchState('opponent_wants'));

    socket.on('rematch_start', ({ roomId: rid, myPlayerIdx: pidx }) => {
      setGameOver(null);
      setRematchState(null);
      setRoomId(rid);
      setMyPlayerIdx(pidx);
      // phase transitions via incoming toss_start
    });

    socket.on('opponent_disconnected', ({ name }) => {
      setError(`${name} disconnected. Game ended.`);
      setTimeout(() => {
        if (isTournamentMatchRef.current) resetToTournamentLobby();
        else resetToLobby();
      }, 3000);
    });

    socket.on('error', ({ message }) => setError(message));

    socket.on('tournament_created', (state) => {
      setTournamentState(state);
      // tournament_created is also re-emitted on reconnect (join_tournament). Only
      // reset the per-tournament guards for a genuinely fresh tournament, so a
      // reconnect into a finished one still runs the awards ceremony / summary.
      if (state.phase === 'waiting') {
        championCelebrated.current = false;
        awardsHandledRef.current = false;
        grandFinaleShownRef.current = false;
        knockoutsShownRef.current = false;
        setMyAwards([]);
        setIsFinalMatch(false);
      }
      // Never yank a player back to the lobby from the post-tournament screens;
      // the follow-up tournament_state(complete) drives those.
      setPhase((p) => (p === 'tournament_result' || p === 'tournament_awards' ? p : 'tournament_lobby'));
    });

    socket.on('tournament_state', (state) => {
      setTournamentState(state);
      if (state.phase === 'complete') {
        // Crown the champion with a fanfare (once). champion is a socket id,
        // remapped on reconnect, so it matches our live socket.id if we won.
        if (!championCelebrated.current) {
          championCelebrated.current = true;
          if (state.champion && state.champion === socket.id) sounds.champion();
        }
        // Celebrate any awards the local player won BEFORE the summary card.
        // Re-emits (reconnects) skip the ceremony and land on the summary.
        if (!awardsHandledRef.current) {
          awardsHandledRef.current = true;
          const myName = state.players.find((p) => p.id === socket.id)?.name;
          // Match by display name OR username: socket.id can go stale after a
          // reconnect (common for an idle spectator during the final), but the
          // logged-in username is stable.
          const won = wonAwardsFor(state.awards, [myName, userRef.current?.username]);
          if (won.length > 0) {
            setMyAwards(won);
            setPhase('tournament_awards');
          } else {
            setPhase('tournament_result');
          }
        } else {
          setPhase('tournament_result');
        }
      } else {
        setPhase((p) => (p === 'lobby' ? 'tournament_lobby' : p));
        // KNOCKOUTS bumper for everyone the moment the semis are created
        // (group stage just ended), before the final's GRAND FINALE intro.
        if (!knockoutsShownRef.current && state.fixtures.some((f) => f.stage === 'semi')) {
          knockoutsShownRef.current = true;
          sounds.toss();
          setGrandFinale('knockouts');
          setTimeout(() => setGrandFinale((m) => (m === 'knockouts' ? null : m)), 2800);
        }
        // Spectators (watching from the lobby) get a brief GRAND FINALE splash
        // when the final goes live. Finalists get the tap-to-start version via
        // tournament_match_starting instead, so skip them here.
        const liveFix = state.fixtures[state.currentMatchIndex];
        if (liveFix?.isFinal && liveFix.status === 'live' && !grandFinaleShownRef.current) {
          grandFinaleShownRef.current = true;
          const amFinalist =
            state.players[liveFix.player1Idx]?.id === socket.id ||
            state.players[liveFix.player2Idx]?.id === socket.id;
          if (!amFinalist) {
            sounds.toss();
            setGrandFinale('spectator');
            setTimeout(() => setGrandFinale((m) => (m === 'spectator' ? null : m)), 3000);
          }
        }
      }
    });

    socket.on('tournament_match_starting', ({ roomId: rid, myPlayerIdx: pidx, isFinal }) => {
      setRoomId(rid);
      setMyPlayerIdx(pidx);
      isTournamentMatchRef.current = true;
      setIsTournamentMatch(true);
      setIsFinalMatch(!!isFinal);
      // Finalists get a tap-to-start GRAND FINALE intro before the toss; the
      // server holds a bot opponent until "Start the Final" is tapped.
      if (isFinal) {
        sounds.toss();
        grandFinaleShownRef.current = true; // we've handled the finale for this tournament
        setGrandFinale('finalist');
      }
      // phase transitions via incoming toss_start
    });

    socket.on('tournament_complete', () => {
      // tournament_state(complete) already routed us to the awards ceremony or
      // straight to the summary; don't yank an in-progress ceremony to the summary.
      setPhase((p) => (p === 'tournament_awards' ? p : 'tournament_result'));
    });

    const stored = JSON.parse(localStorage.getItem(STORED_KEY) || 'null');
    const storedRoom: StoredRoom | null = JSON.parse(
      localStorage.getItem(STORED_ROOM_KEY) || 'null'
    );
    const recoveringRoom = !!storedRoom?.roomId;
    console.log('[recover] on load storedRoom=', storedRoom, 'hasToken=', !!stored?.token);

    // ── Restore an in-progress match (page refresh) ──────────────────────────
    // Connect IMMEDIATELY (don't wait on /api/me) so the 'connect' handler emits
    // rejoin_room well inside the server's disconnect grace window. The server
    // matches us back by userId (logged in) or the stable clientId (guests),
    // then replies with `state` which rebuilds the UI.
    if (recoveringRoom && storedRoom) {
      recovering.current = true;
      roomIdRef.current = storedRoom.roomId;
      setRoomId(storedRoom.roomId);
      if (typeof storedRoom.myPlayerIdx === 'number') {
        myPlayerIdxRef.current = storedRoom.myPlayerIdx;
        setMyPlayerIdx(storedRoom.myPlayerIdx);
      }
      isTournamentMatchRef.current = !!storedRoom.isTournamentMatch;
      setIsTournamentMatch(!!storedRoom.isTournamentMatch);

      socket.auth = stored?.token
        ? { token: stored.token, clientId: getClientId() }
        : { clientId: getClientId() };
      socket.connect();

      // If the server has no such room anymore (game already ended/cleaned up),
      // no `state` arrives — recover after a short grace.
      setTimeout(() => {
        if (!recovering.current) return;
        recovering.current = false;
        clearActiveRoom();
        roomIdRef.current = null;
        setRoomId(null);
        // If we were in a tournament match, drop back into the TOURNAMENT (its
        // lobby/next match), not the home lobby — the match room may simply have
        // advanced to the next fixture.
        const tcode = tournamentCodeRef.current ?? loadTournamentCode();
        if (storedRoom.isTournamentMatch && tcode) {
          console.log('[recover] match room gone — re-entering tournament', tcode);
          socket.emit('join_tournament', {
            code: tcode,
            playerName: userRef.current?.username ?? '',
          });
        } else {
          console.log('[recover] fallback fired — no state arrived, going to lobby/auth');
          setPhase(userRef.current ? 'lobby' : 'auth');
        }
      }, 6000);
    }

    // ── Restore stored session ───────────────────────────────────────────────
    if (stored?.token) {
      apiGet('/api/me', stored.token)
        .then((data) => {
          const restored: ClientUser = { ...stored, stats: data.stats };
          setUser(restored);
          userRef.current = restored;
          // Not already connected for recovery → normal connect into the lobby.
          if (!recoveringRoom) {
            socket.auth = { token: stored.token, clientId: getClientId() };
            socket.connect();
            setPhase('lobby');
          }
        })
        .catch(() => {
          localStorage.removeItem(STORED_KEY);
          if (!recoveringRoom) setPhase('auth');
        });
    } else if (!recoveringRoom) {
      setPhase('auth');
    }
  }, []);

  function handleGuestPlay() {
    socket.auth = { clientId: getClientId() };
    if (!socket.connected) socket.connect();
    setPhase('lobby');
  }

  function handleAuthSuccess(data: AuthResponse) {
    const userData: ClientUser = {
      id: data.id,
      username: data.username,
      token: data.token,
      stats: data.stats,
    };
    setUser(userData);
    localStorage.setItem(
      STORED_KEY,
      JSON.stringify({ id: data.id, username: data.username, token: data.token })
    );
    socket.auth = { token: data.token, clientId: getClientId() };
    if (!socket.connected) socket.connect();
    setPhase('lobby');
  }

  function acceptChallenge() {
    if (!incomingChallenge) return;
    socket.emit('respond_challenge', { challengeId: incomingChallenge.challengeId, accept: true });
    setIncomingChallenge(null);
  }

  function declineChallenge() {
    if (!incomingChallenge) return;
    socket.emit('respond_challenge', { challengeId: incomingChallenge.challengeId, accept: false });
    setIncomingChallenge(null);
  }

  function handleLogout() {
    localStorage.removeItem(STORED_KEY);
    setUser(null);
    socket.disconnect();
    setPhase('auth');
    resetState();
  }

  function handleJoinRoom(code: string, playerName: string) {
    setMyPlayerIdx(1);
    socket.emit('join_room', { roomId: code, playerName });
  }

  function handleRematch() {
    socket.emit('request_rematch');
    setRematchState('waiting');
  }

  function resetGameState() {
    setRoomId(null);
    setGameState(null);
    setTossInfo(null);
    setTossResult(null);
    setInningsInfo(null);
    setLastBall(null);
    setGameOver(null);
    setInningsEnd(null);
    setError(null);
    setMyPlayerIdx(null);
    setRematchState(null);
    setIsAutoPlay(false);
    setTrainEvent(null);
  }

  function resetState() {
    resetGameState();
    isTournamentMatchRef.current = false;
    setIsTournamentMatch(false);
    setIsFinalMatch(false);
    setMyAwards([]);
    setTournamentState(null);
  }

  function resetToLobby() {
    // Tell the server we're done with this room so a finished game doesn't
    // linger in its in-memory map (no-op server-side for tournament rooms).
    if (roomIdRef.current) socket.emit('leave_room');
    resetState();
    setPhase('lobby');
    const stored = JSON.parse(localStorage.getItem(STORED_KEY) || 'null');
    if (stored?.token) {
      apiGet('/api/me', stored.token)
        .then((data) => setUser((u) => (u ? { ...u, stats: data.stats } : u)))
        .catch(() => {});
    }
  }

  function handleDeclare() {
    socket.emit('declare');
    resetToLobby();
  }

  function startFinal() {
    socket.emit('final_ready'); // releases a bot opponent to begin the toss
    setGrandFinale(null);
  }

  function resetToTournamentLobby() {
    resetGameState();
    isTournamentMatchRef.current = false;
    setIsTournamentMatch(false);
    setPhase('tournament_lobby');
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">🏏</span>
        <h1>Cric Flick</h1>
        {roomId &&
          phase !== 'lobby' &&
          phase !== 'tournament_lobby' &&
          phase !== 'tournament_result' && <span className="room-badge">Room: {roomId}</span>}
        {user?.username?.toLowerCase() === 'shreyansh' &&
          (phase === 'waiting' ||
            phase === 'toss_call' ||
            phase === 'bat_bowl' ||
            phase === 'innings') && (
            <button
              className={`autoplay-btn${isAutoPlay ? ' active' : ''}`}
              onClick={() => setIsAutoPlay((v) => !v)}
              title="Let computer play on your behalf"
            >
              🤖 {isAutoPlay ? 'Auto: ON' : 'Auto Play'}
            </button>
          )}
        {phase !== 'loading' && (
          <button
            className={`sound-btn${muted ? ' muted' : ''}`}
            onClick={() => {
              initAudio();
              setMuted(toggleMute());
            }}
            title={muted ? 'Unmute sounds' : 'Mute sounds'}
            aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
            style={user && phase !== 'auth' ? undefined : { marginLeft: 'auto' }}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        )}
        {user && phase !== 'auth' && phase !== 'loading' && (
          <div className="header-user">
            <button className="friends-toggle-btn" onClick={() => setFriendsOpen((o) => !o)}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <span className="friends-label">Friends</span>
            </button>
            <button
              className="user-chip"
              onClick={() => setProfileOpen(true)}
              title="View your profile"
            >
              <span className="user-avatar">{user.username[0].toUpperCase()}</span>
              <span className="user-chip-name">{user.username}</span>
            </button>
            <button className="logout-btn" onClick={handleLogout} title="Log out">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        )}
      </header>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {friendsOpen && user && (
        <FriendsPanel
          user={user}
          socket={socket}
          phase={phase}
          onClose={() => setFriendsOpen(false)}
        />
      )}

      {profileOpen && user && (
        <ProfilePanel user={user} onClose={() => setProfileOpen(false)} />
      )}

      {incomingChallenge && (
        <div className="overlay" style={{ zIndex: 60 }}>
          <div className="challenge-notify">
            <p className="cn-from">{incomingChallenge.from.username} challenged you!</p>
            <p className="cn-details">
              {incomingChallenge.overs} over{incomingChallenge.overs !== 1 ? 's' : ''} ·{' '}
              {incomingChallenge.wickets} wicket{incomingChallenge.wickets !== 1 ? 's' : ''}
            </p>
            <div className="cn-actions">
              <button className="cn-accept" onClick={acceptChallenge}>
                Accept
              </button>
              <button className="cn-decline" onClick={declineChallenge}>
                Decline
              </button>
            </div>
          </div>
        </div>
      )}

      {inningsEnd && <InningsEndOverlay data={inningsEnd} onDismiss={() => setInningsEnd(null)} />}

      {grandFinale && (
        <div className="grand-finale-overlay">
          <div className="gf-content">
            <div className="gf-trophy">
              {grandFinale === 'knockouts' ? '⚔️' : grandFinale === 'superover' ? '🔥' : '🏆'}
            </div>
            <div className="gf-title">
              {grandFinale === 'knockouts'
                ? 'KNOCKOUTS'
                : grandFinale === 'superover'
                  ? 'SUPER OVER'
                  : 'GRAND FINALE'}
            </div>
            <div className="gf-sub">
              {grandFinale === 'knockouts'
                ? 'Group stage done — semi-finals begin!'
                : grandFinale === 'superover'
                  ? 'Scores level — one over decides it!'
                  : grandFinale === 'finalist'
                    ? 'The top 2 face off for the title'
                    : 'The Final is underway'}
            </div>
            {grandFinale === 'finalist' && (
              <button className="gf-start-btn" onClick={startFinal}>
                Start the Final →
              </button>
            )}
          </div>
        </div>
      )}

      {phase === 'loading' && (
        <div className="center-screen">
          <div className="spinner" />
        </div>
      )}

      {phase === 'auth' && <AuthScreen onAuth={handleAuthSuccess} onGuest={handleGuestPlay} />}

      {phase === 'lobby' && (
        <Lobby
          socket={socket}
          onJoinRoom={handleJoinRoom}
          defaultName={user?.username ?? ''}
          user={user}
        />
      )}

      {phase === 'waiting' && (
        <div className="center-screen">
          <div className="waiting-card">
            <div className="spinner" />
            <h2>Waiting for opponent…</h2>
            <p>Share this code with your friend</p>
            <div className="room-code">{roomId}</div>
            <button className="cancel-room-btn" onClick={resetToLobby}>
              Cancel room
            </button>
          </div>
        </div>
      )}

      {phase === 'toss_call' && tossInfo && gameState && (
        <TossScreen
          socket={socket}
          myId={myId}
          gameState={gameState}
          tossInfo={tossInfo}
          tossResult={tossResult}
          isAutoPlay={isAutoPlay}
        />
      )}

      {phase === 'bat_bowl' && gameState && (
        <BatBowlScreen socket={socket} myId={myId} gameState={gameState} isAutoPlay={isAutoPlay} />
      )}

      {phase === 'innings' && gameState && inningsInfo && (
        <GameScreen
          socket={socket}
          myPlayerIdx={myPlayerIdx}
          gameState={gameState}
          lastBall={lastBall}
          trainEvent={trainEvent}
          isAutoPlay={isAutoPlay}
          userToken={user?.token ?? null}
          onDeclare={handleDeclare}
        />
      )}

      {phase === 'result' && gameOver && (
        <ResultScreen
          gameOver={gameOver}
          myPlayerIdx={myPlayerIdx}
          onPlayAgain={resetToLobby}
          onRematch={handleRematch}
          rematchState={rematchState}
          isTournamentMatch={isTournamentMatch}
          isFinalMatch={isFinalMatch}
          onBackToTournament={resetToTournamentLobby}
        />
      )}

      {phase === 'tournament_awards' && (
        <AwardsCeremony awards={myAwards} onDone={() => setPhase('tournament_result')} />
      )}

      {phase === 'tournament_lobby' && tournamentState && (
        <TournamentLobby
          tournamentState={tournamentState}
          myId={myId}
          onLeave={resetToLobby}
          onStartWithBots={() => socket.emit('start_tournament_with_bots')}
        />
      )}

      {phase === 'tournament_result' && tournamentState && (
        <TournamentResult tournamentState={tournamentState} myId={myId} onLeave={resetToLobby} />
      )}
    </div>
  );
}
