import styles from './MLInsightsPanel.module.css';
import type { MLStats } from './autoplayML';

interface Props {
  stats: MLStats;
  isBatsman: boolean;
}

export default function MLInsightsPanel({ stats, isBatsman }: Props) {
  const { freqPct, transitionPct, lastMove, totalObservations } = stats;

  // Pick the row to visualise: transition if available, else global frequency.
  const display = transitionPct ?? freqPct;

  // Highest-probability number from the display row (1-indexed, skip index 0).
  const hotNum = display.slice(1).indexOf(Math.max(...display.slice(1))) + 1;

  // As batsman: avoid the hot number (danger). As bowler: target it (safe).
  function barClass(n: number) {
    if (n === hotNum) return isBatsman ? 'danger' : 'safe';
    return 'neutral';
  }

  const maxPct = Math.max(...display.slice(1), 1);

  return (
    <div className={styles['ml-panel']}>
      <div className={styles['ml-panel-header']}>
        <span className={styles['ml-panel-title']}>🧠 Opponent Patterns</span>
        <span className={styles['ml-obs']}>{totalObservations} obs</span>
      </div>

      <div className={styles['ml-bars']}>
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <div key={n} className={styles['ml-bar-row']}>
            <span className={styles['ml-bar-label']}>{n}</span>
            <div className={styles['ml-bar-track']}>
              <div
                className={`${styles['ml-bar-fill']} ${styles[barClass(n)]}`}
                style={{ width: `${(display[n] / maxPct) * 100}%` }}
              />
            </div>
            <span className={styles['ml-bar-pct']}>{display[n]}%</span>
          </div>
        ))}
      </div>

      {lastMove !== null && transitionPct && (
        <>
          <div className={styles['ml-divider']} />
          <div className={styles['ml-context']}>
            After <strong>{lastMove}</strong> → likely next:{' '}
            <strong>{hotNum}</strong> ({transitionPct[hotNum]}%)
          </div>
        </>
      )}

      {totalObservations === 0 && (
        <>
          <div className={styles['ml-divider']} />
          <div className={styles['ml-context']}>Watching opponent — predictions improve each ball.</div>
        </>
      )}
    </div>
  );
}
