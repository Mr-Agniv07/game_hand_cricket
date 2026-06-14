import { useState, useEffect } from 'react';
import type { AppSocket } from '../socket';
import './GameScreen.css';
import type { GameState, InningsStartPayload, BallPlayedPayload } from '@cric/types';

const NUMBERS = [1, 2, 3, 4, 5, 6];

interface GameScreenProps {
  socket: AppSocket;
  myPlayerIdx: number | null;
  gameState: GameState;
  inningsInfo: InningsStartPayload;
  lastBall: BallPlayedPayload | null;
  isAutoPlay: boolean;
}

export default function GameScreen({ socket, myPlayerIdx, gameState, lastBall, isAutoPlay }: GameScreenProps) {
  const [myMove, setMyMove] = useState<number | null>(null);
  const [ballAnim, setBallAnim] = useState<BallPlayedPayload | null>(null);

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

  // Show the ball-result banner briefly when a ball resolves.
  useEffect(() => {
    if (lastBall) {
      setBallAnim(lastBall);
      const t = setTimeout(() => setBallAnim(null), 1800);
      return () => clearTimeout(t);
    }
  }, [lastBall]);

  // Unlock the numpad whenever the server advances the ball count or the innings
  // changes. Keying off authoritative server state (not a transient lastBall
  // set-then-null) makes this robust to React's batching at the innings break —
  // otherwise myMove could stay set and freeze the numpad for the whole 2nd
  // innings (a hang for BOTH players).
  // When autoplay is on, also auto-submit a random move after a short delay.
  useEffect(() => {
    setMyMove(null);
    if (!isAutoPlay) return;
    const t = setTimeout(() => {
      const n = Math.floor(Math.random() * 6) + 1;
      setMyMove(n);
      socket.emit('play_move', { number: n });
    }, 600);
    return () => clearTimeout(t);
  }, [balls, currentInnings, isAutoPlay]);

  function playMove(n: number) {
    if (myMove !== null) return;
    setMyMove(n);
    socket.emit('play_move', { number: n });
  }

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
          {mode === 'overs' ? (
            <span className="score-overs">{oversDisplay} ov</span>
          ) : (
            <span className="score-overs">{wicketsLost}W</span>
          )}
        </div>

        {mode === 'wickets' && (
          <div className="wickets-left">
            {wicketsLeft} wicket{wicketsLeft !== 1 ? 's' : ''} remaining
          </div>
        )}

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
            <>🤖 Computer played <strong>{myMove}</strong> · waiting for opponent…</>
          ) : (
            <>You played <strong>{myMove}</strong> · waiting for opponent…</>
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
