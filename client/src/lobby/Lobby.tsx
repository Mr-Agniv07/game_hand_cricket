import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { apiGet } from '../api';
import './Lobby.css';
import type { Mode, MatchHistoryEntry } from '@cric/types';
import type { AppSocket } from '../socket';
import type { ClientUser } from '../types';

const OVER_OPTIONS = [1, 2, 3, 5, 10];
const WICKET_OPTIONS = [1, 2, 3, 5, 10];

type LobbyTab = 'create' | 'join' | 'history' | 'tournament';

interface LobbyProps {
  socket: AppSocket;
  onJoinRoom: (code: string, playerName: string) => void;
  defaultName?: string;
  user?: ClientUser | null;
}

export default function Lobby({ socket, onJoinRoom, defaultName = '', user = null }: LobbyProps) {
  const [tab, setTab] = useState<LobbyTab>('create');
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState<Mode>('overs');
  const [overs, setOvers] = useState(2);
  const [wickets, setWickets] = useState(2);
  const [joinCode, setJoinCode] = useState('');
  const [joinName, setJoinName] = useState(defaultName);
  const [history, setHistory] = useState<MatchHistoryEntry[] | null>(null);
  const [tMode, setTMode] = useState<Mode>('overs');
  const [tOvers, setTOvers] = useState(2);
  const [tWickets, setTWickets] = useState(2);
  const [tSubTab, setTSubTab] = useState<'create' | 'join'>('create');
  const [tJoinCode, setTJoinCode] = useState('');

  const loggedIn = !!user;

  useEffect(() => {
    if (tab === 'history' && history === null && user?.token) {
      apiGet<MatchHistoryEntry[]>('/api/history', user.token)
        .then((data) => setHistory(data))
        .catch(() => setHistory([]));
    }
  }, [tab]);

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    const playerName = user ? user.username : name.trim();
    if (!playerName) return;
    socket.emit('create_room', { playerName, overs, mode, wickets });
  }

  function handleJoin(e: FormEvent) {
    e.preventDefault();
    const playerName = user ? user.username : joinName.trim();
    if (!playerName || !joinCode.trim()) return;
    onJoinRoom(joinCode.trim().toUpperCase(), playerName);
  }

  function handleCreateTournament(e: FormEvent) {
    e.preventDefault();
    const playerName = user ? user.username : name.trim();
    if (!playerName) return;
    socket.emit('create_tournament', { playerName, overs: tOvers, mode: tMode, wickets: tWickets });
  }

  function handleJoinTournament(e: FormEvent) {
    e.preventDefault();
    const playerName = user ? user.username : joinName.trim();
    if (!playerName || !tJoinCode.trim()) return;
    socket.emit('join_tournament', { code: tJoinCode.trim().toUpperCase(), playerName });
  }

  const s = user?.stats;

  return (
    <div className="lobby">
      {user && s && (
        <div className="stats-card">
          <div className="stats-header">{user.username}'s Stats</div>
          <div className="stats-grid">
            <div className="stat-item">
              <span className="stat-value">{s.gamesPlayed}</span>
              <span className="stat-label">Played</span>
            </div>
            <div className="stat-item">
              <span className="stat-value won">{s.wins}</span>
              <span className="stat-label">Won</span>
            </div>
            <div className="stat-item">
              <span className="stat-value lost">{s.losses}</span>
              <span className="stat-label">Lost</span>
            </div>
            <div className="stat-item">
              <span className="stat-value tied">{s.ties}</span>
              <span className="stat-label">Tied</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">{s.runsScored}</span>
              <span className="stat-label">Runs</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">{s.highScore}</span>
              <span className="stat-label">Best</span>
            </div>
          </div>
        </div>
      )}

      <div className="tabs">
        <button
          className={tab === 'create' ? 'tab active' : 'tab'}
          onClick={() => setTab('create')}
        >
          Create
        </button>
        <button className={tab === 'join' ? 'tab active' : 'tab'} onClick={() => setTab('join')}>
          Join
        </button>
        <button
          className={tab === 'tournament' ? 'tab active' : 'tab'}
          onClick={() => setTab('tournament')}
        >
          Tournament
        </button>
        {loggedIn && (
          <button
            className={tab === 'history' ? 'tab active' : 'tab'}
            onClick={() => setTab('history')}
          >
            History
          </button>
        )}
      </div>

      {tab === 'create' && (
        <form className="card form" onSubmit={handleCreate}>
          {!loggedIn && (
            <>
              <label>Your Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter your name"
                maxLength={20}
                autoFocus
                required
              />
            </>
          )}
          <label>Game Mode</label>
          <div className="over-options">
            <button
              type="button"
              className={mode === 'overs' ? 'over-btn selected' : 'over-btn'}
              onClick={() => setMode('overs')}
            >
              Overs
            </button>
            <button
              type="button"
              className={mode === 'wickets' ? 'over-btn selected' : 'over-btn'}
              onClick={() => setMode('wickets')}
            >
              Wickets
            </button>
          </div>

          {mode === 'overs' && (
            <>
              <label>Number of Overs</label>
              <div className="over-options">
                {OVER_OPTIONS.map((o) => (
                  <button
                    key={o}
                    type="button"
                    className={overs === o ? 'over-btn selected' : 'over-btn'}
                    onClick={() => setOvers(o)}
                  >
                    {o}
                  </button>
                ))}
              </div>
              <label>Wickets per Innings</label>
              <div className="over-options">
                {WICKET_OPTIONS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={wickets === w ? 'over-btn selected' : 'over-btn'}
                    onClick={() => setWickets(w)}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </>
          )}

          {mode === 'wickets' && (
            <>
              <label>Number of Wickets</label>
              <div className="over-options">
                {WICKET_OPTIONS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={wickets === w ? 'over-btn selected' : 'over-btn'}
                    onClick={() => setWickets(w)}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </>
          )}

          <button type="submit" className="btn-primary">
            Create Room
          </button>
        </form>
      )}

      {tab === 'join' && (
        <form className="card form" onSubmit={handleJoin}>
          {!loggedIn && (
            <>
              <label>Your Name</label>
              <input
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                placeholder="Enter your name"
                maxLength={20}
                autoFocus
                required
              />
            </>
          )}
          <label>Room Code</label>
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="e.g. AB3XZ"
            maxLength={5}
            required
          />
          <button type="submit" className="btn-primary">
            Join Game
          </button>
        </form>
      )}

      {tab === 'tournament' && (
        <div className="card form">
          <div className="t-sub-tabs">
            <button
              type="button"
              className={tSubTab === 'create' ? 'tab active' : 'tab'}
              onClick={() => setTSubTab('create')}
            >
              Create
            </button>
            <button
              type="button"
              className={tSubTab === 'join' ? 'tab active' : 'tab'}
              onClick={() => setTSubTab('join')}
            >
              Join
            </button>
          </div>

          {tSubTab === 'create' && (
            <form
              onSubmit={handleCreateTournament}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '.6rem',
                marginTop: '.75rem',
              }}
            >
              {!loggedIn && (
                <>
                  <label>Your Name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Enter your name"
                    maxLength={20}
                    required
                  />
                </>
              )}
              <label>Game Mode</label>
              <div className="over-options">
                <button
                  type="button"
                  className={tMode === 'overs' ? 'over-btn selected' : 'over-btn'}
                  onClick={() => setTMode('overs')}
                >
                  Overs
                </button>
                <button
                  type="button"
                  className={tMode === 'wickets' ? 'over-btn selected' : 'over-btn'}
                  onClick={() => setTMode('wickets')}
                >
                  Wickets
                </button>
              </div>
              {tMode === 'overs' && (
                <>
                  <label>Overs per Match</label>
                  <div className="over-options">
                    {OVER_OPTIONS.map((o) => (
                      <button
                        key={o}
                        type="button"
                        className={tOvers === o ? 'over-btn selected' : 'over-btn'}
                        onClick={() => setTOvers(o)}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {tMode === 'wickets' && (
                <>
                  <label>Wickets per Match</label>
                  <div className="over-options">
                    {WICKET_OPTIONS.map((w) => (
                      <button
                        key={w}
                        type="button"
                        className={tWickets === w ? 'over-btn selected' : 'over-btn'}
                        onClick={() => setTWickets(w)}
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <p style={{ fontSize: '.8rem', color: 'var(--muted)', margin: '.2rem 0' }}>
                4-player round-robin · 12 matches · Win=2pts, Tie=1pt, Loss=0pts
              </p>
              <button type="submit" className="btn-primary">
                Create Tournament
              </button>
            </form>
          )}

          {tSubTab === 'join' && (
            <form
              onSubmit={handleJoinTournament}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '.6rem',
                marginTop: '.75rem',
              }}
            >
              {!loggedIn && (
                <>
                  <label>Your Name</label>
                  <input
                    value={joinName}
                    onChange={(e) => setJoinName(e.target.value)}
                    placeholder="Enter your name"
                    maxLength={20}
                    required
                  />
                </>
              )}
              <label>Tournament Code</label>
              <input
                value={tJoinCode}
                onChange={(e) => setTJoinCode(e.target.value.toUpperCase())}
                placeholder="e.g. AB3XZ"
                maxLength={5}
                required
              />
              <button type="submit" className="btn-primary">
                Join Tournament
              </button>
            </form>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="card history-card">
          <div className="stats-header">Last 10 Matches</div>
          {history === null ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '1.5rem' }}>
              <div className="spinner" />
            </div>
          ) : history.length === 0 ? (
            <p className="fp-empty" style={{ marginTop: '.5rem' }}>
              No matches played yet.
            </p>
          ) : (
            <div className="history-list">
              {history.map((m, i) => (
                <div key={i} className={`history-row ${m.result}`}>
                  <span className={`history-badge ${m.result}`}>
                    {m.result === 'win' ? 'W' : m.result === 'loss' ? 'L' : 'T'}
                  </span>
                  <div className="history-info">
                    <span className="history-opp">vs {m.opponent}</span>
                    <span className="history-meta">
                      {m.mode === 'overs'
                        ? `${m.count} over${m.count !== 1 ? 's' : ''}`
                        : `${m.count} wicket${m.count !== 1 ? 's' : ''}`}
                    </span>
                  </div>
                  <div className="history-right">
                    <span className="history-score">
                      {m.myScore} – {m.oppScore}
                    </span>
                    <span className="history-date">
                      {new Date(m.date).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
