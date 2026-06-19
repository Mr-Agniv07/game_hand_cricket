import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import type { UserAchievements, GlobalRecords, OversRecords, GameRecord } from '@cric/types';
import type { ClientUser } from '../types';
import styles from './HallOfFame.module.css';

const OVERS_ORDER = [1, 2, 3, 5, 10];

const BADGES: { key: keyof UserAchievements; icon: string; label: string }[] = [
  { key: 'tournamentsWon', icon: '🏆', label: 'Tournaments Won' },
  { key: 'orangeCaps', icon: '🟠', label: 'Orange Caps' },
  { key: 'purpleCaps', icon: '🟣', label: 'Purple Caps' },
  { key: 'mostSixesAwards', icon: '6️⃣', label: 'Most Sixes' },
  { key: 'playerOfTournament', icon: '⭐', label: 'Player of the Tournament' },
  { key: 'tournamentsPlayed', icon: '🎟️', label: 'Tournaments Played' },
];

const RECORD_DEFS: {
  key: keyof OversRecords;
  icon: string;
  label: string;
  unit: string;
}[] = [
  { key: 'highestTotal', icon: '📈', label: 'Highest Total', unit: 'runs' },
  { key: 'lowestTotal', icon: '📉', label: 'Lowest Total', unit: 'runs' },
  { key: 'fastest50', icon: '⚡', label: 'Fastest Fifty', unit: 'balls' },
  { key: 'fastest100', icon: '🚀', label: 'Fastest Hundred', unit: 'balls' },
];

type Tab = 'me' | 'records';

export default function HallOfFame({
  user,
  onClose,
}: {
  user: ClientUser | null;
  onClose: () => void;
}) {
  const loggedIn = !!user;
  const [tab, setTab] = useState<Tab>(loggedIn ? 'me' : 'records');
  const [ach, setAch] = useState<UserAchievements | null>(null);
  const [records, setRecords] = useState<GlobalRecords | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    apiGet<GlobalRecords>('/api/records')
      .then(setRecords)
      .catch(() => setError(true));
    if (user?.token) {
      apiGet<UserAchievements>('/api/achievements', user.token)
        .then(setAch)
        .catch(() => {});
    }
  }, []);

  // Records the viewer personally holds (for the "me" tab).
  const myRecords: { label: string; overs: number; value: number; unit: string }[] = [];
  if (records && user) {
    for (const ov of OVERS_ORDER) {
      const bucket = records.byOvers[String(ov)];
      if (!bucket) continue;
      for (const def of RECORD_DEFS) {
        const rec = bucket[def.key];
        if (rec && rec.holderId === user.id)
          myRecords.push({ label: def.label, overs: ov, value: rec.value, unit: def.unit });
      }
    }
  }

  const presentOvers = records
    ? OVERS_ORDER.filter((ov) => records.byOvers[String(ov)])
    : [];

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>🏛️ Hall of Fame</h2>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.tabs}>
          {loggedIn && (
            <button
              className={`${styles.tab} ${tab === 'me' ? styles.tabActive : ''}`}
              onClick={() => setTab('me')}
            >
              ⭐ My Honours
            </button>
          )}
          <button
            className={`${styles.tab} ${tab === 'records' ? styles.tabActive : ''}`}
            onClick={() => setTab('records')}
          >
            📜 Global Records
          </button>
        </div>

        <div className={styles.body}>
          {tab === 'me' && loggedIn && (
            <>
              <div className={styles.sectionTitle}>{user!.username}'s Badges</div>
              <div className={styles.badges}>
                {BADGES.map((b) => {
                  const count = ach?.[b.key] ?? 0;
                  return (
                    <div key={b.key} className={`${styles.badge} ${count === 0 ? styles.dim : ''}`}>
                      <span className={styles.badgeIcon}>{b.icon}</span>
                      <span className={styles.badgeCount}>{count}</span>
                      <span className={styles.badgeLabel}>{b.label}</span>
                    </div>
                  );
                })}
              </div>

              <div className={styles.sectionTitle}>World Records You Hold</div>
              {myRecords.length === 0 ? (
                <p className={styles.empty}>
                  No world records yet — win tournament matches in style to claim some! 🏏
                </p>
              ) : (
                <div className={styles.heldList}>
                  {myRecords.map((r, i) => (
                    <div key={i} className={styles.heldRow}>
                      <span className={styles.heldMedal}>🌟</span>
                      <span className={styles.heldLabel}>
                        {r.label} · {r.overs} over{r.overs !== 1 ? 's' : ''}
                      </span>
                      <span className={styles.heldVal}>
                        {r.value} <small>{r.unit}</small>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'records' && (
            <>
              {error ? (
                <p className={styles.empty}>Couldn&apos;t load records. Try again later.</p>
              ) : records === null ? (
                <div className={styles.loading}>
                  <div className="spinner" />
                </div>
              ) : presentOvers.length === 0 ? (
                <p className={styles.empty}>
                  No records set yet. Play some tournaments to write history! 🏏
                </p>
              ) : (
                <>
                  <p className={styles.note}>
                    Records are set in <strong>tournament matches</strong>, grouped by overs.
                  </p>
                  {presentOvers.map((ov) => {
                    const bucket = records.byOvers[String(ov)];
                    return (
                      <div key={ov} className={styles.bucket}>
                        <div className={styles.bucketTitle}>
                          {ov} Over{ov !== 1 ? 's' : ''}
                        </div>
                        <div className={styles.recGrid}>
                          {RECORD_DEFS.map((def) => (
                            <RecordCell
                              key={def.key}
                              icon={def.icon}
                              label={def.label}
                              unit={def.unit}
                              rec={bucket[def.key]}
                              mine={!!user && bucket[def.key]?.holderId === user.id}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RecordCell({
  icon,
  label,
  unit,
  rec,
  mine,
}: {
  icon: string;
  label: string;
  unit: string;
  rec: GameRecord | null;
  mine: boolean;
}) {
  return (
    <div className={`${styles.recCell} ${mine ? styles.recMine : ''}`}>
      <div className={styles.recTop}>
        <span className={styles.recIcon}>{icon}</span>
        <span className={styles.recLabel}>{label}</span>
      </div>
      {rec ? (
        <>
          <div className={styles.recValue}>
            {rec.value} <small>{unit}</small>
          </div>
          <div className={styles.recHolder}>
            {rec.holderName}
            {mine && <span className={styles.youTag}>YOU</span>}
          </div>
        </>
      ) : (
        <div className={styles.recEmpty}>—</div>
      )}
    </div>
  );
}
