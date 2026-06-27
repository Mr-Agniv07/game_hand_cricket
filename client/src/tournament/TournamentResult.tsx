import type { TournamentState, TournamentPlayer, PointsTableEntry } from '@cric/types';
import styles from './TournamentResult.module.css';
import { fixtureSummary } from './fixtureSummary';

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

function QualBadge({ status }: { status: 'Q' | 'E' | undefined }) {
  if (status === 'Q')
    return (
      <span className={styles['t-qual-q']} title="Qualified for the knockouts">
        Q
      </span>
    );
  if (status === 'E')
    return (
      <span className={styles['t-qual-e']} title="Eliminated from the knockouts">
        E
      </span>
    );
  return null;
}

function StandingsTable({
  rows,
  pt,
  myId,
  championId,
  qual,
}: {
  rows: TournamentPlayer[];
  pt: PT;
  myId: string | null;
  championId: string | null | undefined;
  qual?: Record<string, 'Q' | 'E'>;
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
                  <QualBadge status={qual?.[p.id]} />
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
  const { size, groups, players, pointsTable, fixtures, champion, awards, overs, wickets } =
    tournamentState;
  const isMultiGroup = size === 8 || size === 12;

  const sortedAll = sortByStandings(players, pointsTable);

  // Runner-up = the other finalist.
  const finalFixture = fixtures.find((f) => f.stage === 'final' || f.isFinal);

  // Champion is the FINAL winner (may not be the league/group topper). Prefer
  // the champion id, but it's a socket id that can go stale on reconnect, so
  // fall back to the final fixture's result (index-based, always correct)
  // before ever falling back to the league topper.
  const finalWinner =
    finalFixture && finalFixture.result
      ? players[
          finalFixture.result === 'p2' ? finalFixture.player2Idx : finalFixture.player1Idx
        ]
      : undefined;
  const winner = players.find((p) => p.id === champion) ?? finalWinner ?? sortedAll[0];
  const iWon = winner?.id === myId;
  const finalists = finalFixture
    ? [players[finalFixture.player1Idx], players[finalFixture.player2Idx]]
    : [];
  const runnerUp = finalists.find((p) => p && p.id !== winner?.id) ?? null;

  // My placement badge.
  const iAmSemiFinalist = fixtures.some(
    (f) => f.stage === 'semi' && (players[f.player1Idx]?.id === myId || players[f.player2Idx]?.id === myId)
  );
  const myRank = sortedAll.findIndex((p) => p.id === myId);

  const knockouts = fixtures.filter(
    (f) => f.stage === 'quarter' || f.stage === 'semi' || f.stage === 'final'
  );

  let myBadge: { cls: string; text: string } | null = null;
  if (myId === winner?.id) myBadge = { cls: 'rank-0', text: '🏆 Champion!' };
  else if (myId === runnerUp?.id) myBadge = { cls: 'rank-1', text: '🥈 Runner-up' };
  else if (isMultiGroup && iAmSemiFinalist) myBadge = { cls: 'rank-2', text: '🥉 Semi-finalist' };
  else if (isMultiGroup && myRank >= 0) myBadge = { cls: 'rank-3', text: 'Group Stage' };
  else if (!isMultiGroup && myRank === 2) myBadge = { cls: 'rank-2', text: '🥉 3rd Place' };
  else if (!isMultiGroup && myRank === 3) myBadge = { cls: 'rank-3', text: '4th Place' };

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

        {/* Awards */}
        {awards && (awards.orangeCap || awards.playerOfTournament) && (
          <>
            <div className={styles['t-result-section-title']}>Awards</div>
            <div className={styles['t-awards']}>
              {awards.playerOfTournament && (
                <div className={styles['t-award']}>
                  <span className={styles['t-award-icon']}>⭐</span>
                  <span className={styles['t-award-label']}>Player of the Tournament</span>
                  <span className={styles['t-award-name']}>{awards.playerOfTournament.name}</span>
                  <span className={styles['t-award-val']}>
                    {awards.playerOfTournament.runs} runs · {awards.playerOfTournament.wickets} wkts
                  </span>
                </div>
              )}
              {awards.orangeCap && (
                <div className={styles['t-award']}>
                  <span className={styles['t-award-icon']}>🟠</span>
                  <span className={styles['t-award-label']}>Orange Cap</span>
                  <span className={styles['t-award-name']}>{awards.orangeCap.name}</span>
                  <span className={styles['t-award-val']}>{awards.orangeCap.runs} runs</span>
                </div>
              )}
              {awards.purpleCap && (
                <div className={styles['t-award']}>
                  <span className={styles['t-award-icon']}>🟣</span>
                  <span className={styles['t-award-label']}>Purple Cap</span>
                  <span className={styles['t-award-name']}>{awards.purpleCap.name}</span>
                  <span className={styles['t-award-val']}>{awards.purpleCap.wickets} wickets</span>
                </div>
              )}
              {awards.mostSixes && (
                <div className={styles['t-award']}>
                  <span className={styles['t-award-icon']}>6️⃣</span>
                  <span className={styles['t-award-label']}>Most Sixes</span>
                  <span className={styles['t-award-name']}>{awards.mostSixes.name}</span>
                  <span className={styles['t-award-val']}>{awards.mostSixes.sixes} sixes</span>
                </div>
              )}
            </div>
          </>
        )}

        {/* Standings */}
        {isMultiGroup ? (
          <>
            <div className={styles['t-result-section-title']}>Group A — Final Standings</div>
            <StandingsTable
              rows={sortByStandings((groups[0] ?? []).map((i) => players[i]).filter(Boolean), pointsTable)}
              pt={pointsTable}
              myId={myId}
              championId={champion}
              qual={tournamentState.qualification}
            />
            <div className={styles['t-result-section-title']}>Group B — Final Standings</div>
            <StandingsTable
              rows={sortByStandings((groups[1] ?? []).map((i) => players[i]).filter(Boolean), pointsTable)}
              pt={pointsTable}
              myId={myId}
              championId={champion}
              qual={tournamentState.qualification}
            />
          </>
        ) : (
          <>
            <div className={styles['t-result-section-title']}>League Standings</div>
            <StandingsTable rows={sortedAll} pt={pointsTable} myId={myId} championId={champion} qual={tournamentState.qualification} />
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
                const { s1, s2, result } = fixtureSummary(f, players, overs, wickets);
                return (
                  <div key={f.matchNum} className={styles['t-ko-card']}>
                    <div className={styles['t-ko-top']}>
                      <span className={styles['t-ko-label']}>
                        {f.stage === 'final' ? '🏆 Final' : f.label}
                      </span>
                      <span className={`${styles['t-ko-team']} ${p1Won ? styles['t-winner'] : ''}`}>
                        {p1?.name ?? '?'}
                      </span>
                      <span className={styles['t-ko-vs']}>vs</span>
                      <span
                        className={`${styles['t-ko-team']} ${styles['t-ko-right']} ${
                          p2Won ? styles['t-winner'] : ''
                        }`}
                      >
                        {p2?.name ?? '?'}
                      </span>
                    </div>
                    <div className={styles['t-ko-scores']}>
                      <span>{s1}</span>
                      <span className={styles['t-ko-right']}>{s2}</span>
                    </div>
                    {result && <div className={styles['t-ko-result']}>{result}</div>}
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
