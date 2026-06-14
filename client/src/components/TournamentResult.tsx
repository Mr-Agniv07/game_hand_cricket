import type { TournamentState, PointsTableEntry } from '@cric/types';

interface TournamentResultProps {
  tournamentState: TournamentState;
  myId: string | null;
  onLeave: () => void;
}

function formatNRR(nrr: number): string {
  if (nrr === 0) return '0.000';
  return (nrr > 0 ? '+' : '') + nrr.toFixed(3);
}

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

  return (
    <div className="center-screen">
      <div className="card t-result-card">
        <div className="result-emoji">{iWon ? '🏆' : '🏏'}</div>
        <h2 className={`result-title ${iWon ? 'win' : 'lose'}`}>
          {iWon ? 'You Won the Tournament!' : `${winner?.name ?? '?'} Won!`}
        </h2>
        <p className="result-text">Tournament complete — final standings</p>

        <div className="t-result-table-wrap">
          <table className="t-table">
            <thead>
              <tr>
                <th className="t-th-player">Player</th>
                <th>P</th>
                <th>W</th>
                <th>L</th>
                <th>T</th>
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
                  <tr key={p.id} className={isMe ? 't-tr-me' : ''}>
                    <td className="t-td-player">
                      <span className="t-rank">{rank + 1}</span>
                      {isWinner && <span className="t-trophy">🏆 </span>}
                      {p.name}
                      {isMe ? <span className="t-you"> (You)</span> : null}
                    </td>
                    <td>{e?.played ?? 0}</td>
                    <td className="t-won">{e?.won ?? 0}</td>
                    <td className="t-lost">{e?.lost ?? 0}</td>
                    <td>{e?.tied ?? 0}</td>
                    <td className="t-pts">{e?.points ?? 0}</td>
                    <td>{formatNRR(e?.nrr ?? 0)}</td>
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
