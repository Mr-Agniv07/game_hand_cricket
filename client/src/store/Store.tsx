import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api';
import styles from './Store.module.css';
import type { StoreItem } from '@cric/types';
import type { ClientUser } from '../types';

interface UnlockResult {
  ok: boolean;
  error?: string;
  coins: number;
  unlocks: string[];
}

const ICONS: Record<string, string> = {
  over5: '🏏',
  over10: '🏟️',
  tourney8: '🏆',
  emotes: '😎',
};

export default function Store({
  user,
  onClose,
  onEconomyChange,
}: {
  user: ClientUser;
  onClose: () => void;
  onEconomyChange: (coins: number, unlocks: string[]) => void;
}) {
  const [items, setItems] = useState<StoreItem[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    apiGet<{ items: StoreItem[] }>('/api/store')
      .then((d) => setItems(d.items))
      .catch(() => setItems([]));
  }, []);

  async function buy(item: StoreItem) {
    if (user.coins < item.price) {
      setMsg(`You need ${item.price - user.coins} more coins for ${item.label}.`);
      return;
    }
    setBusyId(item.id);
    setMsg('');
    try {
      const res = await apiPost<UnlockResult>('/api/unlock', { itemId: item.id }, user.token);
      onEconomyChange(res.coins, res.unlocks);
      setMsg(`Unlocked ${item.label}! 🎉`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not complete the purchase.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>🛒 Store</h2>
          <div className={styles.balance}>🪙 {user.coins}</div>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {msg && <div className={styles.msg}>{msg}</div>}

        <div className={styles.body}>
          <p className={styles.hint}>
            Earn coins by finishing online Quick Matches against strangers, and by winning a
            tournament that has a friend in it. Spend them here to unlock longer formats, bigger
            tournaments and more emotes.
          </p>
          {items === null ? (
            <div className={styles.loading}>
              <div className="spinner" />
            </div>
          ) : (
            items.map((item) => {
              const owned = user.unlocks.includes(item.id);
              const affordable = user.coins >= item.price;
              return (
                <div key={item.id} className={styles.item}>
                  <span className={styles.icon}>{ICONS[item.id] ?? '🔓'}</span>
                  <div className={styles.info}>
                    <span className={styles.label}>{item.label}</span>
                    <span className={styles.desc}>{item.description}</span>
                  </div>
                  {owned ? (
                    <span className={styles.owned}>Owned ✓</span>
                  ) : (
                    <button
                      className={styles.buy}
                      onClick={() => buy(item)}
                      disabled={busyId === item.id || !affordable}
                      title={affordable ? '' : 'Not enough coins'}
                    >
                      {busyId === item.id ? '…' : `🪙 ${item.price}`}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
