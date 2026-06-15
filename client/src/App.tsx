import { useState, useEffect, useRef } from 'react';
import { socket, getClientId } from './socket';
import { apiGet } from './api';
import AuthScreen from './auth/AuthScreen';
import FriendsPanel from './friends/FriendsPanel';
import Lobby from './lobby/Lobby';
import TossScreen from './toss/TossScreen';
import BatBowlScreen from './game/BatBowlScreen';
import GameScreen from './game/GameScreen';
import ResultScreen from './result/ResultScreen';
import InningsEndOverlay from './game/InningsEndOverlay';
import TournamentLobby from './tournament/TournamentLobby';
import TournamentResult from './tournament/TournamentResult';
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
import './App.css';

type TrainEvent = { move: number; role: OppRole; seq: number };

const STORED_KEY = 'cric_user';

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
  const [incomingChallenge, setIncomingChallenge] = useState<ChallengeReceivedPayload | null>(null);
  const [rematchState, setRematchState] = useState<RematchState>(null);
  const [tournamentState, setTournamentState] = useState<TournamentState | null>(null);
  const [isTournamentMatch, setIsTournamentMatch] = useState(false);
  const isTournamentMatchRef = useRef(false);
  const [isAutoPlay, setIsAutoPlay] = useState(false);
  // Opponent-move feed for ML training. Captured at ball_played from pre-swap
  // refs and never nulled mid-match, so GameScreen trains on every ball
  // (including the innings-ending one) regardless of React's event batching.
  const [trainEvent, setTrainEvent] = useState<TrainEvent | null>(null);

  const bound = useRef(false);
  const roomIdRef = useRef<string | null>(null);
  const tournamentCodeRef = useRef<string | null>(null);
  const userRef = useRef<ClientUser | null>(null);
  const gameStateRef = useRef<GameState | null>(null);
  const myPlayerIdxRef = useRef<number | null>(null);
  const trainSeqRef = useRef(0);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    tournamentCodeRef.current = tournamentState?.code ?? null;
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

    // ── Bind all socket listeners once ──────────────────────────────────────
    socket.on('connect', () => {
      setMyId(socket.id ?? null);
      // An active match room takes priority: rejoin_room restores the live game
      // AND re-syncs tournament identity (it remaps the tournament socket id and
      // emits tournament_state, which preserves the match phase). We must NOT
      // also emit join_tournament here — its reconnection path re-emits
      // tournament_created, which forces the client to 'tournament_lobby' and
      // ejects the player from the live match screen mid-game.
      if (roomIdRef.current) {
        socket.emit('rejoin_room', { roomId: roomIdRef.current });
      } else if (tournamentCodeRef.current) {
        // No active match room (between matches / spectating): re-sync tournament
        // identity. The server remaps by userId or the stable clientId, so guests
        // recover too. playerName is unused on the reconnection path (it only
        // matters for a fresh join).
        socket.emit('join_tournament', {
          code: tournamentCodeRef.current,
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

    socket.on('state', (state) => setGameState(state));

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
      setTimeout(() => setPhase((p) => (p === 'toss_call' ? 'bat_bowl' : p)), 2500);
    });

    socket.on('innings_start', (info) => {
      setInningsInfo(info);
      setLastBall(null);
      setPhase('innings');
    });

    socket.on('ball_played', (data) => {
      setLastBall(data);
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

    socket.on('innings_end', (data) => {
      setInningsEnd(data);
      setTimeout(() => setInningsEnd(null), 5000);
    });

    socket.on('game_over', (data) => {
      setGameOver(data);
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
      setPhase('tournament_lobby');
    });

    socket.on('tournament_state', (state) => {
      setTournamentState(state);
      if (state.phase === 'complete') setPhase('tournament_result');
      else setPhase((p) => (p === 'lobby' ? 'tournament_lobby' : p));
    });

    socket.on('tournament_match_starting', ({ roomId: rid, myPlayerIdx: pidx }) => {
      setRoomId(rid);
      setMyPlayerIdx(pidx);
      isTournamentMatchRef.current = true;
      setIsTournamentMatch(true);
      // phase transitions via incoming toss_start
    });

    socket.on('tournament_complete', () => {
      setPhase('tournament_result');
    });

    // ── Restore stored session ───────────────────────────────────────────────
    const stored = JSON.parse(localStorage.getItem(STORED_KEY) || 'null');
    if (stored?.token) {
      apiGet('/api/me', stored.token)
        .then((data) => {
          const restored: ClientUser = { ...stored, stats: data.stats };
          setUser(restored);
          socket.auth = { token: stored.token, clientId: getClientId() };
          socket.connect();
          setPhase('lobby');
        })
        .catch(() => {
          localStorage.removeItem(STORED_KEY);
          setPhase('auth');
        });
    } else {
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
            <div className="user-chip">
              <span className="user-avatar">{user.username[0].toUpperCase()}</span>
              <span className="user-chip-name">{user.username}</span>
            </div>
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
          onBackToTournament={resetToTournamentLobby}
        />
      )}

      {phase === 'tournament_lobby' && tournamentState && (
        <TournamentLobby tournamentState={tournamentState} myId={myId} onLeave={resetToLobby} />
      )}

      {phase === 'tournament_result' && tournamentState && (
        <TournamentResult tournamentState={tournamentState} myId={myId} onLeave={resetToLobby} />
      )}
    </div>
  );
}
