import { useState, useEffect, useRef } from 'react';
import { socket } from './socket';
import { apiGet } from './api';
import AuthScreen from './auth/AuthScreen';
import FriendsPanel from './friends/FriendsPanel';
import Lobby from './lobby/Lobby';
import TossScreen from './toss/TossScreen';
import BatBowlScreen from './game/BatBowlScreen';
import GameScreen from './game/GameScreen';
import ResultScreen from './result/ResultScreen';
import InningsEndOverlay from './game/InningsEndOverlay';
import TournamentLobby from './components/TournamentLobby';
import TournamentResult from './components/TournamentResult';
import type {
  GameState, TossStartPayload, TossResultPayload, InningsStartPayload,
  BallPlayedPayload, GameOverPayload, InningsEndPayload, ChallengeReceivedPayload,
  AuthResponse, TournamentState,
} from '@cric/types';
import type { ClientUser, AppPhase, RematchState } from './types';
import './App.css';

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

  const bound = useRef(false);

  useEffect(() => {
    if (bound.current) return;
    bound.current = true;

    // ── Bind all socket listeners once ──────────────────────────────────────
    socket.on('connect', () => setMyId(socket.id ?? null));

    socket.on('connect_error', () => {
      localStorage.removeItem(STORED_KEY);
      setUser(null);
      setPhase('auth');
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
      setPhase('toss_call');
    });

    socket.on('toss_result', (result) => {
      setTossResult(result);
      setTimeout(() => setPhase(p => (p === 'toss_call' ? 'bat_bowl' : p)), 2500);
    });

    socket.on('innings_start', (info) => {
      setInningsInfo(info);
      setLastBall(null);
      setPhase('innings');
    });

    socket.on('ball_played', (data) => setLastBall(data));

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
      else setPhase(p => p === 'lobby' ? 'tournament_lobby' : p);
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
        .then(data => {
          const restored: ClientUser = { ...stored, stats: data.stats };
          setUser(restored);
          socket.auth = { token: stored.token };
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
    socket.auth = {};
    if (!socket.connected) socket.connect();
    setPhase('lobby');
  }

  function handleAuthSuccess(data: AuthResponse) {
    const userData: ClientUser = { id: data.id, username: data.username, token: data.token, stats: data.stats };
    setUser(userData);
    localStorage.setItem(STORED_KEY, JSON.stringify({ id: data.id, username: data.username, token: data.token }));
    socket.auth = { token: data.token };
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
  }

  function resetState() {
    resetGameState();
    isTournamentMatchRef.current = false;
    setIsTournamentMatch(false);
    setTournamentState(null);
  }

  function resetToLobby() {
    resetState();
    setPhase('lobby');
    const stored = JSON.parse(localStorage.getItem(STORED_KEY) || 'null');
    if (stored?.token) {
      apiGet('/api/me', stored.token)
        .then(data => setUser(u => (u ? { ...u, stats: data.stats } : u)))
        .catch(() => {});
    }
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
        {roomId && phase !== 'lobby' && phase !== 'tournament_lobby' && phase !== 'tournament_result' && (
          <span className="room-badge">Room: {roomId}</span>
        )}
        {user && phase !== 'auth' && phase !== 'loading' && (
          <div className="header-user">
            <button className="friends-toggle-btn" onClick={() => setFriendsOpen(o => !o)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
              Friends
            </button>
            <div className="user-chip">
              <span className="user-avatar">{user.username[0].toUpperCase()}</span>
              <span className="user-chip-name">{user.username}</span>
            </div>
            <button className="logout-btn" onClick={handleLogout} title="Log out">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
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
              {incomingChallenge.mode === 'overs'
                ? `${incomingChallenge.overs} over${incomingChallenge.overs !== 1 ? 's' : ''}`
                : `${incomingChallenge.wickets} wicket${incomingChallenge.wickets !== 1 ? 's' : ''}`}
            </p>
            <div className="cn-actions">
              <button className="cn-accept" onClick={acceptChallenge}>Accept</button>
              <button className="cn-decline" onClick={declineChallenge}>Decline</button>
            </div>
          </div>
        </div>
      )}

      {inningsEnd && (
        <InningsEndOverlay
          data={inningsEnd}
          onDismiss={() => setInningsEnd(null)}
        />
      )}

      {phase === 'loading' && (
        <div className="center-screen">
          <div className="spinner" />
        </div>
      )}

      {phase === 'auth' && (
        <AuthScreen onAuth={handleAuthSuccess} onGuest={handleGuestPlay} />
      )}

      {phase === 'lobby' && (
        <Lobby socket={socket} onJoinRoom={handleJoinRoom} defaultName={user?.username ?? ''} user={user} />
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

      {phase === 'toss_call' && tossInfo && (
        <TossScreen
          socket={socket}
          myId={myId}
          tossInfo={tossInfo}
          tossResult={tossResult}
        />
      )}

      {phase === 'bat_bowl' && gameState && (
        <BatBowlScreen
          socket={socket}
          myId={myId}
          gameState={gameState}
        />
      )}

      {phase === 'innings' && gameState && inningsInfo && (
        <GameScreen
          socket={socket}
          myPlayerIdx={myPlayerIdx}
          gameState={gameState}
          inningsInfo={inningsInfo}
          lastBall={lastBall}
        />
      )}

      {phase === 'result' && gameOver && (
        <ResultScreen
          gameOver={gameOver}
          myId={myId}
          onPlayAgain={resetToLobby}
          onRematch={handleRematch}
          rematchState={rematchState}
          isTournamentMatch={isTournamentMatch}
          onBackToTournament={resetToTournamentLobby}
        />
      )}

      {phase === 'tournament_lobby' && tournamentState && (
        <TournamentLobby
          tournamentState={tournamentState}
          myId={myId}
          onLeave={resetToLobby}
        />
      )}

      {phase === 'tournament_result' && tournamentState && (
        <TournamentResult
          tournamentState={tournamentState}
          myId={myId}
          onLeave={resetToLobby}
        />
      )}
    </div>
  );
}
