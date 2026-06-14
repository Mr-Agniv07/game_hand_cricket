import { useState, useEffect } from 'react';
import { apiGet, apiPost, apiDelete } from '../api';

const OVER_OPTIONS   = [1, 2, 3, 5, 10];
const WICKET_OPTIONS = [1, 2, 3, 5, 10];

export default function FriendsPanel({ user, socket, phase, onClose }) {
  const [tab, setTab] = useState('friends');

  // Friends tab
  const [friends, setFriends]           = useState([]);
  const [removingId, setRemovingId]     = useState(null);

  // Search tab
  const [query, setQuery]               = useState('');
  const [results, setResults]           = useState([]);
  const [searchBusy, setSearchBusy]     = useState(false);
  const [addingId, setAddingId]         = useState(null);

  // Challenge sub-form
  const [challengingId, setChallengingId] = useState(null);
  const [cMode, setCMode]               = useState('overs');
  const [cOvers, setCOvers]             = useState(2);
  const [cWickets, setCWickets]         = useState(2);
  const [sentTo, setSentTo]             = useState(null);   // { id, username }
  const [panelMsg, setPanelMsg]         = useState('');

  const canChallenge = phase === 'lobby';

  // ── Load friends whenever tab switches to friends ───────────────────────────
  useEffect(() => {
    if (tab === 'friends') loadFriends();
  }, [tab]);

  // ── Socket: challenge outcome ────────────────────────────────────────────────
  useEffect(() => {
    function onDeclined({ username }) {
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
    socket.on('challenge_expired',  onExpired);
    socket.on('challenge_room_start', onRoomStart);
    return () => {
      socket.off('challenge_declined', onDeclined);
      socket.off('challenge_expired',  onExpired);
      socket.off('challenge_room_start', onRoomStart);
    };
  }, [socket]);

  function showMsg(msg) {
    setPanelMsg(msg);
    setTimeout(() => setPanelMsg(''), 4000);
  }

  async function loadFriends() {
    try {
      const data = await apiGet('/api/friends', user.token);
      setFriends(data);
    } catch {}
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  async function handleSearch(e) {
    const q = e.target.value;
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); return; }
    setSearchBusy(true);
    try {
      const data = await apiGet(`/api/users/search?q=${encodeURIComponent(q.trim())}`, user.token);
      setResults(data);
    } catch {} finally {
      setSearchBusy(false);
    }
  }

  async function handleAdd(friendId) {
    setAddingId(friendId);
    try {
      await apiPost('/api/friends/add', { friendId }, user.token);
      setResults(r => r.map(u => u.id === friendId ? { ...u, isFriend: true } : u));
    } catch (err) {
      showMsg(err.message);
    } finally {
      setAddingId(null);
    }
  }

  async function handleRemove(friendId) {
    setRemovingId(friendId);
    try {
      await apiDelete(`/api/friends/${friendId}`, user.token);
      setFriends(f => f.filter(fr => fr.id !== friendId));
    } catch {} finally {
      setRemovingId(null);
    }
  }

  // ── Challenge ───────────────────────────────────────────────────────────────
  function toggleChallenge(friend) {
    if (sentTo) return;
    setChallengingId(id => id === friend.id ? null : friend.id);
  }

  function sendChallenge(friend) {
    socket.emit('send_challenge', {
      toUserId: friend.id,
      mode: cMode,
      overs: cOvers,
      wickets: cWickets,
    });
    setSentTo({ id: friend.id, username: friend.username });
    setChallengingId(null);
  }

  return (
    <div className="friends-overlay" onClick={onClose}>
      <div className="friends-panel" onClick={e => e.stopPropagation()}>

        <div className="friends-header">
          <h2>Friends</h2>
          <button className="friends-close" onClick={onClose}>✕</button>
        </div>

        <div className="fp-tabs">
          <button className={tab === 'friends' ? 'fp-tab active' : 'fp-tab'} onClick={() => setTab('friends')}>My Friends</button>
          <button className={tab === 'search'  ? 'fp-tab active' : 'fp-tab'} onClick={() => setTab('search')}>Find Players</button>
        </div>

        {panelMsg && <div className="fp-msg">{panelMsg}</div>}
        {sentTo && (
          <div className="fp-msg waiting">
            Waiting for <strong>{sentTo.username}</strong> to respond…
          </div>
        )}

        <div className="friends-body">

          {/* ── My Friends ── */}
          {tab === 'friends' && (
            friends.length === 0
              ? <p className="fp-empty">No friends yet — use Find Players to search!</p>
              : friends.map(f => (
                <div key={f.id} className="fp-row">
                  <span className={`fp-dot ${f.online ? 'online' : 'offline'}`} />
                  <div className="fp-info">
                    <span className="fp-name">{f.username}</span>
                    <span className="fp-stat">W {f.stats.wins} · L {f.stats.losses}</span>
                  </div>
                  <div className="fp-actions">
                    {f.online && canChallenge && !sentTo && (
                      <button
                        className={`fp-challenge-btn${challengingId === f.id ? ' cancel' : ''}`}
                        onClick={() => toggleChallenge(f)}
                      >
                        {challengingId === f.id ? 'Cancel' : '⚡'}
                      </button>
                    )}
                    <button
                      className="fp-remove-btn"
                      onClick={() => handleRemove(f.id)}
                      disabled={removingId === f.id}
                    >✕</button>
                  </div>

                  {challengingId === f.id && (
                    <div className="challenge-form">
                      <div className="over-options">
                        <button type="button" className={cMode === 'overs'   ? 'over-btn selected' : 'over-btn'} onClick={() => setCMode('overs')}>Overs</button>
                        <button type="button" className={cMode === 'wickets' ? 'over-btn selected' : 'over-btn'} onClick={() => setCMode('wickets')}>Wickets</button>
                      </div>
                      <div className="over-options">
                        {(cMode === 'overs' ? OVER_OPTIONS : WICKET_OPTIONS).map(n => (
                          <button key={n} type="button"
                            className={(cMode === 'overs' ? cOvers : cWickets) === n ? 'over-btn selected' : 'over-btn'}
                            onClick={() => cMode === 'overs' ? setCOvers(n) : setCWickets(n)}
                          >{n}</button>
                        ))}
                      </div>
                      <button className="btn-primary" style={{ marginTop: '.5rem' }} onClick={() => sendChallenge(f)}>
                        Send Challenge
                      </button>
                    </div>
                  )}
                </div>
              ))
          )}

          {/* ── Find Players ── */}
          {tab === 'search' && (
            <>
              <input
                className="fp-search"
                placeholder="Search by username…"
                value={query}
                onChange={handleSearch}
                autoFocus
              />
              {searchBusy && <p className="fp-empty">Searching…</p>}
              {results.map(u => (
                <div key={u.id} className="fp-row">
                  <span className={`fp-dot ${u.online ? 'online' : 'offline'}`} />
                  <div className="fp-info">
                    <span className="fp-name">{u.username}</span>
                  </div>
                  <button
                    className={u.isFriend ? 'fp-added-btn' : 'fp-add-btn'}
                    disabled={u.isFriend || addingId === u.id}
                    onClick={() => !u.isFriend && handleAdd(u.id)}
                  >
                    {u.isFriend ? 'Friends ✓' : addingId === u.id ? 'Adding…' : '+ Add'}
                  </button>
                </div>
              ))}
              {!searchBusy && query.trim().length >= 2 && results.length === 0 && (
                <p className="fp-empty">No players found.</p>
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}
