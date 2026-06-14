import type { GameOverPayload } from '@cric/types';
import type { RematchState } from '../types';

interface ResultScreenProps {
  gameOver: GameOverPayload;
  myId: string | null;
  onPlayAgain: () => void;
  onRematch: () => void;
  rematchState: RematchState;
}

export default function ResultScreen({ gameOver, myId, onPlayAgain, onRematch, rematchState }: ResultScreenProps) {
  const { winnerId, resultText, scores, players } = gameOver;
  const iWon = winnerId === myId;
  const tied = winnerId === null;

  return (
    <div className="center-screen">
      <div className="card result-card">
        <div className="result-emoji">
          {tied ? '🤝' : iWon ? '🏆' : '😔'}
        </div>
        <h2 className={`result-title ${tied ? 'tie' : iWon ? 'win' : 'lose'}`}>
          {tied ? "It's a Tie!" : iWon ? 'You Won!' : 'You Lost!'}
        </h2>
        <p className="result-text">{resultText}</p>

        <div className="scorecard">
          <div className="scorecard-row header">
            <span>Player</span>
            <span>Score</span>
          </div>
          {players.map((name, i) => (
            <div key={i} className="scorecard-row">
              <span>{name}</span>
              <span>{scores[i]}</span>
            </div>
          ))}
        </div>

        {rematchState === 'opponent_wants' && (
          <div className="rematch-notice">⚡ Opponent wants a rematch!</div>
        )}

        <div className="result-actions">
          <button
            className={`btn-rematch${rematchState === 'waiting' ? ' waiting' : ''}`}
            onClick={onRematch}
            disabled={rematchState === 'waiting'}
          >
            {rematchState === 'waiting' ? 'Waiting for opponent…' : '⚡ Rematch'}
          </button>
          <button className="btn-lobby" onClick={onPlayAgain}>
            Back to Lobby
          </button>
        </div>
      </div>
    </div>
  );
}
