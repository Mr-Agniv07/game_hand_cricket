import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../api';
import Scorecard from '../result/Scorecard';
import styles from './ProfilePanel.module.css';
import type {
  UserStats,
  UserAchievements,
  MatchHistoryEntry,
  HeadToHeadRecord,
  MatchScorecard,
} from '@cric/types';
import type { ClientUser } from '../types';

/** Shape returned by GET /api/me. */
interface MeResponse {
  id: string;
  username: string;
  stats: UserStats;
  achievements: UserAchievements;
  createdAt: string;
}

const BADGES: { key: keyof UserAchievements; icon: string; label: string }[] = [
  { key: 'tournamentsPlayed', icon: '🎟️', label: 'Tournaments' },
  { key: 'tournamentsWon', icon: '🏆', label: 'Titles Won' },
  { key: 'orangeCaps', icon: '🟠', label: 'Orange Caps' },
  { key: 'purpleCaps', icon: '🟣', label: 'Purple Caps' },
  { key: 'mostSixesAwards', icon: '6️⃣', label: 'Most Sixes' },
  { key: 'playerOfTournament', icon: '⭐', label: 'Player of Tmt' },
];

type Tab = 'overview' | 'matches' | 'h2h';

export default function ProfilePanel({ user, onClose }: { user: ClientUser; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [history, setHistory] = useState<MatchHistoryEntry[] | null>(null);
  const [h2h, setH2h] = useState<HeadToHeadRecord[] | null>(null);
  const [openScorecard, setOpenScorecard] = useState<MatchScorecard | null>(null);

  useEffect(() => {
    apiGet<MeResponse>('/api/me', user.token).then(setMe).catch(() => {});
    apiGet<MatchHistoryEntry[]>('/api/history', user.token)
      .then(setHistory)
      .catch(() => setHistory([]));
    apiGet<HeadToHeadRecord[]>('/api/head-to-head', user.token)
      .then(setH2h)
      .catch(() => setH2h([]));
  }, [user.token]);

  // Prefer freshly-fetched stats; fall back to what we already hold so the panel
  // never renders empty while /api/me is in flight.
  const stats = me?.stats ?? user.stats;
  const ach = me?.achievements;

  const winRate = stats.gamesPlayed ? Math.round((stats.wins / stats.gamesPlayed) * 100) : 0;
  const economy = stats.ballsBowled
    ? ((stats.runsConceded / stats.ballsBowled) * 6).toFixed(2)
    : '—';
  const joined = me?.createdAt
    ? new Date(me.createdAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : '…';

  const { humanRivals, botRivals } = useMemo(() => {
    const list = h2h ?? [];
    return {
      humanRivals: list.filter((r) => !r.isBot),
      botRivals: list.filter((r) => r.isBot).sort((a, b) => b.played - a.played),
    };
  }, [h2h]);

  return (
    <>
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.avatar}>{user.username[0].toUpperCase()}</span>
          <div className={styles.headInfo}>
            <span className={styles.username}>{user.username}</span>
            <span className={styles.joined}>📅 Joined {joined}</span>
          </div>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.tabs}>
          <button
            className={tab === 'overview' ? `${styles.tab} ${styles.active}` : styles.tab}
            onClick={() => setTab('overview')}
          >
            Overview
          </button>
          <button
            className={tab === 'matches' ? `${styles.tab} ${styles.active}` : styles.tab}
            onClick={() => setTab('matches')}
          >
            Matches
          </button>
          <button
            className={tab === 'h2h' ? `${styles.tab} ${styles.active}` : styles.tab}
            onClick={() => setTab('h2h')}
          >
            Head-to-Head
          </button>
        </div>

        <div className={styles.body}>
          {/* ── Overview ── */}
          {tab === 'overview' && (
            <>
              <div className={styles.sectionTitle}>Record</div>
              <div className={styles.statGrid}>
                <Tile value={stats.gamesPlayed} label="Played" />
                <Tile value={stats.wins} label="Won" tone="won" />
                <Tile value={stats.losses} label="Lost" tone="lost" />
                <Tile value={stats.ties} label="Tied" tone="tied" />
                <Tile value={`${winRate}%`} label="Win Rate" />
                <Tile value={stats.highScore} label="Best Score" />
              </div>

              <div className={styles.sectionTitle}>Batting &amp; Bowling</div>
              <div className={styles.statGrid}>
                <Tile value={stats.runsScored} label="Runs" />
                <Tile value={stats.boundaries} label="Boundaries" />
                <Tile value={stats.wicketsTaken} label="Wickets" />
                <Tile value={stats.ballsBowled} label="Balls Bowled" />
                <Tile value={stats.runsConceded} label="Conceded" />
                <Tile value={economy} label="Economy" />
              </div>

              <div className={styles.sectionTitle}>Tournaments</div>
              <div className={styles.badges}>
                {BADGES.map((b) => {
                  const count = ach?.[b.key] ?? 0;
                  return (
                    <div
                      key={b.key}
                      className={count === 0 ? `${styles.badge} ${styles.dim}` : styles.badge}
                    >
                      <span className={styles.badgeIcon}>{b.icon}</span>
                      <span className={styles.badgeCount}>{count}</span>
                      <span className={styles.badgeLabel}>{b.label}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ── Matches ── */}
          {tab === 'matches' &&
            (history === null ? (
              <div className={styles.loading}>
                <div className="spinner" />
              </div>
            ) : history.length === 0 ? (
              <p className={styles.empty}>No matches played yet.</p>
            ) : (
              <>
                <div className={styles.sectionTitle}>Last {history.length} Matches</div>
                <div className={styles.matchList}>
                  {history.map((m, i) => {
                    const hasCard = !!m.scorecard;
                    return (
                    <div
                      key={i}
                      className={`${styles.matchRow} ${styles[m.result]}${
                        hasCard ? ` ${styles.clickable}` : ''
                      }`}
                      onClick={hasCard ? () => setOpenScorecard(m.scorecard!) : undefined}
                      role={hasCard ? 'button' : undefined}
                      tabIndex={hasCard ? 0 : undefined}
                      title={hasCard ? 'View scorecard' : undefined}
                    >
                      <span className={`${styles.matchBadge} ${styles[m.result]}`}>
                        {m.result === 'win' ? 'W' : m.result === 'loss' ? 'L' : 'T'}
                      </span>
                      <div className={styles.matchInfo}>
                        <span className={styles.matchOpp}>
                          vs {m.opponent} {m.isTournament ? '🏆' : ''}
                        </span>
                        <span className={styles.matchMeta}>
                          {m.overs} ov · {m.wickets} wkt
                          {hasCard ? ' · 📋 Scorecard' : ''}
                        </span>
                      </div>
                      <div className={styles.matchRight}>
                        <span className={styles.matchScore}>
                          {m.myScore} – {m.oppScore}
                        </span>
                        <span className={styles.matchDate}>
                          {new Date(m.date).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      </div>
                    </div>
                    );
                  })}
                </div>
              </>
            ))}

          {/* ── Head-to-Head ── */}
          {tab === 'h2h' &&
            (h2h === null ? (
              <div className={styles.loading}>
                <div className="spinner" />
              </div>
            ) : humanRivals.length === 0 && botRivals.length === 0 ? (
              <p className={styles.empty}>No head-to-head records yet — play some matches!</p>
            ) : (
              <>
                {humanRivals.length > 0 && (
                  <>
                    <div className={styles.sectionTitle}>vs Players</div>
                    {humanRivals.map((r) => (
                      <H2hRow key={r.opponent} r={r} icon="👤" />
                    ))}
                  </>
                )}
                {botRivals.length > 0 && (
                  <>
                    <div className={styles.sectionTitle}>vs Bots</div>
                    {botRivals.map((r) => (
                      <H2hRow key={r.opponent} r={r} icon="🤖" />
                    ))}
                  </>
                )}
              </>
            ))}
        </div>
      </div>
    </div>

    {openScorecard && (
      <Scorecard scorecard={openScorecard} onClose={() => setOpenScorecard(null)} />
    )}
    </>
  );
}

function Tile({
  value,
  label,
  tone,
}: {
  value: number | string;
  label: string;
  tone?: 'won' | 'lost' | 'tied';
}) {
  return (
    <div className={styles.statTile}>
      <span className={tone ? `${styles.statValue} ${styles[tone]}` : styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function H2hRow({ r, icon }: { r: HeadToHeadRecord; icon: string }) {
  const verdict =
    r.wins > r.losses ? 'lead' : r.wins < r.losses ? 'behind' : 'level';
  const verdictLabel = verdict === 'lead' ? 'Leading' : verdict === 'behind' ? 'Behind' : 'Level';
  return (
    <div className={styles.h2hRow}>
      <span className={styles.h2hIcon}>{icon}</span>
      <div className={styles.h2hInfo}>
        <span className={styles.h2hName}>{r.opponent}</span>
        <span className={styles.h2hMeta}>
          {r.wins}–{r.losses}
          {r.ties > 0 ? `–${r.ties}` : ''} · {r.played} played · {r.runsFor}/{r.runsAgainst} runs
        </span>
      </div>
      <span className={`${styles.verdict} ${styles[verdict]}`}>{verdictLabel}</span>
    </div>
  );
}
