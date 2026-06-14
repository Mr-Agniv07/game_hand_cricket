import type { TournamentState, PointsTableEntry } from '@cric/types';
import './TournamentResult.css';

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
    <div className="t-result-wrap">
      <div className="t-result-card">
        {/* Winner spotlight */}
        <div className="t-result-hero">
          <div className="t-result-trophy">{iWon ? '🏆' : '🏏'}</div>
          <div className="t-result-winner-name">{winner?.name ?? '?'}</div>
          <div className="t-result-winner-sub">Tournament Champion</div>
        </div>

        {/* My result badge */}
        {myRank >= 0 && (
          <div className={`t-my-rank rank-${myRank}`}>
            {RANK_MEDALS[myRank]} {RANK_LABELS[myRank]}
          </div>
        )}

        {/* Final standings */}
        <div className="t-result-section-title">Final Standings</div>
        <div className="t-result-table-wrap">
          <table className="t-table">
            <thead>
              <tr>
                <th className="t-th-rank">#</th>
                <th className="t-th-player">Player</th>
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
                    className={`${isMe ? 't-tr-me' : ''} ${isWinner ? 't-tr-winner' : ''}`}
                  >
                    <td className="t-td-rank">{RANK_MEDALS[rank]}</td>
                    <td className="t-td-player">
                      {p.name}
                      {isMe ? <span className="t-you"> (You)</span> : null}
                    </td>
                    <td>{e?.played ?? 0}</td>
                    <td className="t-won">{e?.won ?? 0}</td>
                    <td className="t-lost">{e?.lost ?? 0}</td>
                    <td className="t-pts">{e?.points ?? 0}</td>
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
