import { useRef, useState } from 'react';
import styles from './WelcomeScreen.module.css';
import logo from '../assets/logo.png';

/**
 * Branded landing screen shown once on app open, before the login/lobby. Displays
 * the Hand Cricket logo and stays until the user taps to continue (no auto-dismiss).
 */
export default function WelcomeScreen({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);

  // Fade out, then hand control back to the app. Guarded so a double-tap can't
  // fire onDone twice.
  const dismiss = () => {
    if (done.current) return;
    done.current = true;
    setLeaving(true);
    setTimeout(onDone, 350);
  };

  return (
    <div
      className={`${styles.welcome}${leaving ? ` ${styles.leaving}` : ''}`}
      onClick={dismiss}
      role="button"
      aria-label="Tap to continue"
    >
      <img className={styles.logo} src={logo} alt="Hand Cricket" />
      <div className={styles.hint}>Tap to continue</div>
    </div>
  );
}
