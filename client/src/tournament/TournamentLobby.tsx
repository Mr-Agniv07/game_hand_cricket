import { useState } from 'react';
import type { TournamentState, PointsTableEntry, LiveMatchScore } from '@cric/types';
import styles from './TournamentLobby.module.css';

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

const RANK_MEDALS = ['🥇', '🥈', '🥉', '4'];

function SpectatorScore({ liveScore }: { liveScore: LiveMatchScore }) {
  const {
    batsmanName,
    bowlerName,
    score,
    balls,
    wicketsLost,
    target,
    currentInnings,
    lastBall,
  } = liveScore;

  const oversDisplay = `${Math.floor(balls / 6)}.${balls % 6}`;
  const runsNeeded = target !== null ? target - score : null;

  return (
    <div className={`${styles['t-section']} ${styles['t-spectator']}`}>
      <div className={styles['t-section-title']}>Live — Innings {currentInnings}</div>

      <div className={styles['t-spec-score']}>
        <span className={styles['t-spec-runs']}>{score}</span>
        <span className={styles['t-spec-sep']}>/</span>
        <span className={styles['t-spec-detail']}>
          {wicketsLost}W · {oversDisplay} ov
        </span>
      </div>

      {runsNeeded !== null && (
        <div className={styles['t-spec-target']}>
          Target {target} — need <strong>{runsNeeded}</strong> more
        </div>
      )}

      <div className={styles['t-spec-players']}>
        <span className={styles['t-spec-bat']}>🏏 {batsmanName}</span>
        <span className={styles['t-spec-bowl']}>🎳 {bowlerName}</span>
      </div>

      {lastBall && (
        <div className={`${styles['t-spec-last']} ${lastBall.isOut ? styles.out : styles.run}`}>
          {lastBall.isOut
            ? `💥 OUT! Both played ${lastBall.batsmanMove}`
            : `+${lastBall.scored}  (${lastBall.batsmanMove} vs ${lastBall.bowlerMove})`}
        </div>
      )}
    </div>
  );
}

export default function TournamentLobby({ tournamentState, myId, onLeave }: TournamentLobbyProps) {
  const { code, players, phase, fixtures, currentMatchIndex, pointsTable } = tournamentState;
  const [copied, setCopied] = useState(false);

  function copyCode() {
    // clipboard API rejects in insecure contexts (e.g. http://<LAN-IP>); swallow
    // the rejection so it doesn't surface as an unhandled promise error.
    navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }

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
  const imPlaying = liveMatch ? myId === liveP1?.id || myId === liveP2?.id : false;

  const doneCount = fixtures.filter((f) => f.status === 'done').length;

  return (
    <div className={styles['t-lobby']}>
      {/* Code / progress header */}
      <div className={styles['t-info-row']}>
        {phase === 'waiting' ? (
          <>
            <div className={styles['t-code-block']}>
              <span className={styles['t-code-label']}>Tournament Code</span>
              <div className={styles['t-code-row']}>
                <span className={styles['t-code']}>{code}</span>
                <button className={styles['t-code-copy']} onClick={copyCode}>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <span className={styles['t-code-hint']}>Share with 3 friends to start</span>
            </div>

            <div className={styles['t-waiting-count']}>
              <span className={styles['t-count-num']}>{players.length}</span>
              <span className={styles['t-count-sep']}>/</span>
              <span className={styles['t-count-total']}>4</span>
              <span className={styles['t-count-label']}>players joined</span>
            </div>

            <div className={styles['t-player-list']}>
              {Array.from({ length: 4 }).map((_, i) => {
                const p = players[i];
                const isMe = p?.id === myId;
                return p ? (
                  <div key={p.id} className={`${styles['t-player-chip']}${isMe ? ` ${styles.me}` : ''}`}>
                    <span className={styles['t-chip-dot']} />
                    <span className={styles['t-chip-name']}>{p.name}</span>
                    {isMe && <span className={styles['t-chip-you']}>You</span>}
                  </div>
                ) : (
                  <div key={i} className={`${styles['t-player-chip']} ${styles.empty}`}>
                    <span className={`${styles['t-chip-dot']} ${styles.empty}`} />
                    <span className={styles['t-chip-name']}>Waiting…</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className={styles['t-progress']}>
            <div className={styles['t-progress-header']}>
              <span className={styles['t-progress-label']}>Match {Math.min(doneCount + 1, 12)} of 12</span>
              <span className={styles['t-progress-pct']}>{Math.round((doneCount / 12) * 100)}%</span>
            </div>
            <div className={styles['t-progress-bar']}>
              <div className={styles['t-progress-fill']} style={{ width: `${(doneCount / 12) * 100}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Live match banner */}
      {liveMatch && liveP1 && liveP2 && (
        <div className={`${styles['t-live-banner']}${imPlaying ? ` ${styles.playing}` : ''}`}>
          {imPlaying ? (
            <>
              <span className={styles['t-live-dot']} />
              Your match is live — check the game above!
            </>
          ) : (
            <>
              <span className={styles['t-live-dot']} />
              Live — {liveP1.name} vs {liveP2.name}
            </>
          )}
        </div>
      )}

      {/* Spectator scoreboard — shown to waiting players when a match is live */}
      {phase === 'in_progress' && !imPlaying && tournamentState.liveScore && (
        <SpectatorScore liveScore={tournamentState.liveScore} />
      )}

      {/* Points table */}
      {phase === 'in_progress' && (
        <div className={styles['t-section']}>
          <div className={styles['t-section-title']}>Points Table</div>
          <div className={styles['t-table-wrap']}>
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
                {sortedPlayers.map((p, rank) => {
                  const e = pointsTable[p.id];
                  const isMe = p.id === myId;
                  return (
                    <tr key={p.id} className={isMe ? styles['t-tr-me'] : ''}>
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
        </div>
      )}

      {/* Fixture list */}
      {phase === 'in_progress' && (
        <div className={styles['t-section']}>
          <div className={styles['t-section-title']}>Fixture</div>
          <div className={styles['t-fixture']}>
            {fixtures.map((f) => {
              const fp1 = players[f.player1Idx];
              const fp2 = players[f.player2Idx];
              const isMyMatch = myId === fp1?.id || myId === fp2?.id;
              const fp1Won = f.result === 'p1';
              const fp2Won = f.result === 'p2';
              return (
                <div
                  key={f.matchNum}
                  className={`${styles['t-fixture-row']} ${styles[f.status]}${isMyMatch ? ` ${styles['my-match']}` : ''}`}
                >
                  <span className={`${styles['t-match-badge']} ${styles[f.status]}`}>M{f.matchNum}</span>
                  <div className={styles['t-fixture-teams']}>
                    <span className={fp1Won ? styles['t-winner'] : ''}>{fp1?.name ?? '?'}</span>
                    <span className={styles['t-vs']}>vs</span>
                    <span className={fp2Won ? styles['t-winner'] : ''}>{fp2?.name ?? '?'}</span>
                  </div>
                  <div className={styles['t-fixture-result']}>
                    {f.status === 'done' ? (
                      <span className={styles['t-score']}>
                        {f.p1Score}–{f.p2Score}
                      </span>
                    ) : f.status === 'live' ? (
                      <span className={styles['t-live-tag']}>
                        <span className={`${styles['t-live-dot']} ${styles.sm}`} />
                        Live
                      </span>
                    ) : (
                      <span className={styles['t-upcoming-tag']}>—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {phase === 'waiting' && (
        <button className="btn-lobby" onClick={onLeave}>
          Leave Tournament
        </button>
      )}
    </div>
  );
}
