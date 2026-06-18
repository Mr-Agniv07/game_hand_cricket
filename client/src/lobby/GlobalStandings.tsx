import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../api';
import type { LeaderboardEntry, UserStats } from '@cric/types';
import styles from './GlobalStandings.module.css';

type CatKey = 'runs' | 'wickets' | 'wins' | 'ratio' | 'boundaries' | 'economy';

interface Category {
  key: CatKey;
  label: string;
  short: string;
  icon: string;
  /** Number used for ranking. */
  value: (s: UserStats) => number;
  /** Pretty value shown as the headline metric. */
  format: (s: UserStats) => string;
  /** Lower is better (economy). */
  asc?: boolean;
  /** A player only ranks in this category if they have relevant data. */
  qualifies: (s: UserStats) => boolean;
  /** Tiny grey context line under each player. */
  sub: (s: UserStats) => string;
}

const overs = (balls: number) => balls / 6;
const ratio = (s: UserStats) => s.wins / Math.max(1, s.losses);
const economy = (s: UserStats) => (s.ballsBowled > 0 ? s.runsConceded / overs(s.ballsBowled) : 0);

const CATEGORIES: Category[] = [
  {
    key: 'runs',
    label: 'Most Runs',
    short: 'Runs',
    icon: '🏏',
    value: (s) => s.runsScored,
    format: (s) => `${s.runsScored}`,
    qualifies: () => true,
    sub: (s) => `${s.gamesPlayed} games · best ${s.highScore}`,
  },
  {
    key: 'wickets',
    label: 'Most Wickets',
    short: 'Wickets',
    icon: '🎯',
    value: (s) => s.wicketsTaken,
    format: (s) => `${s.wicketsTaken}`,
    qualifies: () => true,
    sub: (s) => `${s.ballsBowled} balls bowled`,
  },
  {
    key: 'wins',
    label: 'Most Wins',
    short: 'Wins',
    icon: '🏆',
    value: (s) => s.wins,
    format: (s) => `${s.wins}`,
    qualifies: () => true,
    sub: (s) => `${s.wins}W · ${s.losses}L · ${s.ties}T`,
  },
  {
    key: 'ratio',
    label: 'Win / Loss Ratio',
    short: 'W/L',
    icon: '⚖️',
    value: ratio,
    format: (s) => ratio(s).toFixed(2),
    qualifies: (s) => s.gamesPlayed >= 3,
    sub: (s) => `${s.wins}W · ${s.losses}L`,
  },
  {
    key: 'boundaries',
    label: 'Most Boundaries',
    short: 'Boundaries',
    icon: '💥',
    value: (s) => s.boundaries,
    format: (s) => `${s.boundaries}`,
    qualifies: () => true,
    sub: (s) => `${s.runsScored} runs scored`,
  },
  {
    key: 'economy',
    label: 'Best Economy',
    short: 'Economy',
    icon: '🪙',
    value: economy,
    format: (s) => economy(s).toFixed(2),
    asc: true,
    qualifies: (s) => s.ballsBowled >= 12, // ≥2 overs bowled to qualify
    sub: (s) => `${s.wicketsTaken} wkts · ${s.runsConceded} runs`,
  },
];

const MEDALS = ['🥇', '🥈', '🥉'];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function GlobalStandings({
  myId,
  onClose,
}: {
  myId: string | null;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [cat, setCat] = useState<CatKey>('runs');

  useEffect(() => {
    apiGet<LeaderboardEntry[]>('/api/leaderboard')
      .then(setEntries)
      .catch(() => setError(true));
  }, []);

  const category = CATEGORIES.find((c) => c.key === cat)!;

  const ranked = useMemo(() => {
    if (!entries) return [];
    return entries
      .filter((e) => category.qualifies(e.stats))
      .sort((a, b) => {
        const va = category.value(a.stats);
        const vb = category.value(b.stats);
        return category.asc ? va - vb : vb - va;
      });
  }, [entries, cat]);

  const myRank = myId ? ranked.findIndex((e) => e.id === myId) : -1;
  const podium = ranked.slice(0, 3);
  const rest = ranked.slice(3);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>🌍 Global Standings</h2>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Category selector */}
        <div className={styles.cats}>
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              className={`${styles.cat} ${cat === c.key ? styles.catActive : ''}`}
              onClick={() => setCat(c.key)}
            >
              <span className={styles.catIcon}>{c.icon}</span>
              {c.short}
            </button>
          ))}
        </div>

        <div className={styles.body}>
          <div className={styles.catTitle}>
            {category.icon} {category.label}
            {category.asc && <span className={styles.catHint}>lower is better</span>}
          </div>

          {error ? (
            <p className={styles.empty}>Couldn&apos;t load the standings. Try again later.</p>
          ) : entries === null ? (
            <div className={styles.loading}>
              <div className="spinner" />
            </div>
          ) : ranked.length === 0 ? (
            <p className={styles.empty}>No one qualifies here yet — go make some history! 🏏</p>
          ) : (
            <>
              {/* Podium for the top 3 */}
              <div className={styles.podium}>
                {[1, 0, 2].map((pos) => {
                  const e = podium[pos];
                  if (!e) return <div key={pos} className={styles.podiumSlotEmpty} />;
                  const mine = e.id === myId;
                  return (
                    <div
                      key={e.id}
                      className={`${styles.podiumSlot} ${styles[`p${pos}`]} ${
                        mine ? styles.mine : ''
                      }`}
                    >
                      <div className={styles.medal}>{MEDALS[pos]}</div>
                      <div className={styles.avatar}>{initials(e.username)}</div>
                      <div className={styles.pName} title={e.username}>
                        {e.username}
                      </div>
                      <div className={styles.pValue}>{category.format(e.stats)}</div>
                      <div className={styles.podiumBar} />
                    </div>
                  );
                })}
              </div>

              {/* Ranks 4+ */}
              {rest.length > 0 && (
                <div className={styles.list}>
                  {rest.map((e, i) => {
                    const mine = e.id === myId;
                    return (
                      <div
                        key={e.id}
                        className={`${styles.row} ${mine ? styles.mineRow : ''}`}
                      >
                        <span className={styles.rank}>{i + 4}</span>
                        <span className={styles.rowAvatar}>{initials(e.username)}</span>
                        <span className={styles.rowInfo}>
                          <span className={styles.rowName}>
                            {e.username}
                            {mine && <span className={styles.youTag}>YOU</span>}
                          </span>
                          <span className={styles.rowSub}>{category.sub(e.stats)}</span>
                        </span>
                        <span className={styles.rowValue}>{category.format(e.stats)}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Sticky "your rank" hint when you're logged in but off the podium */}
              {myId && myRank >= 0 && (
                <div className={styles.youRank}>
                  You&apos;re <strong>#{myRank + 1}</strong> of {ranked.length} in{' '}
                  {category.label.toLowerCase()}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
