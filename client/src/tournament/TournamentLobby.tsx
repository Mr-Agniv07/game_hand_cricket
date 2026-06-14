import { useState } from 'react';
import type { TournamentState, PointsTableEntry, LiveMatchScore } from '@cric/types';
import './TournamentLobby.css';

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
    mode,
    wickets,
    target,
    currentInnings,
    lastBall,
  } = liveScore;

  const oversDisplay = `${Math.floor(balls / 6)}.${balls % 6}`;
  const runsNeeded = target !== null ? target - score : null;

  return (
    <div className="t-section t-spectator">
      <div className="t-section-title">
        Live — Innings {currentInnings}
      </div>

      <div className="t-spec-score">
        <span className="t-spec-runs">{score}</span>
        <span className="t-spec-sep">/</span>
        {mode === 'overs' ? (
          <span className="t-spec-detail">{oversDisplay} ov</span>
        ) : (
          <span className="t-spec-detail">{wicketsLost}W ({wickets}wkt)</span>
        )}
      </div>

      {runsNeeded !== null && (
        <div className="t-spec-target">
          Target {target} — need <strong>{runsNeeded}</strong> more
        </div>
      )}

      <div className="t-spec-players">
        <span className="t-spec-bat">🏏 {batsmanName}</span>
        <span className="t-spec-bowl">🎳 {bowlerName}</span>
      </div>

      {lastBall && (
        <div className={`t-spec-last ${lastBall.isOut ? 'out' : 'run'}`}>
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
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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
    <div className="t-lobby">
      {/* Code / progress header */}
      <div className="t-info-row">
        {phase === 'waiting' ? (
          <>
            <div className="t-code-block">
              <span className="t-code-label">Tournament Code</span>
              <div className="t-code-row">
                <span className="t-code">{code}</span>
                <button className="t-code-copy" onClick={copyCode}>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <span className="t-code-hint">Share with 3 friends to start</span>
            </div>

            <div className="t-waiting-count">
              <span className="t-count-num">{players.length}</span>
              <span className="t-count-sep">/</span>
              <span className="t-count-total">4</span>
              <span className="t-count-label">players joined</span>
            </div>

            <div className="t-player-list">
              {Array.from({ length: 4 }).map((_, i) => {
                const p = players[i];
                const isMe = p?.id === myId;
                return p ? (
                  <div key={p.id} className={`t-player-chip${isMe ? ' me' : ''}`}>
                    <span className="t-chip-dot" />
                    <span className="t-chip-name">{p.name}</span>
                    {isMe && <span className="t-chip-you">You</span>}
                  </div>
                ) : (
                  <div key={i} className="t-player-chip empty">
                    <span className="t-chip-dot empty" />
                    <span className="t-chip-name">Waiting…</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="t-progress">
            <div className="t-progress-header">
              <span className="t-progress-label">Match {Math.min(doneCount + 1, 12)} of 12</span>
              <span className="t-progress-pct">{Math.round((doneCount / 12) * 100)}%</span>
            </div>
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
            <>
              <span className="t-live-dot" />
              Your match is live — check the game above!
            </>
          ) : (
            <>
              <span className="t-live-dot" />
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
        <div className="t-section">
          <div className="t-section-title">Points Table</div>
          <div className="t-table-wrap">
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
                {sortedPlayers.map((p, rank) => {
                  const e = pointsTable[p.id];
                  const isMe = p.id === myId;
                  return (
                    <tr key={p.id} className={isMe ? 't-tr-me' : ''}>
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
        </div>
      )}

      {/* Fixture list */}
      {phase === 'in_progress' && (
        <div className="t-section">
          <div className="t-section-title">Fixture</div>
          <div className="t-fixture">
            {fixtures.map((f) => {
              const fp1 = players[f.player1Idx];
              const fp2 = players[f.player2Idx];
              const isMyMatch = myId === fp1?.id || myId === fp2?.id;
              const fp1Won = f.result === 'p1';
              const fp2Won = f.result === 'p2';
              return (
                <div
                  key={f.matchNum}
                  className={`t-fixture-row ${f.status}${isMyMatch ? ' my-match' : ''}`}
                >
                  <span className={`t-match-badge ${f.status}`}>M{f.matchNum}</span>
                  <div className="t-fixture-teams">
                    <span className={fp1Won ? 't-winner' : ''}>{fp1?.name ?? '?'}</span>
                    <span className="t-vs">vs</span>
                    <span className={fp2Won ? 't-winner' : ''}>{fp2?.name ?? '?'}</span>
                  </div>
                  <div className="t-fixture-result">
                    {f.status === 'done' ? (
                      <span className="t-score">
                        {f.p1Score}–{f.p2Score}
                      </span>
                    ) : f.status === 'live' ? (
                      <span className="t-live-tag">
                        <span className="t-live-dot sm" />
                        Live
                      </span>
                    ) : (
                      <span className="t-upcoming-tag">—</span>
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
