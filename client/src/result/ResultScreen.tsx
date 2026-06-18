import { useState } from 'react';
import type { GameOverPayload } from '@cric/types';
import type { RematchState } from '../types';
import styles from './ResultScreen.module.css';
import Scorecard from './Scorecard';

interface ResultScreenProps {
  gameOver: GameOverPayload;
  myPlayerIdx: number | null;
  onPlayAgain: () => void;
  onRematch: () => void;
  rematchState: RematchState;
  isTournamentMatch?: boolean;
  isFinalMatch?: boolean;
  onBackToTournament?: () => void;
}

export default function ResultScreen({
  gameOver,
  myPlayerIdx,
  onPlayAgain,
  onRematch,
  rematchState,
  isTournamentMatch = false,
  isFinalMatch = false,
  onBackToTournament,
}: ResultScreenProps) {
  const { winnerIdx, resultText, scores, players, scorecard } = gameOver;
  // Compare by player index (stable across reconnects), not socket id.
  const tied = winnerIdx === null;
  const iWon = winnerIdx !== null && winnerIdx === myPlayerIdx;
  const [showCard, setShowCard] = useState(false);

  // Confetti pieces — only rendered on a win. Each gets a randomized column,
  // colour, delay and duration via inline style; the fall is a CSS animation.
  const confettiColors = ['#22c55e', '#f59e0b', '#60a5fa', '#ef4444', '#a855f7', '#fff'];

  return (
    <div className="center-screen">
      {iWon && (
        <div className={styles.confetti} aria-hidden="true">
          {Array.from({ length: 28 }).map((_, i) => (
            <span
              key={i}
              className={styles['confetti-piece']}
              style={{
                left: `${Math.random() * 100}%`,
                background: confettiColors[i % confettiColors.length],
                animationDelay: `${Math.random() * 0.6}s`,
                animationDuration: `${1.8 + Math.random() * 1.4}s`,
              }}
            />
          ))}
        </div>
      )}
      <div className={`card ${styles['result-card']}`}>
        <div
          className={`${styles['result-emoji']} ${tied ? styles['emoji-tie'] : iWon ? styles['emoji-win'] : styles['emoji-lose']}`}
        >
          {tied ? '🤝' : iWon ? '🏆' : '😔'}
        </div>
        <h2 className={`${styles['result-title']} ${styles[tied ? 'tie' : iWon ? 'win' : 'lose']}`}>
          {tied ? "It's a Tie!" : iWon ? 'You Won!' : 'You Lost!'}
        </h2>
        <p className={styles['result-text']}>{resultText}</p>

        <div className={styles['scorecard']}>
          <div className={`${styles['scorecard-row']} ${styles.header}`}>
            <span>Player</span>
            <span>Score</span>
          </div>
          {players.map((name, i) => (
            <div key={i} className={styles['scorecard-row']}>
              <span>{name}</span>
              <span>{scores[i]}</span>
            </div>
          ))}
        </div>

        {scorecard && (
          <button className="btn-lobby" onClick={() => setShowCard(true)}>
            📋 Full Scorecard
          </button>
        )}

        {isTournamentMatch ? (
          <div className={styles['result-actions']}>
            {isFinalMatch ? (
              // The final is over — no "next match"; the awards/summary follow.
              <div className="tournament-next-notice">
                🏆 That's a wrap on the tournament! Tallying the awards…
              </div>
            ) : (
              <>
                <div className="tournament-next-notice">Next match starting in ~5 seconds…</div>
                {onBackToTournament && (
                  <button className="btn-lobby" onClick={onBackToTournament}>
                    Back to Tournament
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            {rematchState === 'opponent_wants' && (
              <div className={styles['rematch-notice']}>⚡ Opponent wants a rematch!</div>
            )}
            <div className={styles['result-actions']}>
              <button
                className={`${styles['btn-rematch']}${rematchState === 'waiting' ? ` ${styles.waiting}` : ''}`}
                onClick={onRematch}
                disabled={rematchState === 'waiting'}
              >
                {rematchState === 'waiting' ? 'Waiting for opponent…' : '⚡ Rematch'}
              </button>
              <button className="btn-lobby" onClick={onPlayAgain}>
                Back to Lobby
              </button>
            </div>
          </>
        )}
      </div>

      {showCard && scorecard && (
        <Scorecard scorecard={scorecard} onClose={() => setShowCard(false)} />
      )}
    </div>
  );
}
