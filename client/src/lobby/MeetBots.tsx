import styles from './MeetBots.module.css';

// Personality archetypes — these mirror the server's bot styles (the *which-bot-
// is-which* mapping is intentionally hidden; this only describes the types).
const TRAITS: { icon: string; name: string; line: string }[] = [
  { icon: '🪓', name: 'Aggressive', line: 'Sees a gap, swings for six. Subtlety not included.' },
  { icon: '🧱', name: 'Defensive', line: 'The wall. Good luck getting one past.' },
  { icon: '🛡️', name: 'Safe', line: 'Plays the percentages — never reckless, never out cheaply.' },
  { icon: '🎲', name: 'Risk Taker', line: 'All or nothing. Wins it in a ball… or loses it in one.' },
  { icon: '🎯', name: 'Challenger', line: 'Studies your every move and throws it right back.' },
  { icon: '🧠', name: 'Situation-wise', line: 'Reads the chase like a clock. Ice in the veins.' },
  { icon: '🌀', name: 'Chaotic', line: 'No plan, no pattern, no mercy. Pure madness.' },
  { icon: '🏏', name: 'All-Rounder', line: 'A bit of everything — the dependable all-rounder.' },
];

const ROSTER = [
  'Botinho',
  'Sir Bot-a-lot',
  'RoboHitter',
  'Bot Kohli',
  'Captain Circuit',
  'Glitch Gabbar',
  'Auto Sachin',
  'Pixel Pacer',
  'MS Droid',
  'Wall-E Willow',
  'Binary Bumrah',
  'Turbo Tendulkar',
];

export default function MeetBots({ onClose }: { onClose: () => void }) {
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>🤖 Meet our Bots</h2>
          <button className={styles.close} onClick={onClose}>
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <p className={styles.intro}>
            Every bot learns how <em>you</em> play — then leans on its own personality. Here are
            the personalities you might run into:
          </p>

          <div className={styles.traits}>
            {TRAITS.map((t) => (
              <div key={t.name} className={styles.trait}>
                <span className={styles.icon}>{t.icon}</span>
                <span className={styles.name}>{t.name}</span>
                <span className={styles.line}>{t.line}</span>
              </div>
            ))}
          </div>

          <div className={styles.rosterTitle}>The squad</div>
          <div className={styles.roster}>
            {ROSTER.map((n) => (
              <span key={n} className={styles.bot}>
                {n}
              </span>
            ))}
          </div>

          <p className={styles.discover}>
            🤫 Each bot has one fixed personality — but we’re not telling which! Play them and
            figure it out yourself.
          </p>
        </div>
      </div>
    </div>
  );
}
