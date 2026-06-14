import type { TournamentState, PointsTableEntry } from '@cric/types';

interface TournamentLobbyProps {
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

export default function TournamentLobby({ tournamentState, myId, onLeave }: TournamentLobbyProps) {
  const { code, players, phase, fixtures, currentMatchIndex, pointsTable } = tournamentState;

  const sortedPlayers = [...players].sort((a, b) => {
    const ea: PointsTableEntry | undefined = pointsTable[a.id];
    const eb: PointsTableEntry | undefined = pointsTable[b.id];
    if (!ea || !eb) return 0;
    if (eb.points !== ea.points) return eb.points - ea.points;
    return eb.nrr - ea.nrr;
  });

  const liveMatch = phase === 'in_progress' ? fixtures[currentMatchIndex] : null;
  const liveP1 = liveMatch ? players[liveMatch.player1Idx] : null;
  const liveP2 = liveMatch ? players[liveMatch.player2Idx] : null;
  const imPlaying = liveMatch
    ? myId === liveP1?.id || myId === liveP2?.id
    : false;

  const doneCount = fixtures.filter(f => f.status === 'done').length;

  return (
    <div className="t-lobby">
      {/* Header info */}
      <div className="t-info-row">
        {phase === 'waiting' ? (
          <>
            <div className="t-code-block">
              <span className="t-code-label">Tournament Code</span>
              <span className="t-code">{code}</span>
              <span className="t-code-hint">Share with friends</span>
            </div>
            <div className="t-waiting-count">{players.length} / 4 players joined</div>
            <div className="t-player-list">
              {players.map(p => (
                <span key={p.id} className={`t-player-chip${p.id === myId ? ' me' : ''}`}>
                  {p.name}{p.id === myId ? ' (You)' : ''}
                </span>
              ))}
              {Array.from({ length: 4 - players.length }).map((_, i) => (
                <span key={i} className="t-player-chip empty">Waiting…</span>
              ))}
            </div>
          </>
        ) : (
          <div className="t-progress">
            <span className="t-progress-label">Match {Math.min(doneCount + 1, 12)} of 12</span>
            <div className="t-progress-bar">
              <div className="t-progress-fill" style={{ width: `${(doneCount / 12) * 100}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Live match banner */}
      {liveMatch && liveP1 && liveP2 && (
        <div className={`t-live-banner${imPlaying ? ' playing' : ''}`}>
          {imPlaying ? (
            <span>Your match is live — check the game above!</span>
          ) : (
            <span>
              <span className="t-live-dot" /> Live — {liveP1.name} vs {liveP2.name}
            </span>
          )}
        </div>
      )}

      {/* Points table */}
      <div className="t-section">
        <div className="t-section-title">Points Table</div>
        <div className="t-table-wrap">
          <table className="t-table">
            <thead>
              <tr>
                <th className="t-th-player">Player</th>
                <th>P</th><th>W</th><th>L</th><th>T</th>
                <th>Pts</th><th>NRR</th>
              </tr>
            </thead>
            <tbody>
              {sortedPlayers.map((p, rank) => {
                const e = pointsTable[p.id];
                const isMe = p.id === myId;
                return (
                  <tr key={p.id} className={isMe ? 't-tr-me' : ''}>
                    <td className="t-td-player">
                      <span className="t-rank">{rank + 1}</span>
                      {p.name}{isMe ? <span className="t-you"> (You)</span> : null}
                    </td>
                    <td>{e?.played ?? 0}</td>
                    <td className="t-won">{e?.won ?? 0}</td>
                    <td className="t-lost">{e?.lost ?? 0}</td>
                    <td>{e?.tied ?? 0}</td>
                    <td className="t-pts">{e?.points ?? 0}</td>
                    <td style={{ color: nrrColor(e?.nrr ?? 0) }}>{formatNRR(e?.nrr ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Fixture */}
      <div className="t-section">
        <div className="t-section-title">Fixture</div>
        <div className="t-fixture">
          {fixtures.map(f => {
            const fp1 = players[f.player1Idx];
            const fp2 = players[f.player2Idx];
            const isMyMatch = myId === fp1?.id || myId === fp2?.id;
            return (
              <div key={f.matchNum} className={`t-fixture-row ${f.status}${isMyMatch ? ' my-match' : ''}`}>
                <span className={`t-match-badge ${f.status}`}>M{f.matchNum}</span>
                <div className="t-fixture-teams">
                  <span className={f.result === 'p1' ? 't-winner' : ''}>{fp1?.name ?? '?'}</span>
                  <span className="t-vs">vs</span>
                  <span className={f.result === 'p2' ? 't-winner' : ''}>{fp2?.name ?? '?'}</span>
                </div>
                <div className="t-fixture-result">
                  {f.status === 'done' ? (
                    <span className="t-score">{f.p1Score}–{f.p2Score}</span>
                  ) : f.status === 'live' ? (
                    <span className="t-live-tag"><span className="t-live-dot sm" />Live</span>
                  ) : (
                    <span className="t-upcoming-tag">—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {phase === 'waiting' && (
        <button className="btn-lobby" style={{ maxWidth: 420, alignSelf: 'center' }} onClick={onLeave}>
          Leave Tournament
        </button>
      )}
    </div>
  );
}
