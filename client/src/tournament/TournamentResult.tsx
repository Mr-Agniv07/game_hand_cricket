import type { TournamentState, PointsTableEntry } from '@cric/types';
import styles from './TournamentResult.module.css';

interface TournamentResultProps {
  tournamentState: TournamentState;
  myId: string | null;
  onLeave: () => void;
}

function formatNRR(nrr: number): string {
  if (nrr === 0) return '0.000';
  return (nrr > 0 ? '+' : '') + nrr.toFixed(3);
}

function nrrColor(nrr: number): string {
  if (nrr > 0) return 'var(--accent)';
  if (nrr < 0) return 'var(--danger)';
  return 'var(--muted)';
}

const RANK_MEDALS = ['🥇', '🥈', '🥉', '4'];
const RANK_LABELS = ['Champion', 'Runner-up', '3rd Place', '4th Place'];

export default function TournamentResult({
  tournamentState,
  myId,
  onLeave,
}: TournamentResultProps) {
  const { players, pointsTable } = tournamentState;

  const sorted = [...players].sort((a, b) => {
    const ea: PointsTableEntry | undefined = pointsTable[a.id];
    const eb: PointsTableEntry | undefined = pointsTable[b.id];
    if (!ea || !eb) return 0;
    if (eb.points !== ea.points) return eb.points - ea.points;
    return eb.nrr - ea.nrr;
  });

  const winner = sorted[0];
  const iWon = winner?.id === myId;
  const myRank = sorted.findIndex((p) => p.id === myId);

  return (
    <div className={styles['t-result-wrap']}>
      <div className={styles['t-result-card']}>
        {/* Winner spotlight */}
        <div className={styles['t-result-hero']}>
          <div className={styles['t-result-trophy']}>{iWon ? '🏆' : '🏏'}</div>
          <div className={styles['t-result-winner-name']}>{winner?.name ?? '?'}</div>
          <div className={styles['t-result-winner-sub']}>Tournament Champion</div>
        </div>

        {/* My result badge */}
        {myRank >= 0 && (
          <div className={`${styles['t-my-rank']} ${styles[`rank-${myRank}`]}`}>
            {RANK_MEDALS[myRank]} {RANK_LABELS[myRank]}
          </div>
        )}

        {/* Final standings */}
        <div className={styles['t-result-section-title']}>Final Standings</div>
        <div className={styles['t-result-table-wrap']}>
          <table className={styles['t-table']}>
            <thead>
              <tr>
                <th className={styles['t-th-rank']}>#</th>
                <th className={styles['t-th-player']}>Player</th>
                <th>P</th>
                <th>W</th>
                <th>L</th>
                <th>Pts</th>
                <th>NRR</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, rank) => {
                const e = pointsTable[p.id];
                const isMe = p.id === myId;
                const isWinner = rank === 0;
                return (
                  <tr
                    key={p.id}
                    className={`${isMe ? styles['t-tr-me'] : ''} ${isWinner ? styles['t-tr-winner'] : ''}`}
                  >
                    <td className={styles['t-td-rank']}>{RANK_MEDALS[rank]}</td>
                    <td className={styles['t-td-player']}>
                      {p.name}
                      {isMe ? <span className={styles['t-you']}> (You)</span> : null}
                    </td>
                    <td>{e?.played ?? 0}</td>
                    <td className={styles['t-won']}>{e?.won ?? 0}</td>
                    <td className={styles['t-lost']}>{e?.lost ?? 0}</td>
                    <td className={styles['t-pts']}>{e?.points ?? 0}</td>
                    <td style={{ color: nrrColor(e?.nrr ?? 0) }}>{formatNRR(e?.nrr ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <button className="btn-lobby" onClick={onLeave}>
          Back to Lobby
        </button>
      </div>
    </div>
  );
}
