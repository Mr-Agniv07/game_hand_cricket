import type { InningsEndPayload, InningsEndReason } from '@cric/types';
import styles from './InningsEndOverlay.module.css';

interface InningsEndOverlayProps {
  data: InningsEndPayload;
  onDismiss: () => void;
}

export default function InningsEndOverlay({ data, onDismiss }: InningsEndOverlayProps) {
  const reasonText: Record<InningsEndReason, string> = {
    out: 'Batsman got out!',
    all_out: 'All wickets taken!',
    overs_complete: 'All overs completed!',
    target_reached: 'Target reached!',
  };

  return (
    <div className="overlay" onClick={onDismiss}>
      <div className={styles['overlay-card']} onClick={(e) => e.stopPropagation()}>
        <h2>Innings {data.inningsNumber} Over</h2>
        <div className={styles['big-score']}>{data.score}</div>
        <p className={styles['reason-text']}>{reasonText[data.reason] || ''}</p>
        {data.inningsNumber === 1 && (
          <p className={styles['target-hint']}>
            Target: <strong>{data.score + 1}</strong>
          </p>
        )}
        <button className="btn-primary" onClick={onDismiss}>
          {data.inningsNumber === 1 ? 'Start 2nd Innings →' : 'See Result →'}
        </button>
      </div>
    </div>
  );
}
