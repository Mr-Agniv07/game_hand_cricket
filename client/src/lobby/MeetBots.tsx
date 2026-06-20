import styles from './MeetBots.module.css';

// Personality archetypes — these mirror the server's bot styles (the *which-bot-
// is-which* mapping is intentionally hidden; this only describes the types).
const TRAITS: { icon: string; name: string; line: string }[] = [
  { icon: '🔥', name: 'Aggressor', line: "“I’d rather lose fast than win slow.” Lives on 4s, 5s and 6s." },
  { icon: '🎲', name: 'Gambler', line: 'Big risks, big rewards. Streaky genius — you never know what’s next.' },
  { icon: '⚖️', name: 'All-Rounder', line: 'A bit of everything — does whatever gives the best shot at winning.' },
  { icon: '🌀', name: 'Chaos', line: 'No plan, no pattern. Reinvents itself every few balls. Pure madness.' },
  { icon: '🎯', name: 'Hunter', line: 'Plays against YOU — learns your habits and turns them against you.' },
  { icon: '🧠', name: 'Strategist', line: 'The scoreboard decides everything. Cold, calculated, ice in the veins.' },
  { icon: '🧱', name: 'Wall', line: 'Lives at 1, 2, 3. Good luck getting one past it.' },
  { icon: '🛡️', name: 'Guardian', line: '“I don’t make mistakes.” Boring, disciplined, brutally effective.' },
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
