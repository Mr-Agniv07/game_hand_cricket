import { useState, useEffect, useRef } from 'react';
import type { AppSocket } from '../socket';
import './GameScreen.css';
import type { GameState, InningsStartPayload, BallPlayedPayload } from '@cric/types';
import { HandCricketML } from './autoplayML';
import { apiGet } from '../api';
import type { MLModelData, MLStats } from './autoplayML';
import MLInsightsPanel from './MLInsightsPanel';

const NUMBERS = [1, 2, 3, 4, 5, 6];

interface GameScreenProps {
  socket: AppSocket;
  myPlayerIdx: number | null;
  gameState: GameState;
  inningsInfo: InningsStartPayload;
  lastBall: BallPlayedPayload | null;
  isAutoPlay: boolean;
  userToken: string | null;
}

export default function GameScreen({
  socket,
  myPlayerIdx,
  gameState,
  lastBall,
  isAutoPlay,
  userToken,
}: GameScreenProps) {
  const [myMove, setMyMove] = useState<number | null>(null);
  const [ballAnim, setBallAnim] = useState<BallPlayedPayload | null>(null);
  const [showML, setShowML] = useState(false);
  const [mlStats, setMlStats] = useState<MLStats>(() => new HandCricketML().getStats());
  const mlRef = useRef(new HandCricketML());

  const players = gameState?.players || [];
  const batsmanIdx = gameState?.batsmanIdx ?? 0;
  const bowlerIdx = gameState?.bowlerIdx ?? 1;

  const isBatsman = myPlayerIdx === batsmanIdx;
  const isBowler = myPlayerIdx === bowlerIdx;

  const score = gameState?.score ?? 0;
  const balls = gameState?.balls ?? 0;
  const overs = gameState?.overs ?? 1;
  const totalBalls = overs * 6;
  const currentInnings = (gameState?.currentInnings ?? 0) + 1;
  const target = gameState?.target ?? null;

  const mode = gameState?.mode ?? 'overs';
  const wickets = gameState?.wickets ?? 1;
  const wicketsLost = gameState?.wicketsLost ?? 0;
  const wicketsLeft = wickets - wicketsLost;

  // Load global opponent profile on mount to seed the in-memory model for autoplay.
  // Training and persistence are handled server-side on every ball.
  useEffect(() => {
    if (!userToken || myPlayerIdx === null) return;
    const opponentName = players[myPlayerIdx === 0 ? 1 : 0];
    if (!opponentName) return;
    const key = encodeURIComponent(opponentName);
    apiGet<MLModelData | null>(`/api/ml/${key}`, userToken)
      .then((data) => {
        if (data) mlRef.current.fromData(data);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Show the ball-result banner briefly when a ball resolves.
  useEffect(() => {
    if (lastBall) {
      setBallAnim(lastBall);
      const t = setTimeout(() => setBallAnim(null), 1800);
      return () => clearTimeout(t);
    }
  }, [lastBall]);

  // Feed the opponent's move into the ML model on every ball — train always,
  // regardless of whether autoplay is on. Must run before the autoplay effect.
  useEffect(() => {
    if (!lastBall) return;
    const opponentMove = isBatsman ? lastBall.bowlerMove : lastBall.batsmanMove;
    mlRef.current.recordMove(opponentMove);
    setMlStats(mlRef.current.getStats());
  }, [lastBall, isBatsman]);

  // New innings: clear Markov context but keep frequency data across the break.
  useEffect(() => {
    mlRef.current.newInnings();
  }, [currentInnings]);

  // Unlock the numpad whenever the server advances the ball count or the innings
  // changes. Keying off authoritative server state (not a transient lastBall
  // set-then-null) makes this robust to React's batching at the innings break —
  // otherwise myMove could stay set and freeze the numpad for the whole 2nd
  // innings (a hang for BOTH players).
  // When autoplay is on, the ML model picks the next move.
  useEffect(() => {
    setMyMove(null);
    if (!isAutoPlay) return;
    const t = setTimeout(() => {
      const n = isBatsman ? mlRef.current.pickAsBatsman() : mlRef.current.pickAsBowler();
      setMyMove(n);
      socket.emit('play_move', { number: n });
    }, 600);
    return () => clearTimeout(t);
  }, [balls, currentInnings, isAutoPlay, isBatsman]);

  function playMove(n: number) {
    if (myMove !== null) return;
    setMyMove(n);
    socket.emit('play_move', { number: n });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key >= '1' && e.key <= '6') playMove(Number(e.key));
      if (e.key === 'r' || e.key === 'R') playMove(Math.ceil(Math.random() * 6));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [myMove]);

  const oversDisplay = `${Math.floor(balls / 6)}.${balls % 6}`;
  const runsNeeded = target ? target - score : null;
  const ballsLeft = mode === 'overs' ? totalBalls - balls : null;

  return (
    <div className="game-screen">
      <div className="scoreboard">
        <div className="innings-tag">Innings {currentInnings}</div>

        <div className="score-block">
          <span className="score-runs">{score}</span>
          <span className="score-sep">/</span>
          <>
            <span className="score-overs">{wicketsLost}W</span>
            <span className="score-sep"> · </span>
            <span className="score-overs">{oversDisplay} ov</span>
          </>
        </div>

        <div className="wickets-left">
          {wicketsLeft} wicket{wicketsLeft !== 1 ? 's' : ''} remaining
        </div>

        {target !== null && (
          <div className="chase-bar">
            <span>
              Target <strong>{target}</strong>
            </span>
            {ballsLeft !== null ? (
              <span>
                Need <strong>{runsNeeded}</strong> in <strong>{ballsLeft}</strong> balls
              </span>
            ) : (
              <span>
                Need <strong>{runsNeeded}</strong> runs
              </span>
            )}
          </div>
        )}

        <div className="players-row">
          <span className="player-name bat">🏏 {players[batsmanIdx]}</span>
          <span className="vs">vs</span>
          <span className="player-name bowl">🎳 {players[bowlerIdx]}</span>
        </div>
      </div>

      {isAutoPlay && (
        <>
          <div style={{ textAlign: 'right', marginBottom: showML ? 0 : '0.25rem' }}>
            <button className="ml-toggle-btn" onClick={() => setShowML((v) => !v)}>
              🧠 {showML ? 'Hide insights' : 'ML insights'}
            </button>
          </div>
          {showML && <MLInsightsPanel stats={mlStats} isBatsman={isBatsman} />}
        </>
      )}

      {ballAnim && (
        <div className={`ball-banner ${ballAnim.isOut ? 'out' : 'run'}`}>
          {ballAnim.isOut
            ? `💥 OUT! Both played ${ballAnim.batsmanMove}`
            : isBatsman
              ? `+${ballAnim.scored}  (You: ${ballAnim.batsmanMove} · Opp: ${ballAnim.bowlerMove})`
              : `Scored ${ballAnim.scored}  (Bat: ${ballAnim.batsmanMove} · You: ${ballAnim.bowlerMove})`}
        </div>
      )}

      <div className="role-label">
        {isBatsman && <span className="role bat">You are Batting 🏏</span>}
        {isBowler && <span className="role bowl">You are Bowling 🎳</span>}
      </div>

      <div className="numpad">
        {NUMBERS.map((n) => (
          <button
            key={n}
            className={`num-btn${myMove === n ? ' chosen' : ''}${myMove !== null ? ' locked' : ''}`}
            onClick={() => playMove(n)}
            disabled={myMove !== null}
          >
            {n}
          </button>
        ))}
      </div>

      {myMove !== null && !ballAnim && (
        <p className="waiting-label">
          {isAutoPlay ? (
            <>
              🤖 Computer played <strong>{myMove}</strong> · waiting for opponent…
            </>
          ) : (
            <>
              You played <strong>{myMove}</strong> · waiting for opponent…
            </>
          )}
        </p>
      )}

      {currentInnings === 2 && (
        <div className="prev-innings">
          1st innings score: <strong>{gameState?.innings?.[0]?.score ?? 0}</strong>
        </div>
      )}
    </div>
  );
}
