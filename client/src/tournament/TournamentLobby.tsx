import { useState } from 'react';
import type {
  TournamentState,
  TournamentPlayer,
  PointsTableEntry,
  FixtureMatch,
  LiveMatchScore,
  MatchScorecard,
} from '@cric/types';
import styles from './TournamentLobby.module.css';
import Scorecard from '../result/Scorecard';
import { fixtureSummary } from './fixtureSummary';

interface TournamentLobbyProps {
  tournamentState: TournamentState;
  myId: string | null;
  onLeave: () => void;
  onStartWithBots: () => void;
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

function StandingsTable({ rows, pt, myId }: { rows: TournamentPlayer[]; pt: PT; myId: string | null }) {
  return (
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
          {rows.map((p, rank) => {
            const e = pt[p.id];
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
  );
}

function FixtureRow({
  f,
  players,
  myId,
  overs,
  wickets,
  onOpenCard,
}: {
  f: FixtureMatch;
  players: TournamentPlayer[];
  myId: string | null;
  overs: number;
  wickets: number;
  onOpenCard?: (sc: MatchScorecard) => void;
}) {
  const fp1 = players[f.player1Idx];
  const fp2 = players[f.player2Idx];
  const isMyMatch = myId === fp1?.id || myId === fp2?.id;
  const knockout = f.stage === 'semi' || f.stage === 'final';
  const badge = f.stage === 'final' ? '🏆' : f.stage === 'semi' ? 'SF' : `M${f.matchNum}`;
  const clickable = f.status === 'done' && !!f.scorecard;
  const cls = `${styles['t-fixture-row']} ${styles[f.status]}${isMyMatch ? ` ${styles['my-match']}` : ''}${knockout ? ` ${styles['final-row']}` : ''}${clickable ? ` ${styles.clickable}` : ''}`;
  const open = clickable && f.scorecard ? () => onOpenCard?.(f.scorecard!) : undefined;

  // ── Finished match: expanded two-line layout with full per-team scores ──
  if (f.status === 'done' && f.scorecard) {
    const { s1, s2, result } = fixtureSummary(f, players, overs, wickets);
    return (
      <div className={`${cls} ${styles.expanded}`} onClick={open} title={clickable ? 'View scorecard' : undefined}>
        <div className={styles['fx-top']}>
          <span className={`${styles['t-match-badge']} ${styles[f.status]}`}>{badge}</span>
          <span className={`${styles['fx-team']} ${f.result === 'p1' ? styles['t-winner'] : ''}`}>
            {fp1?.name ?? '?'}
          </span>
          <span className={styles['t-vs']}>vs</span>
          <span className={`${styles['fx-team']} ${styles['fx-right']} ${f.result === 'p2' ? styles['t-winner'] : ''}`}>
            {fp2?.name ?? '?'}
          </span>
          {clickable && <span className={styles['fx-card']}>📋</span>}
        </div>
        <div className={styles['fx-scores']}>
          <span>{s1}</span>
          <span className={styles['fx-right']}>{s2}</span>
        </div>
        <div className={styles['fx-result']}>{result}</div>
      </div>
    );
  }

  // ── Live / upcoming: compact single line ──
  return (
    <div className={cls} onClick={open} title={clickable ? 'View scorecard' : undefined}>
      <span className={`${styles['t-match-badge']} ${styles[f.status]}`}>{badge}</span>
      <div className={styles['t-fixture-teams']}>
        <span>{fp1?.name ?? '?'}</span>
        <span className={styles['t-vs']}>vs</span>
        <span>{fp2?.name ?? '?'}</span>
      </div>
      <div className={styles['t-fixture-result']}>
        {f.status === 'live' ? (
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
}

/** A placeholder knockout row shown before the real participants are known. */
function PlaceholderRow({ label, p1, p2 }: { label: string; p1: string; p2: string }) {
  return (
    <div className={`${styles['t-fixture-row']} ${styles.upcoming} ${styles['final-row']}`}>
      <span className={`${styles['t-match-badge']} ${styles.upcoming}`}>
        {label === 'Final' ? '🏆' : 'SF'}
      </span>
      <div className={styles['t-fixture-teams']}>
        <span>{p1}</span>
        <span className={styles['t-vs']}>vs</span>
        <span>{p2}</span>
      </div>
      <div className={styles['t-fixture-result']}>
        <span className={styles['t-upcoming-tag']}>{label === 'Final' ? 'FINAL' : 'SF'}</span>
      </div>
    </div>
  );
}

function SpectatorScore({ liveScore }: { liveScore: LiveMatchScore }) {
  const { batsmanName, bowlerName, score, balls, wicketsLost, target, currentInnings, lastBall } =
    liveScore;
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

export default function TournamentLobby({
  tournamentState,
  myId,
  onLeave,
  onStartWithBots,
}: TournamentLobbyProps) {
  const { code, size, groups, players, phase, fixtures, currentMatchIndex, pointsTable, overs, wickets } =
    tournamentState;
  const [copied, setCopied] = useState(false);
  const [groupTab, setGroupTab] = useState<0 | 1>(0);
  const [card, setCard] = useState<MatchScorecard | null>(null);

  const is8 = size === 8;
  const isHost = players[0]?.id === myId;

  function copyCode() {
    navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }

  const liveMatch = phase === 'in_progress' ? fixtures[currentMatchIndex] : null;
  const liveP1 = liveMatch ? players[liveMatch.player1Idx] : null;
  const liveP2 = liveMatch ? players[liveMatch.player2Idx] : null;
  const imPlaying = liveMatch ? myId === liveP1?.id || myId === liveP2?.id : false;

  const groupTotal = fixtures.filter((f) => f.stage === 'group').length || 12;
  const groupDone = fixtures.filter((f) => f.stage === 'group' && f.status === 'done').length;

  const semis = fixtures.filter((f) => f.stage === 'semi');
  const finalFix = fixtures.find((f) => f.stage === 'final');

  const progressLabel =
    liveMatch?.stage === 'final'
      ? '🏆 Grand Final'
      : liveMatch?.stage === 'semi'
        ? (liveMatch.label ?? 'Semi Final')
        : `Group Stage · ${Math.min(groupDone + 1, groupTotal)} of ${groupTotal}`;
  const progressPct = Math.min(100, Math.round((groupDone / groupTotal) * 100));

  // Group standings + fixtures for the 8-player view.
  const groupPlayers = (gi: number): TournamentPlayer[] =>
    (groups[gi] ?? []).map((idx) => players[idx]).filter(Boolean);
  const groupSorted = (gi: number) => sortByStandings(groupPlayers(gi), pointsTable);
  const groupFixtures = (g: 'A' | 'B') =>
    fixtures.filter((f) => f.stage === 'group' && f.group === g);

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
              <span className={styles['t-code-hint']}>
                Share to fill {size} players (or start with bots)
              </span>
            </div>

            <div className={styles['t-waiting-count']}>
              <span className={styles['t-count-num']}>{players.length}</span>
              <span className={styles['t-count-sep']}>/</span>
              <span className={styles['t-count-total']}>{size}</span>
              <span className={styles['t-count-label']}>players joined</span>
            </div>

            <div className={styles['t-player-list']}>
              {Array.from({ length: size }).map((_, i) => {
                const p = players[i];
                const isMe = p?.id === myId;
                return p ? (
                  <div
                    key={p.id}
                    className={`${styles['t-player-chip']}${isMe ? ` ${styles.me}` : ''}`}
                  >
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

            <div className={styles['t-format']}>
              <div className={styles['t-format-title']}>📋 How it works</div>
              <ul className={styles['t-format-list']}>
                {is8 ? (
                  <>
                    <li>8 players split randomly into Group A & B (4 each).</li>
                    <li>
                      Round-robin within each group — every pair plays twice. Win = 2 pts, Tie = 1
                      pt; ties broken by NRR.
                    </li>
                    <li>
                      Top 2 of each group reach the <strong>semi-finals</strong>: A1 v B2 and B1 v A2.
                    </li>
                    <li>
                      Semi winners meet in the <strong>FINAL</strong> — its winner is the champion.
                    </li>
                  </>
                ) : (
                  <>
                    <li>4 players, round-robin — everyone plays everyone twice (12 matches).</li>
                    <li>Win = 2 pts, Tie = 1 pt, Loss = 0. Ties on points broken by NRR.</li>
                    <li>
                      The top 2 then play a one-off <strong>FINAL</strong> — its winner is the
                      champion.
                    </li>
                  </>
                )}
              </ul>
            </div>
          </>
        ) : (
          <div className={styles['t-progress']}>
            <div className={styles['t-progress-header']}>
              <span className={styles['t-progress-label']}>{progressLabel}</span>
              <span className={styles['t-progress-pct']}>{progressPct}%</span>
            </div>
            <div className={styles['t-progress-bar']}>
              <div className={styles['t-progress-fill']} style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Live match banner */}
      {liveMatch && liveP1 && liveP2 && (
        <div className={`${styles['t-live-banner']}${imPlaying ? ` ${styles.playing}` : ''}`}>
          <span className={styles['t-live-dot']} />
          {imPlaying
            ? liveMatch.stage === 'final'
              ? '🏆 The FINAL is live — check the game above!'
              : 'Your match is live — check the game above!'
            : `${liveMatch.stage === 'final' ? '🏆 FINAL' : liveMatch.stage === 'semi' ? `🏏 ${liveMatch.label}` : 'Live'} — ${liveP1.name} vs ${liveP2.name}`}
        </div>
      )}

      {/* Spectator scoreboard */}
      {phase === 'in_progress' && !imPlaying && tournamentState.liveScore && (
        <SpectatorScore liveScore={tournamentState.liveScore} />
      )}

      {/* ── 8-player: group tabs + playoffs ── */}
      {phase === 'in_progress' && is8 && (
        <>
          <div className={styles['t-group-tabs']}>
            <button
              className={groupTab === 0 ? `${styles['t-group-tab']} ${styles.active}` : styles['t-group-tab']}
              onClick={() => setGroupTab(0)}
            >
              Group A
            </button>
            <button
              className={groupTab === 1 ? `${styles['t-group-tab']} ${styles.active}` : styles['t-group-tab']}
              onClick={() => setGroupTab(1)}
            >
              Group B
            </button>
          </div>

          <div className={styles['t-section']}>
            <div className={styles['t-section-title']}>Group {groupTab === 0 ? 'A' : 'B'} — Standings</div>
            <StandingsTable rows={groupSorted(groupTab)} pt={pointsTable} myId={myId} />
          </div>

          <div className={styles['t-section']}>
            <div className={styles['t-section-title']}>Group {groupTab === 0 ? 'A' : 'B'} — Fixtures</div>
            <div className={styles['t-fixture']}>
              {groupFixtures(groupTab === 0 ? 'A' : 'B').map((f) => (
                <FixtureRow key={f.matchNum} f={f} players={players} myId={myId} overs={overs} wickets={wickets} onOpenCard={setCard} />
              ))}
            </div>
          </div>

          <div className={styles['t-section']}>
            <div className={styles['t-section-title']}>🏆 Playoffs</div>
            <div className={styles['t-fixture']}>
              {semis.length > 0 ? (
                semis.map((f) => (
                  <div key={f.matchNum}>
                    <div className={styles['t-playoff-label']}>{f.label}</div>
                    <FixtureRow f={f} players={players} myId={myId} overs={overs} wickets={wickets} onOpenCard={setCard} />
                  </div>
                ))
              ) : (
                <>
                  <div>
                    <div className={styles['t-playoff-label']}>Semi Final 1</div>
                    <PlaceholderRow label="SF" p1="Group A #1" p2="Group B #2" />
                  </div>
                  <div>
                    <div className={styles['t-playoff-label']}>Semi Final 2</div>
                    <PlaceholderRow label="SF" p1="Group B #1" p2="Group A #2" />
                  </div>
                </>
              )}
              <div>
                <div className={styles['t-playoff-label']}>Final</div>
                {finalFix ? (
                  <FixtureRow f={finalFix} players={players} myId={myId} overs={overs} wickets={wickets} onOpenCard={setCard} />
                ) : (
                  <PlaceholderRow label="Final" p1="SF1 winner" p2="SF2 winner" />
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── 4-player: single table + fixtures ── */}
      {phase === 'in_progress' && !is8 && (
        <>
          <div className={styles['t-section']}>
            <div className={styles['t-section-title']}>Points Table</div>
            <StandingsTable rows={sortByStandings(players, pointsTable)} pt={pointsTable} myId={myId} />
          </div>

          <div className={styles['t-section']}>
            <div className={styles['t-section-title']}>Fixture</div>
            <div className={styles['t-fixture']}>
              {fixtures.map((f) => (
                <FixtureRow key={f.matchNum} f={f} players={players} myId={myId} overs={overs} wickets={wickets} onOpenCard={setCard} />
              ))}
              {!finalFix && (
                <div>
                  <div className={styles['t-playoff-label']}>Final</div>
                  <PlaceholderRow label="Final" p1="1st place" p2="2nd place" />
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {phase === 'waiting' && isHost && players.length < size && (
        <button className={styles['t-bot-fill-btn']} onClick={onStartWithBots}>
          🤖 Start now — fill {size - players.length} spot{size - players.length !== 1 ? 's' : ''} with
          bots
        </button>
      )}

      {phase === 'waiting' && (
        <button className="btn-lobby" onClick={onLeave}>
          Leave Tournament
        </button>
      )}

      {card && <Scorecard scorecard={card} onClose={() => setCard(null)} />}
    </div>
  );
}
