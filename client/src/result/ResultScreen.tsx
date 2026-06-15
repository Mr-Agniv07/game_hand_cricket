import type { GameOverPayload } from '@cric/types';
import type { RematchState } from '../types';
import styles from './ResultScreen.module.css';

interface ResultScreenProps {
  gameOver: GameOverPayload;
  myPlayerIdx: number | null;
  onPlayAgain: () => void;
  onRematch: () => void;
  rematchState: RematchState;
  isTournamentMatch?: boolean;
  onBackToTournament?: () => void;
}

export default function ResultScreen({
  gameOver,
  myPlayerIdx,
  onPlayAgain,
  onRematch,
  rematchState,
  isTournamentMatch = false,
  onBackToTournament,
}: ResultScreenProps) {
  const { winnerIdx, resultText, scores, players } = gameOver;
  // Compare by player index (stable across reconnects), not socket id.
  const tied = winnerIdx === null;
  const iWon = winnerIdx !== null && winnerIdx === myPlayerIdx;

  return (
    <div className="center-screen">
      <div className={`card ${styles['result-card']}`}>
        <div className={styles['result-emoji']}>{tied ? '🤝' : iWon ? '🏆' : '😔'}</div>
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

        {isTournamentMatch ? (
          <div className={styles['result-actions']}>
            <div className="tournament-next-notice">Next match starting in ~5 seconds…</div>
            {onBackToTournament && (
              <button className="btn-lobby" onClick={onBackToTournament}>
                Back to Tournament
              </button>
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
    </div>
  );
}
