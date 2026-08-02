import { useEffect, useRef, useState } from 'react';
import styles from './WelcomeScreen.module.css';
import logo from '../assets/logo.png';

/**
 * Branded landing screen shown once on app open, before the login/lobby. Displays
 * the Hand Cricket logo, then auto-dismisses after a short beat (tap to skip).
 */
export default function WelcomeScreen({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);

  // Fade out, then hand control back to the app. Guarded so tap + timer can't
  // both fire onDone.
  const dismiss = () => {
    if (done.current) return;
    done.current = true;
    setLeaving(true);
    setTimeout(onDone, 350);
  };

  useEffect(() => {
    const t = setTimeout(dismiss, 2400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`${styles.welcome}${leaving ? ` ${styles.leaving}` : ''}`}
      onClick={dismiss}
      role="button"
      aria-label="Continue"
    >
      <img className={styles.logo} src={logo} alt="Hand Cricket" />
      <div className={styles.hint}>Tap to continue</div>
    </div>
  );
}
