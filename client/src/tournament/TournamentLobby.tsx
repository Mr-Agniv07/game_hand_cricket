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
  qual,
}: {
  rows: TournamentPlayer[];
  pt: PT;
  myId: string | null;
  qual?: Record<string, 'Q' | 'E'>;
}) {
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
                <td className={styles['t-td-rank']}>{rank + 1}</td>
                <td className={styles['t-td-player']}>
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
  const knockout = f.stage === 'quarter' || f.stage === 'semi' || f.stage === 'final';
  const badge =
    f.stage === 'final'
      ? '🏆'
      : f.stage === 'semi'
        ? 'SF'
        : f.stage === 'quarter'
          ? 'QF'
          : `M${f.matchNum}`;
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

/** A placeholder knockout row shown before the real participants are known.
 * Uses a single wrapping line (not the truncating two-column team layout) so the
 * matchup text — e.g. "Group A #1 vs Group B #4" — is always fully visible. */
function PlaceholderRow({
  badge,
  p1,
  p2,
  p1Locked,
  p2Locked,
}: {
  badge: 'QF' | 'SF' | 'Final';
  p1: string;
  p2: string;
  /** True when the name is a confirmed qualifier (not a generic slot) → highlight it. */
  p1Locked?: boolean;
  p2Locked?: boolean;
}) {
  return (
    <div className={`${styles['t-fixture-row']} ${styles.upcoming} ${styles['final-row']}`}>
      <span className={`${styles['t-match-badge']} ${styles.upcoming}`}>
        {badge === 'Final' ? '🏆' : badge}
      </span>
      <span className={styles['t-ph-text']}>
        <span className={p1Locked ? styles['t-ph-locked'] : undefined}>{p1}</span>{' '}
        <span className={styles['t-vs']}>vs</span>{' '}
        <span className={p2Locked ? styles['t-ph-locked'] : undefined}>{p2}</span>
      </span>
    </div>
  );
}

function SpectatorScore({ liveScore }: { liveScore: LiveMatchScore }) {
  const { batsmanName, bowlerName, score, balls, wicketsLost, target, currentInnings, lastBall, tossWinnerName, tossDecision } =
    liveScore;
  const oversDisplay = `${Math.floor(balls / 6)}.${balls % 6}`;
  const runsNeeded = target !== null ? target - score : null;

  return (
    <div className={`${styles['t-section']} ${styles['t-spectator']}`}>
      <div className={styles['t-section-title']}>Live — Innings {currentInnings}</div>
      {tossWinnerName && (
        <div className={styles['t-spec-toss']}>
          🪙 {tossWinnerName} won the toss and elected to {tossDecision}
        </div>
      )}
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
  const superGroups = tournamentState.superGroups ?? null;
  const superPointsTable = tournamentState.superPointsTable ?? {};
  const [copied, setCopied] = useState(false);
  const [groupTab, setGroupTab] = useState(0);
  const [superTab, setSuperTab] = useState(0);
  const [card, setCard] = useState<MatchScorecard | null>(null);

  const groupLabels = ['A', 'B', 'C', 'D'] as const;
  const superGroupLabels = ['E', 'F'] as const;
  const isMultiGroup = groups.length > 1;
  const isWorldCup = tournamentState.superFormat === 'worldcup'; // 16: 2 groups of 8 → QF → SF → final
  // 12-team league and the 16-team "World Cup" both go groups → quarters → semis → final.
  const hasQuarters = size === 12 || isWorldCup;
  // Super 8 only in the classic 16-team Super League (not the World Cup format).
  const hasSuper8 = size === 16 && !isWorldCup;
  const super8Drawn = !!superGroups && superGroups.length > 0;
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

  const super8Total = fixtures.filter((f) => f.stage === 'super8').length;
  const super8Done = fixtures.filter((f) => f.stage === 'super8' && f.status === 'done').length;

  const quarters = fixtures.filter((f) => f.stage === 'quarter');
  const semis = fixtures.filter((f) => f.stage === 'semi');
  const finalFix = fixtures.find((f) => f.stage === 'final');

  const progressLabel =
    liveMatch?.stage === 'final'
      ? '🏆 Grand Final'
      : liveMatch?.stage === 'semi'
        ? (liveMatch.label ?? 'Semi Final')
        : liveMatch?.stage === 'quarter'
          ? (liveMatch.label ?? 'Quarter Final')
          : liveMatch?.stage === 'super8'
            ? `Super 8 · ${Math.min(super8Done + 1, super8Total)} of ${super8Total}`
            : `Group Stage · ${Math.min(groupDone + 1, groupTotal)} of ${groupTotal}`;
  const progressPct =
    liveMatch?.stage === 'super8' && super8Total > 0
      ? Math.min(100, Math.round((super8Done / super8Total) * 100))
      : Math.min(100, Math.round((groupDone / groupTotal) * 100));

  // Group standings + fixtures for the 8-player view.
  const groupPlayers = (gi: number): TournamentPlayer[] =>
    (groups[gi] ?? []).map((idx) => players[idx]).filter(Boolean);
  const groupSorted = (gi: number) => sortByStandings(groupPlayers(gi), pointsTable);
  const groupFixtures = (gi: number) =>
    fixtures.filter((f) => f.stage === 'group' && f.group === groupLabels[gi]);

  // Super 8 standings + fixtures (16-player only, once drawn).
  const superGroupPlayers = (gi: number): TournamentPlayer[] =>
    (superGroups?.[gi] ?? []).map((idx) => players[idx]).filter(Boolean);
  const superGroupSorted = (gi: number) => sortByStandings(superGroupPlayers(gi), superPointsTable);
  const superGroupFixtures = (gi: number) =>
    fixtures.filter((f) => f.stage === 'super8' && f.group === superGroupLabels[gi]);

  // ── Resolve a knockout bracket slot to a CONFIRMED name the moment it's known ──
  // A slot fills in once its occupant is determined — a finished group's seed, or a
  // decided QF/semi winner — so you see e.g. "Bot Kohli vs QF4 winner" instead of a
  // fully generic placeholder. Until then it shows the generic bracket label.
  type PhSlot = { text: string; locked: boolean };
  const ph = (resolved: string | null, fallback: string): PhSlot => ({
    text: resolved ?? fallback,
    locked: resolved != null,
  });
  const stageGroupDone = (label: string, stage: 'group' | 'super8') => {
    const gf = fixtures.filter((f) => f.stage === stage && f.group === label);
    return gf.length > 0 && gf.every((f) => f.status === 'done');
  };
  // Nth-placed (1-based) team of a COMPLETED group — its seed is then fixed.
  const seedName = (label: string, seed: number): string | null => {
    const gi = groupLabels.indexOf(label as (typeof groupLabels)[number]);
    return gi >= 0 && stageGroupDone(label, 'group') ? (groupSorted(gi)[seed - 1]?.name ?? null) : null;
  };
  const superSeedName = (label: string, seed: number): string | null => {
    const gi = superGroupLabels.indexOf(label as (typeof superGroupLabels)[number]);
    return gi >= 0 && stageGroupDone(label, 'super8')
      ? (superGroupSorted(gi)[seed - 1]?.name ?? null)
      : null;
  };
  // Winner of a finished knockout fixture (by its label). Tie → higher seed (p1).
  const winnerName = (fixtureLabel: string): string | null => {
    const fx = fixtures.find((f) => f.label === fixtureLabel);
    if (!fx || fx.status !== 'done') return null;
    return players[fx.result === 'p2' ? fx.player2Idx : fx.player1Idx]?.name ?? null;
  };

  // Quarterfinal bracket. World Cup (2 groups of 8): cross-seed A1·B4, A2·B3, A3·B2,
  // A4·B1. 12-player league: group winners/runners-up + two best 3rd-placed.
  const qfBracket: { label: string; p1: PhSlot; p2: PhSlot }[] = isWorldCup
    ? [
        { label: 'Quarter Final 1', p1: ph(seedName('A', 1), 'Group A #1'), p2: ph(seedName('B', 4), 'Group B #4') },
        { label: 'Quarter Final 2', p1: ph(seedName('A', 2), 'Group A #2'), p2: ph(seedName('B', 3), 'Group B #3') },
        { label: 'Quarter Final 3', p1: ph(seedName('A', 3), 'Group A #3'), p2: ph(seedName('B', 2), 'Group B #2') },
        { label: 'Quarter Final 4', p1: ph(seedName('A', 4), 'Group A #4'), p2: ph(seedName('B', 1), 'Group B #1') },
      ]
    : [
        { label: 'Quarter Final 1', p1: ph(seedName('A', 1), 'Group A #1'), p2: ph(seedName('B', 2), 'Group B #2') },
        { label: 'Quarter Final 2', p1: ph(seedName('B', 1), 'Group B #1'), p2: ph(seedName('C', 2), 'Group C #2') },
        { label: 'Quarter Final 3', p1: ph(seedName('C', 1), 'Group C #1'), p2: ph(null, 'Best 3rd-placed') },
        { label: 'Quarter Final 4', p1: ph(seedName('A', 2), 'Group A #2'), p2: ph(null, 'Best 3rd-placed') },
      ];
  // Semifinal bracket — sources differ by format (Super 8 seeds / QF winners / group seeds).
  const sfBracket: { p1: PhSlot; p2: PhSlot }[] = hasSuper8
    ? [
        { p1: ph(superSeedName('E', 1), 'Super 8 E #1'), p2: ph(superSeedName('F', 2), 'Super 8 F #2') },
        { p1: ph(superSeedName('F', 1), 'Super 8 F #1'), p2: ph(superSeedName('E', 2), 'Super 8 E #2') },
      ]
    : hasQuarters
      ? [
          { p1: ph(winnerName('Quarter Final 1'), 'QF1 winner'), p2: ph(winnerName('Quarter Final 4'), 'QF4 winner') },
          { p1: ph(winnerName('Quarter Final 2'), 'QF2 winner'), p2: ph(winnerName('Quarter Final 3'), 'QF3 winner') },
        ]
      : [
          { p1: ph(seedName('A', 1), 'Group A #1'), p2: ph(seedName('B', 2), 'Group B #2') },
          { p1: ph(seedName('B', 1), 'Group B #1'), p2: ph(seedName('A', 2), 'Group A #2') },
        ];
  // Final: fills each finalist once their semi is decided.
  const finalBracket: { p1: PhSlot; p2: PhSlot } = {
    p1: ph(winnerName('Semi Final 1'), 'SF1 winner'),
    p2: ph(winnerName('Semi Final 2'), 'SF2 winner'),
  };

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
                {isWorldCup ? (
                  <>
                    <li>16 bots split into two groups of 8 — Group A &amp; Group B.</li>
                    <li>
                      Full round-robin within each group — every bot plays all 7 group-mates. Win =
                      2 pts, Tie = 1 pt; ties broken by NRR.
                    </li>
                    <li>
                      Top 4 of each group reach the <strong>quarter-finals</strong>: A1 v B4, A2 v
                      B3, A3 v B2, A4 v B1.
                    </li>
                    <li>
                      Semis are QF1·QF4 winners and QF2·QF3 winners, then the{' '}
                      <strong>FINAL</strong> — its winner is the champion.
                    </li>
                  </>
                ) : size === 16 ? (
                  <>
                    <li>16 players split randomly into Groups A–D (4 each).</li>
                    <li>
                      Single round-robin within each group — every pair plays once. Win = 2 pts,
                      Tie = 1 pt; ties broken by NRR.
                    </li>
                    <li>
                      Top 2 of each group (8 teams) advance to the <strong>Super 8</strong>: two
                      fresh groups of 4 (E &amp; F), points reset — each team plays 3 matches.
                    </li>
                    <li>
                      Top 2 of each Super 8 group reach the <strong>semi-finals</strong> (E1 v F2,
                      F1 v E2), then the <strong>FINAL</strong> — its winner is the champion.
                    </li>
                  </>
                ) : size === 8 ? (
                  <>
                    <li>8 players split randomly into Group A & B (4 each).</li>
                    <li>
                      Single round-robin within each group — every pair plays once. Win = 2 pts,
                      Tie = 1 pt; ties broken by NRR.
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
                    <li>4 players, single round-robin — everyone plays everyone once.</li>
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
            : `${liveMatch.stage === 'final' ? '🏆 FINAL' : liveMatch.stage === 'semi' || liveMatch.stage === 'quarter' ? `🏏 ${liveMatch.label}` : 'Live'} — ${liveP1.name} vs ${liveP2.name}`}
        </div>
      )}

      {/* Spectator scoreboard */}
      {phase === 'in_progress' && !imPlaying && tournamentState.liveScore && (
        <SpectatorScore liveScore={tournamentState.liveScore} />
      )}

      {/* Live-match insights: head-to-head + what's at stake for qualification */}
      {phase === 'in_progress' && tournamentState.liveInsights && (
        <div className={styles['t-insights']}>
          <div className={styles['t-insights-title']}>📊 Match Insights</div>
          {tournamentState.liveInsights.headToHead && (
            <div className={styles['t-insight-h2h']}>{tournamentState.liveInsights.headToHead}</div>
          )}
          {tournamentState.liveInsights.lines.map((l, i) => (
            <div key={i} className={styles['t-insight-line']}>
              {l}
            </div>
          ))}
        </div>
      )}

      {/* ── 8/12-player: group tabs + playoffs ── */}
      {phase === 'in_progress' && isMultiGroup && (
        <>
          <div className={styles['t-group-tabs']}>
            {groups.map((_, gi) => (
              <button
                key={gi}
                className={groupTab === gi ? `${styles['t-group-tab']} ${styles.active}` : styles['t-group-tab']}
                onClick={() => setGroupTab(gi)}
              >
                Group {groupLabels[gi]}
              </button>
            ))}
          </div>

          <div className={styles['t-section']}>
            <div className={styles['t-section-title']}>Group {groupLabels[groupTab]} — Standings</div>
            <StandingsTable rows={groupSorted(groupTab)} pt={pointsTable} myId={myId} qual={tournamentState.qualification} />
          </div>

          <div className={styles['t-section']}>
            <div className={styles['t-section-title']}>Group {groupLabels[groupTab]} — Fixtures</div>
            <div className={styles['t-fixture']}>
              {groupFixtures(groupTab).map((f) => (
                <FixtureRow key={f.matchNum} f={f} players={players} myId={myId} overs={overs} wickets={wickets} onOpenCard={setCard} />
              ))}
            </div>
          </div>

          {/* ── Super 8 (16-player only) ── */}
          {hasSuper8 && (
            <div className={styles['t-section']}>
              <div className={styles['t-section-title']}>⚡ Super 8</div>
              {super8Drawn ? (
                <>
                  <div className={styles['t-group-tabs']}>
                    {superGroups!.map((_, gi) => (
                      <button
                        key={gi}
                        className={superTab === gi ? `${styles['t-group-tab']} ${styles.active}` : styles['t-group-tab']}
                        onClick={() => setSuperTab(gi)}
                      >
                        Group {superGroupLabels[gi]}
                      </button>
                    ))}
                  </div>
                  <div className={styles['t-subsection-title']}>Group {superGroupLabels[superTab]} — Standings</div>
                  <StandingsTable rows={superGroupSorted(superTab)} pt={superPointsTable} myId={myId} qual={tournamentState.superQualification} />
                  <div className={styles['t-subsection-title']}>Group {superGroupLabels[superTab]} — Fixtures</div>
                  <div className={styles['t-fixture']}>
                    {superGroupFixtures(superTab).map((f) => (
                      <FixtureRow key={f.matchNum} f={f} players={players} myId={myId} overs={overs} wickets={wickets} onOpenCard={setCard} />
                    ))}
                  </div>
                </>
              ) : (
                <p className={styles['t-playoff-note']}>
                  Top 2 of each group (A–D) qualify. When the group stage ends, the 8 qualifiers
                  are drawn into two fresh groups of 4 (E &amp; F) — points reset, each team plays 3.
                </p>
              )}
            </div>
          )}

          <div className={styles['t-section']}>
            <div className={styles['t-section-title']}>🏆 Playoffs</div>
            <div className={styles['t-fixture']}>
              {/* Quarterfinals: once drawn, show the real fixtures; before that, show
                  the bracket structure (the actual teams depend on final standings). */}
              {hasQuarters &&
                (quarters.length > 0
                  ? quarters.map((f) => (
                      <div key={f.matchNum}>
                        <div className={styles['t-playoff-label']}>{f.label}</div>
                        <FixtureRow f={f} players={players} myId={myId} overs={overs} wickets={wickets} onOpenCard={setCard} />
                      </div>
                    ))
                  : qfBracket.map(({ label, p1, p2 }) => (
                      <div key={label}>
                        <div className={styles['t-playoff-label']}>{label}</div>
                        <PlaceholderRow badge="QF" p1={p1.text} p2={p2.text} p1Locked={p1.locked} p2Locked={p2.locked} />
                      </div>
                    )))}

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
                    <PlaceholderRow badge="SF" p1={sfBracket[0].p1.text} p2={sfBracket[0].p2.text} p1Locked={sfBracket[0].p1.locked} p2Locked={sfBracket[0].p2.locked} />
                  </div>
                  <div>
                    <div className={styles['t-playoff-label']}>Semi Final 2</div>
                    <PlaceholderRow badge="SF" p1={sfBracket[1].p1.text} p2={sfBracket[1].p2.text} p1Locked={sfBracket[1].p1.locked} p2Locked={sfBracket[1].p2.locked} />
                  </div>
                </>
              )}
              <div>
                <div className={styles['t-playoff-label']}>Final</div>
                {finalFix ? (
                  <FixtureRow f={finalFix} players={players} myId={myId} overs={overs} wickets={wickets} onOpenCard={setCard} />
                ) : (
                  <PlaceholderRow badge="Final" p1={finalBracket.p1.text} p2={finalBracket.p2.text} p1Locked={finalBracket.p1.locked} p2Locked={finalBracket.p2.locked} />
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── 4-player: single table + fixtures ── */}
      {phase === 'in_progress' && !isMultiGroup && (
        <>
          <div className={styles['t-section']}>
            <div className={styles['t-section-title']}>Points Table</div>
            <StandingsTable rows={sortByStandings(players, pointsTable)} pt={pointsTable} myId={myId} qual={tournamentState.qualification} />
          </div>

          <div className={styles['t-section']}>
            <div className={styles['t-section-title']}>Fixture</div>
            <div className={styles['t-fixture']}>
              {fixtures.map((f) => (
                <FixtureRow key={f.matchNum} f={f} players={players} myId={myId} overs={overs} wickets={wickets} onOpenCard={setCard} />
              ))}
              {/* The Qualifier is a flat round-robin with NO knockouts — no Final to
                  tease. Only the 4-player format ends in a one-off Final. */}
              {!finalFix && !tournamentState.isQualifier && (
                <div>
                  <div className={styles['t-playoff-label']}>Final</div>
                  <PlaceholderRow badge="Final" p1="1st place" p2="2nd place" />
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
