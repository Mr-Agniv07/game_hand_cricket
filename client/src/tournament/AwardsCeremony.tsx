import { useEffect, useState } from 'react';
import type { TournamentAwards } from '@cric/types';
import { sounds } from '../sound';
import styles from './AwardsCeremony.module.css';

/** One award the viewing player has won, ready for display. */
export interface CeremonyAward {
  key: string;
  icon: string;
  title: string;
  blurb: string;
  stat: string;
}

/**
 * Which of the tournament awards the player called `myName` won, in order of
 * prestige (Player of the Tournament first). Returns [] if they won none — the
 * caller uses that to skip the ceremony entirely.
 */
export function wonAwardsFor(
  awards: TournamentAwards | null | undefined,
  myName: string | null | undefined
): CeremonyAward[] {
  if (!awards || !myName) return [];
  const out: CeremonyAward[] = [];
  if (awards.playerOfTournament?.name === myName) {
    const p = awards.playerOfTournament;
    out.push({
      key: 'potm',
      icon: '⭐',
      title: 'Player of the Tournament',
      blurb: 'The standout performer of the entire tournament',
      stat: `${p.runs} runs · ${p.wickets} wkts · ${p.sixes} sixes`,
    });
  }
  if (awards.orangeCap?.name === myName) {
    out.push({
      key: 'orange',
      icon: '🟠',
      title: 'Orange Cap',
      blurb: 'Most runs scored across the tournament',
      stat: `${awards.orangeCap.runs} runs`,
    });
  }
  if (awards.purpleCap?.name === myName) {
    out.push({
      key: 'purple',
      icon: '🟣',
      title: 'Purple Cap',
      blurb: 'Most wickets taken across the tournament',
      stat: `${awards.purpleCap.wickets} wickets`,
    });
  }
  if (awards.mostSixes?.name === myName) {
    out.push({
      key: 'sixes',
      icon: '6️⃣',
      title: 'Most Sixes',
      blurb: 'Cleared the ropes more than anyone else',
      stat: `${awards.mostSixes.sixes} sixes`,
    });
  }
  return out;
}

const CONFETTI = ['#22c55e', '#f59e0b', '#60a5fa', '#ef4444', '#a855f7', '#fff'];

export default function AwardsCeremony({
  awards,
  onDone,
}: {
  awards: CeremonyAward[];
  onDone: () => void;
}) {
  const [idx, setIdx] = useState(0);

  // Defensive: caller only mounts us with awards, but never trap the user if not.
  useEffect(() => {
    if (awards.length === 0) onDone();
  }, [awards.length, onDone]);

  // A little fanfare each time a new award is revealed.
  useEffect(() => {
    if (awards.length > 0) sounds.win();
  }, [idx, awards.length]);

  if (awards.length === 0) return null;

  const award = awards[idx];
  const isLast = idx === awards.length - 1;
  const multiple = awards.length > 1;

  return (
    <div className="center-screen">
      <div className={styles.confetti} aria-hidden="true">
        {Array.from({ length: 36 }).map((_, i) => (
          <span
            key={i}
            className={styles.piece}
            style={{
              left: `${Math.random() * 100}%`,
              background: CONFETTI[i % CONFETTI.length],
              animationDelay: `${Math.random() * 0.8}s`,
              animationDuration: `${1.8 + Math.random() * 1.6}s`,
            }}
          />
        ))}
      </div>

      <div className={`card ${styles.card}`} key={award.key}>
        <div className={styles.congrats}>Congratulations!</div>
        <div className={styles.medal}>
          <span className={styles.icon}>{award.icon}</span>
        </div>
        <div className={styles.youWon}>You won the</div>
        <h2 className={styles.title}>{award.title}</h2>
        <p className={styles.blurb}>{award.blurb}</p>
        <div className={styles.stat}>{award.stat}</div>

        {multiple && (
          <div className={styles.dots}>
            {awards.map((a, i) => (
              <span key={a.key} className={`${styles.dot} ${i === idx ? styles.dotActive : ''}`} />
            ))}
          </div>
        )}

        <button
          className="btn-primary"
          onClick={() => (isLast ? onDone() : setIdx((i) => i + 1))}
        >
          {isLast ? 'See Tournament Summary →' : 'Next Award →'}
        </button>
      </div>
    </div>
  );
}
