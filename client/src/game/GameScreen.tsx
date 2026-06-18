import { useState, useEffect, useRef } from 'react';
import type { AppSocket } from '../socket';
import styles from './GameScreen.module.css';
import type { GameState, BallPlayedPayload } from '@cric/types';
import { HandCricketML } from './autoplayML';
import { sounds } from '../sound';
import { apiGet } from '../api';
import type { MLModelData, MLStats, OppRole } from './autoplayML';
import MLInsightsPanel from './MLInsightsPanel';

const NUMBERS = [1, 2, 3, 4, 5, 6];

interface GameScreenProps {
  socket: AppSocket;
  myPlayerIdx: number | null;
  gameState: GameState;
  lastBall: BallPlayedPayload | null;
  trainEvent: { move: number; role: OppRole; seq: number } | null;
  isAutoPlay: boolean;
  userToken: string | null;
  onDeclare: () => void;
}

export default function GameScreen({
  socket,
  myPlayerIdx,
  gameState,
  lastBall,
  trainEvent,
  isAutoPlay,
  userToken,
  onDeclare,
}: GameScreenProps) {
  const [myMove, setMyMove] = useState<number | null>(null);
  const myMoveRef = useRef<number | null>(null);
  const [ballAnim, setBallAnim] = useState<BallPlayedPayload | null>(null);
  const [showML, setShowML] = useState(false);
  const [mlStats, setMlStats] = useState<MLStats>(() => new HandCricketML().getStats('bat'));
  const mlRef = useRef(new HandCricketML());

  const players = gameState?.players || [];
  const batsmanIdx = gameState?.batsmanIdx ?? 0;
  const bowlerIdx = gameState?.bowlerIdx ?? 1;

  const isBatsman = myPlayerIdx === batsmanIdx;
  const isBowler = myPlayerIdx === bowlerIdx;
  // The opponent's current role is the one we predict: when I bat they bowl, etc.
  const oppRole: OppRole = isBatsman ? 'bowl' : 'bat';

  const score = gameState?.score ?? 0;
  const balls = gameState?.balls ?? 0;
  const overs = gameState?.overs ?? 1;
  const totalBalls = overs * 6;
  const currentInnings = (gameState?.currentInnings ?? 0) + 1;
  const target = gameState?.target ?? null;
  const superOver = gameState?.superOver ?? 0;

  const wickets = gameState?.wickets ?? 1;
  const wicketsLost = gameState?.wicketsLost ?? 0;
  const wicketsLeft = wickets - wicketsLost;

  // Load global opponent profile on mount to seed the in-memory model for autoplay.
  // Keyed by the opponent's registered user id; guests have no profile.
  // Training and persistence are handled server-side on every ball.
  useEffect(() => {
    if (!userToken || myPlayerIdx === null) return;
    const opponentId = gameState?.playerIds?.[myPlayerIdx === 0 ? 1 : 0];
    if (!opponentId) return;
    apiGet<MLModelData | null>(`/api/ml/${encodeURIComponent(opponentId)}`, userToken)
      .then((data) => {
        if (!data) return;
        mlRef.current.fromData(data);
        // Reflect the loaded profile in the insights panel immediately, instead
        // of showing flat priors until the first live ball.
        setMlStats(mlRef.current.getStats(oppRole));
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
  // regardless of whether autoplay is on. Driven by trainEvent (captured in
  // App at ball_played, with the correct pre-swap role and a value that's never
  // nulled) so no ball is dropped to React's innings-break batching.
  useEffect(() => {
    if (!trainEvent) return;
    mlRef.current.recordMove(trainEvent.move, trainEvent.role);
    setMlStats(mlRef.current.getStats(trainEvent.role));
  }, [trainEvent]);

  // New innings: clear Markov context but keep frequency data across the break.
  useEffect(() => {
    mlRef.current.newInnings();
  }, [currentInnings]);

  useEffect(() => {
    myMoveRef.current = myMove;
  }, [myMove]);

  // Unlock the numpad whenever the server advances the ball count or the innings
  // changes. Keying off authoritative server state (not a transient lastBall
  // set-then-null) makes this robust to React's batching at the innings break —
  // otherwise myMove could stay set and freeze the numpad for the whole 2nd
  // innings (a hang for BOTH players). Deps are *only* balls/currentInnings so
  // toggling autoplay mid-ball can't clear an already-submitted move.
  useEffect(() => {
    setMyMove(null);
    myMoveRef.current = null;
  }, [balls, currentInnings]);

  // When autoplay is on, the ML model picks this ball's move — but only if one
  // hasn't already been submitted (guards against toggling autoplay mid-ball
  // re-firing play_move).
  useEffect(() => {
    if (!isAutoPlay || myMoveRef.current !== null) return;
    const t = setTimeout(() => {
      if (myMoveRef.current !== null) return;
      const n = isBatsman ? mlRef.current.pickAsBatsman() : mlRef.current.pickAsBowler();
      myMoveRef.current = n;
      setMyMove(n);
      socket.emit('play_move', { number: n });
    }, 600);
    return () => clearTimeout(t);
  }, [balls, currentInnings, isAutoPlay, isBatsman]);

  function playMove(n: number) {
    if (myMove !== null) return;
    sounds.pick();
    myMoveRef.current = n;
    setMyMove(n);
    socket.emit('play_move', { number: n });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      let n: number | null = null;
      if (e.key >= '1' && e.key <= '6') n = Number(e.key);
      else if (e.key === 'r' || e.key === 'R') n = Math.ceil(Math.random() * 6);
      if (n === null || myMoveRef.current !== null) return;
      sounds.pick();
      myMoveRef.current = n;
      setMyMove(n);
      socket.emit('play_move', { number: n });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const oversDisplay = `${Math.floor(balls / 6)}.${balls % 6}`;
  const runsNeeded = target ? target - score : null;
  const ballsLeft = totalBalls - balls;

  return (
    <div className={styles['game-screen']}>
      <div className={styles['scoreboard']}>
        <div className={styles['innings-tag']}>
          {superOver > 0 ? `🔥 SUPER OVER${superOver > 1 ? ` ${superOver}` : ''} · ` : ''}
          Innings {currentInnings}
        </div>

        <div className={styles['score-block']}>
          <span key={score} className={styles['score-runs']}>
            {score}
          </span>
          <span className={styles['score-sep']}>/</span>
          <span className={styles['score-overs']}>{wicketsLost}W</span>
          <span className={styles['score-sep']}> · </span>
          <span className={styles['score-overs']}>
            {oversDisplay} / {overs} ov
          </span>
        </div>

        <div className={styles['wickets-left']}>
          {wicketsLeft} wkt{wicketsLeft !== 1 ? 's' : ''} · {ballsLeft} ball
          {ballsLeft !== 1 ? 's' : ''} left
        </div>

        {target !== null && (
          <div className={styles['chase-bar']}>
            <span>
              Target <strong>{target}</strong>
            </span>
            <span>
              Need <strong>{runsNeeded}</strong> in <strong>{ballsLeft}</strong> balls
            </span>
          </div>
        )}

        <div className={styles['players-row']}>
          <span className={`${styles['player-name']} ${styles.bat}`}>🏏 {players[batsmanIdx]}</span>
          <span className={styles['vs']}>vs</span>
          <span className={`${styles['player-name']} ${styles.bowl}`}>🎳 {players[bowlerIdx]}</span>
        </div>
      </div>

      {isAutoPlay && (
        <>
          <div
            style={{
              width: '100%',
              maxWidth: '460px',
              textAlign: 'right',
              marginBottom: showML ? 0 : '0.25rem',
            }}
          >
            <button className={styles['ml-toggle-btn']} onClick={() => setShowML((v) => !v)}>
              🧠 {showML ? 'Hide insights' : 'ML insights'}
            </button>
          </div>
          {showML && <MLInsightsPanel stats={mlStats} isBatsman={isBatsman} />}
        </>
      )}

      {ballAnim && (
        <div className={`${styles['ball-banner']} ${ballAnim.isOut ? styles.out : styles.run}`}>
          {ballAnim.isOut
            ? `💥 OUT! Both played ${ballAnim.batsmanMove}`
            : isBatsman
              ? `+${ballAnim.scored}  (You: ${ballAnim.batsmanMove} · Opp: ${ballAnim.bowlerMove})`
              : `Scored ${ballAnim.scored}  (Bat: ${ballAnim.batsmanMove} · You: ${ballAnim.bowlerMove})`}
        </div>
      )}

      <div className={styles['role-label']}>
        {isBatsman && <span className={`${styles.role} ${styles.bat}`}>You are Batting 🏏</span>}
        {isBowler && <span className={`${styles.role} ${styles.bowl}`}>You are Bowling 🎳</span>}
      </div>

      <div className={styles['numpad']}>
        {NUMBERS.map((n) => (
          <button
            key={n}
            className={`${styles['num-btn']}${myMove === n ? ` ${styles.chosen}` : ''}${myMove !== null ? ` ${styles.locked}` : ''}`}
            onClick={() => playMove(n)}
            disabled={myMove !== null}
          >
            {n}
          </button>
        ))}
      </div>

      {myMove !== null && !ballAnim && (
        <p className={styles['waiting-label']}>
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
        <div className={styles['prev-innings']}>
          1st innings score: <strong>{gameState?.innings?.[0]?.score ?? 0}</strong>
        </div>
      )}

      <button
        className={styles['declare-btn']}
        onClick={() => {
          if (window.confirm('Declare and quit? Your opponent will be the winner.')) onDeclare();
        }}
      >
        🏳️ Declare &amp; Quit
      </button>
    </div>
  );
}
