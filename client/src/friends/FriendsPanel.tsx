import { useState, useEffect } from 'react';
import type { ChangeEvent } from 'react';
import { apiGet, apiPost, apiDelete } from '../api';
import styles from './FriendsPanel.module.css';
import type { Friend, SearchResult, ChallengeDeclinedPayload } from '@cric/types';
import type { AppSocket } from '../socket';
import type { ClientUser, AppPhase } from '../types';

const OVER_OPTIONS = [1, 2, 3, 5, 10];
const WICKET_OPTIONS = [1, 2, 3, 5, 10];

interface FriendsPanelProps {
  user: ClientUser;
  socket: AppSocket;
  phase: AppPhase;
  onClose: () => void;
}

export default function FriendsPanel({ user, socket, phase, onClose }: FriendsPanelProps) {
  const [tab, setTab] = useState<'friends' | 'search'>('friends');

  // Friends tab
  const [friends, setFriends] = useState<Friend[]>([]);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Search tab
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);

  // Challenge sub-form
  const [challengingId, setChallengingId] = useState<string | null>(null);
  const [cOvers, setCOvers] = useState(2);
  const [cWickets, setCWickets] = useState(2);
  const [sentTo, setSentTo] = useState<{ id: string; username: string } | null>(null);
  const [panelMsg, setPanelMsg] = useState('');

  const canChallenge = phase === 'lobby';

  // ── Load friends whenever tab switches to friends ───────────────────────────
  useEffect(() => {
    if (tab === 'friends') loadFriends();
  }, [tab]);

  // ── Socket: challenge outcome ────────────────────────────────────────────────
  useEffect(() => {
    function onDeclined({ username }: ChallengeDeclinedPayload) {
      setSentTo(null);
      setChallengingId(null);
      showMsg(`${username} declined your challenge.`);
    }
    function onExpired() {
      setSentTo(null);
      setChallengingId(null);
      showMsg('Challenge expired — no response.');
    }
    function onRoomStart() {
      setSentTo(null); // game starting, App.jsx handles the rest
    }
    socket.on('challenge_declined', onDeclined);
    socket.on('challenge_expired', onExpired);
    socket.on('challenge_room_start', onRoomStart);
    return () => {
      socket.off('challenge_declined', onDeclined);
      socket.off('challenge_expired', onExpired);
      socket.off('challenge_room_start', onRoomStart);
    };
  }, [socket]);

  function showMsg(msg: string) {
    setPanelMsg(msg);
    setTimeout(() => setPanelMsg(''), 4000);
  }

  async function loadFriends() {
    try {
      const data = await apiGet<Friend[]>('/api/friends', user.token);
      setFriends(data);
    } catch {}
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  async function handleSearch(e: ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setQuery(q);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearchBusy(true);
    try {
      const data = await apiGet<SearchResult[]>(
        `/api/users/search?q=${encodeURIComponent(q.trim())}`,
        user.token
      );
      setResults(data);
    } catch {
    } finally {
      setSearchBusy(false);
    }
  }

  async function handleAdd(friendId: string) {
    setAddingId(friendId);
    try {
      await apiPost('/api/friends/add', { friendId }, user.token);
      setResults((r) => r.map((u) => (u.id === friendId ? { ...u, isFriend: true } : u)));
    } catch (err) {
      showMsg(err instanceof Error ? err.message : 'Could not add friend.');
    } finally {
      setAddingId(null);
    }
  }

  async function handleRemove(friendId: string) {
    setRemovingId(friendId);
    try {
      await apiDelete(`/api/friends/${friendId}`, user.token);
      setFriends((f) => f.filter((fr) => fr.id !== friendId));
    } catch {
    } finally {
      setRemovingId(null);
    }
  }

  // ── Challenge ───────────────────────────────────────────────────────────────
  function toggleChallenge(friend: Friend) {
    if (sentTo) return;
    setChallengingId((id) => (id === friend.id ? null : friend.id));
  }

  function sendChallenge(friend: Friend) {
    socket.emit('send_challenge', {
      toUserId: friend.id,
      overs: cOvers,
      wickets: cWickets,
    });
    setSentTo({ id: friend.id, username: friend.username });
    setChallengingId(null);
  }

  return (
    <div className={styles['friends-overlay']} onClick={onClose}>
      <div className={styles['friends-panel']} onClick={(e) => e.stopPropagation()}>
        <div className={styles['friends-header']}>
          <h2>Friends</h2>
          <button className={styles['friends-close']} onClick={onClose}>
            ✕
          </button>
        </div>

        <div className={styles['fp-tabs']}>
          <button
            className={tab === 'friends' ? `${styles['fp-tab']} ${styles.active}` : styles['fp-tab']}
            onClick={() => setTab('friends')}
          >
            My Friends
          </button>
          <button
            className={tab === 'search' ? `${styles['fp-tab']} ${styles.active}` : styles['fp-tab']}
            onClick={() => setTab('search')}
          >
            Find Players
          </button>
        </div>

        {panelMsg && <div className={styles['fp-msg']}>{panelMsg}</div>}
        {sentTo && (
          <div className={`${styles['fp-msg']} ${styles.waiting}`}>
            Waiting for <strong>{sentTo.username}</strong> to respond…
          </div>
        )}

        <div className={styles['friends-body']}>
          {/* ── My Friends ── */}
          {tab === 'friends' &&
            (friends.length === 0 ? (
              <p className={styles['fp-empty']}>No friends yet — use Find Players to search!</p>
            ) : (
              friends.map((f) => (
                <div key={f.id} className={styles['fp-row']}>
                  <span className={`${styles['fp-dot']} ${f.online ? styles.online : styles.offline}`} />
                  <div className={styles['fp-info']}>
                    <span className={styles['fp-name']}>{f.username}</span>
                    <span className={styles['fp-stat']}>
                      W {f.stats.wins} · L {f.stats.losses}
                    </span>
                  </div>
                  <div className={styles['fp-actions']}>
                    {f.online && canChallenge && !sentTo && (
                      <button
                        className={`${styles['fp-challenge-btn']}${challengingId === f.id ? ` ${styles.cancel}` : ''}`}
                        onClick={() => toggleChallenge(f)}
                      >
                        {challengingId === f.id ? 'Cancel' : '⚡'}
                      </button>
                    )}
                    <button
                      className={styles['fp-remove-btn']}
                      onClick={() => handleRemove(f.id)}
                      disabled={removingId === f.id}
                    >
                      ✕
                    </button>
                  </div>

                  {challengingId === f.id && (
                    <div className={styles['challenge-form']}>
                      <label style={{ fontSize: '.72rem', color: 'var(--muted)', fontWeight: 700 }}>
                        Overs
                      </label>
                      <div className="over-options">
                        {OVER_OPTIONS.map((n) => (
                          <button
                            key={n}
                            type="button"
                            className={cOvers === n ? 'over-btn selected' : 'over-btn'}
                            onClick={() => setCOvers(n)}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                      <label style={{ fontSize: '.72rem', color: 'var(--muted)', fontWeight: 700 }}>
                        Wickets
                      </label>
                      <div className="over-options">
                        {WICKET_OPTIONS.map((n) => (
                          <button
                            key={n}
                            type="button"
                            className={cWickets === n ? 'over-btn selected' : 'over-btn'}
                            onClick={() => setCWickets(n)}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                      <button
                        className="btn-primary"
                        style={{ marginTop: '.5rem' }}
                        onClick={() => sendChallenge(f)}
                      >
                        Send Challenge
                      </button>
                    </div>
                  )}
                </div>
              ))
            ))}

          {/* ── Find Players ── */}
          {tab === 'search' && (
            <>
              <input
                className={styles['fp-search']}
                placeholder="Search by username…"
                value={query}
                onChange={handleSearch}
                autoFocus
              />
              {searchBusy && <p className={styles['fp-empty']}>Searching…</p>}
              {results.map((u) => (
                <div key={u.id} className={styles['fp-row']}>
                  <span className={`${styles['fp-dot']} ${u.online ? styles.online : styles.offline}`} />
                  <div className={styles['fp-info']}>
                    <span className={styles['fp-name']}>{u.username}</span>
                  </div>
                  <button
                    className={u.isFriend ? styles['fp-added-btn'] : styles['fp-add-btn']}
                    disabled={u.isFriend || addingId === u.id}
                    onClick={() => !u.isFriend && handleAdd(u.id)}
                  >
                    {u.isFriend ? 'Friends ✓' : addingId === u.id ? 'Adding…' : '+ Add'}
                  </button>
                </div>
              ))}
              {!searchBusy && query.trim().length >= 2 && results.length === 0 && (
                <p className={styles['fp-empty']}>No players found.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
