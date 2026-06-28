import { useEffect, useState } from 'react';
import styles from './LiveBids.module.css';
import type { LiveBidOfferPayload, LiveBidWonPayload } from '@cric/types';
import type { AppSocket } from '../socket';
import type { ClientUser } from '../types';

const WINDOW_MS = 8000;

interface Props {
  socket: AppSocket;
  tournamentId: string;
  user: ClientUser | null;
}

export default function LiveBids({ socket, tournamentId, user }: Props) {
  const [offer, setOffer] = useState<LiveBidOfferPayload | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [win, setWin] = useState<LiveBidWonPayload | null>(null);

  // Room membership (watch/unwatch) is owned by the parent BotLeague while
  // spectating; here we just react to the live-bid events that arrive on it.
  useEffect(() => {
    function onOffer(o: LiveBidOfferPayload) {
      if (o.tournamentId !== tournamentId) return;
      setOffer(o);
      setPicked(null);
    }
    function onLocked(p: { id: string; optionId: string }) {
      setPicked(p.optionId); // server confirmed our lock (one offer open at a time)
    }
    function onResolved({ id }: { id: string }) {
      setOffer((o) => (o && o.id === id ? null : o));
    }
    function onWon(p: LiveBidWonPayload) {
      setWin(p);
      setTimeout(() => setWin((w) => (w === p ? null : w)), 3800);
    }
    socket.on('live_bid_offer', onOffer);
    socket.on('live_bid_locked', onLocked);
    socket.on('live_bid_resolved', onResolved);
    socket.on('live_bid_won', onWon);
    return () => {
      socket.off('live_bid_offer', onOffer);
      socket.off('live_bid_locked', onLocked);
      socket.off('live_bid_resolved', onResolved);
      socket.off('live_bid_won', onWon);
    };
  }, [socket, tournamentId]);

  // Tick for the countdown; drop the card when its window elapses.
  useEffect(() => {
    if (!offer) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [offer]);

  useEffect(() => {
    if (offer && now >= offer.expiresAt) setOffer(null);
  }, [offer, now]);

  function pick(optionId: string) {
    if (!offer || picked) return;
    if (!user) return; // must be logged in to win coins
    setPicked(optionId);
    socket.emit('place_live_bid', { id: offer.id, optionId });
  }

  const remaining = offer ? Math.max(0, offer.expiresAt - now) : 0;
  const pct = Math.round((remaining / WINDOW_MS) * 100);

  return (
    <>
      {win && (
        <div className={styles.burst}>
          <div className={styles.burstTitle}>🎉 Bid won!</div>
          <div className={styles.burstSub}>
            {win.reward > 0 ? `+${win.reward} 🪙` : 'Called it!'} · {win.label}
          </div>
        </div>
      )}

      {offer && (
        <div className={styles.card} onClick={(e) => e.stopPropagation()}>
          <div className={styles.bar} style={{ width: `${pct}%` }} />
          <div className={styles.head}>
            <span className={styles.tag}>⚡ LIVE BID</span>
            <span className={styles.reward}>win {offer.reward} 🪙</span>
          </div>
          <div className={styles.q}>{offer.question}</div>
          <div className={styles.options}>
            {offer.options.map((o) => (
              <button
                key={o.id}
                className={`${styles.opt}${picked === o.id ? ` ${styles.optPicked}` : ''}`}
                onClick={() => pick(o.id)}
                disabled={!!picked}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className={styles.foot}>
            {!user
              ? 'Log in to play live bids'
              : picked
                ? '✓ Locked — watch it play out!'
                : `Tap to predict · ${Math.ceil(remaining / 1000)}s`}
          </div>
        </div>
      )}
    </>
  );
}
