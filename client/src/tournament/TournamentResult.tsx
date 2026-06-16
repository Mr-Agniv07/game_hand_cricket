import type { TournamentState, TournamentPlayer, PointsTableEntry } from '@cric/types';
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

type PT = Record<string, PointsTableEntry>;

function sortByStandings(players: TournamentPlayer[], pt: PT): TournamentPlayer[] {
  return [...players].sort((a, b) => {
    const ea = pt[a.id];
    const eb = pt[b.id];
    if (!ea || !eb) return 0;
    if (eb.points !== ea.points) return eb.points - ea.points;
    return eb.nrr - ea.nrr;
  });
}

function StandingsTable({
  rows,
  pt,
  myId,
  championId,
}: {
  rows: TournamentPlayer[];
  pt: PT;
  myId: string | null;
  championId: string | null | undefined;
}) {
  return (
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
          {rows.map((p, rank) => {
            const e = pt[p.id];
            const isMe = p.id === myId;
            const isChampion = p.id === championId;
            return (
              <tr
                key={p.id}
                className={`${isMe ? styles['t-tr-me'] : ''} ${isChampion ? styles['t-tr-winner'] : ''}`}
              >
                <td className={styles['t-td-rank']}>{RANK_MEDALS[rank] ?? rank + 1}</td>
                <td className={styles['t-td-player']}>
                  {isChampion ? '🏆 ' : ''}
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
  );
}

export default function TournamentResult({ tournamentState, myId, onLeave }: TournamentResultProps) {
  const { size, groups, players, pointsTable, fixtures, champion } = tournamentState;
  const is8 = size === 8;

  const sortedAll = sortByStandings(players, pointsTable);

  // Champion is the FINAL winner (may not be the league/group topper).
  const winner = players.find((p) => p.id === champion) ?? sortedAll[0];
  const iWon = winner?.id === myId;

  // Runner-up = the other finalist.
  const finalFixture = fixtures.find((f) => f.stage === 'final' || f.isFinal);
  const finalists = finalFixture
    ? [players[finalFixture.player1Idx], players[finalFixture.player2Idx]]
    : [];
  const runnerUp = finalists.find((p) => p && p.id !== winner?.id) ?? null;

  // My placement badge.
  const iAmSemiFinalist = fixtures.some(
    (f) => f.stage === 'semi' && (players[f.player1Idx]?.id === myId || players[f.player2Idx]?.id === myId)
  );
  const myRank = sortedAll.findIndex((p) => p.id === myId);

  const knockouts = fixtures.filter((f) => f.stage === 'semi' || f.stage === 'final');

  let myBadge: { cls: string; text: string } | null = null;
  if (myId === winner?.id) myBadge = { cls: 'rank-0', text: '🏆 Champion!' };
  else if (myId === runnerUp?.id) myBadge = { cls: 'rank-1', text: '🥈 Runner-up' };
  else if (is8 && iAmSemiFinalist) myBadge = { cls: 'rank-2', text: '🥉 Semi-finalist' };
  else if (is8 && myRank >= 0) myBadge = { cls: 'rank-3', text: 'Group Stage' };
  else if (!is8 && myRank === 2) myBadge = { cls: 'rank-2', text: '🥉 3rd Place' };
  else if (!is8 && myRank === 3) myBadge = { cls: 'rank-3', text: '4th Place' };

  return (
    <div className={styles['t-result-wrap']}>
      <div className={styles['t-result-card']}>
        {/* Winner spotlight */}
        <div className={styles['t-result-hero']}>
          <div className={styles['t-result-trophy']}>{iWon ? '🏆' : '🏏'}</div>
          <div className={styles['t-result-winner-name']}>{winner?.name ?? '?'}</div>
          <div className={styles['t-result-winner-sub']}>Tournament Champion</div>
          {runnerUp && (
            <div className={styles['t-result-final-line']}>
              🏆 Won the Final vs <strong>{runnerUp.name}</strong>
            </div>
          )}
        </div>

        {/* My result badge */}
        {myBadge && (
          <div className={`${styles['t-my-rank']} ${styles[myBadge.cls]}`}>{myBadge.text}</div>
        )}

        {/* Standings */}
        {is8 ? (
          <>
            <div className={styles['t-result-section-title']}>Group A — Final Standings</div>
            <StandingsTable
              rows={sortByStandings((groups[0] ?? []).map((i) => players[i]).filter(Boolean), pointsTable)}
              pt={pointsTable}
              myId={myId}
              championId={champion}
            />
            <div className={styles['t-result-section-title']}>Group B — Final Standings</div>
            <StandingsTable
              rows={sortByStandings((groups[1] ?? []).map((i) => players[i]).filter(Boolean), pointsTable)}
              pt={pointsTable}
              myId={myId}
              championId={champion}
            />
          </>
        ) : (
          <>
            <div className={styles['t-result-section-title']}>League Standings</div>
            <StandingsTable rows={sortedAll} pt={pointsTable} myId={myId} championId={champion} />
          </>
        )}

        {/* Knockout results */}
        {knockouts.length > 0 && (
          <>
            <div className={styles['t-result-section-title']}>Knockouts</div>
            <div className={styles['t-ko-list']}>
              {knockouts.map((f) => {
                const p1 = players[f.player1Idx];
                const p2 = players[f.player2Idx];
                const p1Won = f.result === 'p1' || f.result === 'tie'; // tie → higher seed (p1)
                const p2Won = f.result === 'p2';
                return (
                  <div key={f.matchNum} className={styles['t-ko-row']}>
                    <span className={styles['t-ko-label']}>
                      {f.stage === 'final' ? '🏆 Final' : f.label}
                    </span>
                    <span className={styles['t-ko-teams']}>
                      <span className={p1Won ? styles['t-winner'] : ''}>{p1?.name ?? '?'}</span>
                      <span className={styles['t-ko-vs']}> {f.p1Score}–{f.p2Score} </span>
                      <span className={p2Won ? styles['t-winner'] : ''}>{p2?.name ?? '?'}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <button className="btn-lobby" onClick={onLeave}>
          Back to Lobby
        </button>
      </div>
    </div>
  );
}
