import type { MatchScorecard, InningsScorecard } from '@cric/types';
import styles from './Scorecard.module.css';

const oversStr = (balls: number) => `${Math.floor(balls / 6)}.${balls % 6}`;
const runRate = (runs: number, balls: number) => (balls ? ((runs * 6) / balls).toFixed(2) : '0.00');

function Innings({ inn, label }: { inn: InningsScorecard; label: string }) {
  const maxOver = Math.max(...inn.perOver, 1);
  return (
    <div className={styles.innings}>
      <div className={styles['in-head']}>
        <span className={styles['in-label']}>{label}</span>
        <span className={styles['in-bat']}>🏏 {inn.batter}</span>
        <span className={styles['in-total']}>
          {inn.runs}/{inn.wickets} <span className={styles['in-ov']}>({oversStr(inn.balls)} ov)</span>
        </span>
      </div>

      <div className={styles.stats}>
        <span>
          4s <b>{inn.fours}</b>
        </span>
        <span>
          5s <b>{inn.fives}</b>
        </span>
        <span>
          6s <b>{inn.sixes}</b>
        </span>
        <span>
          RR <b>{runRate(inn.runs, inn.balls)}</b>
        </span>
      </div>

      {inn.perOver.length > 0 && (
        <div className={styles.section}>
          <div className={styles['sec-title']}>Runs per over</div>
          <div className={styles.bars}>
            {inn.perOver.map((r, o) => (
              <div key={o} className={styles.bar}>
                <span className={styles['bar-runs']}>{r}</span>
                <div className={styles['bar-track']}>
                  <div
                    className={styles['bar-fill']}
                    style={{ height: `${Math.max(6, (r / maxOver) * 100)}%` }}
                  />
                </div>
                <span className={styles['bar-num']}>{o + 1}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {inn.fallOfWickets.length > 0 && (
        <div className={styles.section}>
          <div className={styles['sec-title']}>Fall of wickets</div>
          <div className={styles.fow}>
            {inn.fallOfWickets.map((w) => (
              <span key={w.wicket} className={styles['fow-item']}>
                {w.score} <span className={styles['fow-meta']}>({oversStr(w.ball)})</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Scorecard({
  scorecard,
  onClose,
}: {
  scorecard: MatchScorecard;
  onClose: () => void;
}) {
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>Scorecard</h2>
          <button className={styles.close} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className={styles.body}>
          {scorecard.tossWinnerName && (
            <div className={styles['toss-line']}>
              🪙 {scorecard.tossWinnerName} won the toss and elected to {scorecard.tossDecision}
            </div>
          )}
          {scorecard.innings.map((inn, i) => (
            <Innings key={i} inn={inn} label={`Innings ${i + 1}`} />
          ))}
        </div>
      </div>
    </div>
  );
}
