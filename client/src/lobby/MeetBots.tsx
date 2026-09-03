import styles from './MeetBots.module.css';

// The "Meet our Bots" overlay renders the standalone playstyle-cards page
// (client/public/playstyles.html) in an iframe. That same file doubles as the
// shareable marketing page at /playstyles.html. It describes the 12 hidden
// playstyles only — never which bot runs which (that stays a secret).
export default function MeetBots({ onClose }: { onClose: () => void }) {
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.frameCard} onClick={(e) => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose} aria-label="Close">
          ✕
        </button>
        <iframe
          className={styles.frame}
          src="/playstyles.html"
          title="The Minds — bot playstyles"
          loading="lazy"
        />
      </div>
    </div>
  );
}
