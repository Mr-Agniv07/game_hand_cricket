import './MLInsightsPanel.css';
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
    <div className="ml-panel">
      <div className="ml-panel-header">
        <span className="ml-panel-title">🧠 Opponent Patterns</span>
        <span className="ml-obs">{totalObservations} obs</span>
      </div>

      <div className="ml-bars">
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <div key={n} className="ml-bar-row">
            <span className="ml-bar-label">{n}</span>
            <div className="ml-bar-track">
              <div
                className={`ml-bar-fill ${barClass(n)}`}
                style={{ width: `${(display[n] / maxPct) * 100}%` }}
              />
            </div>
            <span className="ml-bar-pct">{display[n]}%</span>
          </div>
        ))}
      </div>

      {lastMove !== null && transitionPct && (
        <>
          <div className="ml-divider" />
          <div className="ml-context">
            After <strong>{lastMove}</strong> → likely next:{' '}
            <strong>{hotNum}</strong> ({transitionPct[hotNum]}%)
          </div>
        </>
      )}

      {totalObservations === 0 && (
        <>
          <div className="ml-divider" />
          <div className="ml-context">Watching opponent — predictions improve each ball.</div>
        </>
      )}
    </div>
  );
}
