import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { apiGet } from '../api';
import styles from './Lobby.module.css';
import MeetBots from './MeetBots';
import GlobalStandings from './GlobalStandings';
import type { MatchHistoryEntry } from '@cric/types';
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
  const [overs, setOvers] = useState(2);
  const [wickets, setWickets] = useState(2);
  const [joinCode, setJoinCode] = useState('');
  const [joinName, setJoinName] = useState(defaultName);
  const [history, setHistory] = useState<MatchHistoryEntry[] | null>(null);
  const [tOvers, setTOvers] = useState(2);
  const [tWickets, setTWickets] = useState(2);
  const [tSize, setTSize] = useState<4 | 8>(4);
  const [tSubTab, setTSubTab] = useState<'create' | 'join'>('create');
  const [tJoinCode, setTJoinCode] = useState('');
  const [showBots, setShowBots] = useState(false);
  const [showStandings, setShowStandings] = useState(false);

  const loggedIn = !!user;

  // Refetch each time the History tab is opened so a freshly-finished match
  // shows; keep any existing list visible (no spinner flash) while reloading.
  useEffect(() => {
    if (tab === 'history' && user?.token) {
      apiGet<MatchHistoryEntry[]>('/api/history', user.token)
        .then((data) => setHistory(data))
        .catch(() => setHistory((h) => h ?? []));
    }
  }, [tab]);

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    const playerName = user ? user.username : name.trim();
    if (!playerName) return;
    socket.emit('create_room', { playerName, overs, wickets });
  }

  function handlePlayBot() {
    const playerName = user ? user.username : name.trim();
    if (!playerName) return;
    socket.emit('play_vs_bot', { playerName, overs, wickets });
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
    socket.emit('create_tournament', {
      playerName,
      overs: tOvers,
      wickets: tWickets,
      size: tSize,
    });
  }

  function handleJoinTournament(e: FormEvent) {
    e.preventDefault();
    const playerName = user ? user.username : joinName.trim();
    if (!playerName || !tJoinCode.trim()) return;
    socket.emit('join_tournament', { code: tJoinCode.trim().toUpperCase(), playerName });
  }

  const s = user?.stats;

  return (
    <div className={styles['lobby']}>
      {user && s && (
        <div className={styles['stats-card']}>
          <div className={styles['stats-header']}>{user.username}'s Stats</div>
          <div className={styles['stats-grid']}>
            <div className={styles['stat-item']}>
              <span className={styles['stat-value']}>{s.gamesPlayed}</span>
              <span className={styles['stat-label']}>Played</span>
            </div>
            <div className={styles['stat-item']}>
              <span className={`${styles['stat-value']} ${styles.won}`}>{s.wins}</span>
              <span className={styles['stat-label']}>Won</span>
            </div>
            <div className={styles['stat-item']}>
              <span className={`${styles['stat-value']} ${styles.lost}`}>{s.losses}</span>
              <span className={styles['stat-label']}>Lost</span>
            </div>
            <div className={styles['stat-item']}>
              <span className={`${styles['stat-value']} ${styles.tied}`}>{s.ties}</span>
              <span className={styles['stat-label']}>Tied</span>
            </div>
            <div className={styles['stat-item']}>
              <span className={styles['stat-value']}>{s.runsScored}</span>
              <span className={styles['stat-label']}>Runs</span>
            </div>
            <div className={styles['stat-item']}>
              <span className={styles['stat-value']}>{s.highScore}</span>
              <span className={styles['stat-label']}>Best</span>
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

      <div className={styles['lobby-links']}>
        <button
          type="button"
          className={styles['meet-bots-link']}
          onClick={() => setShowStandings(true)}
        >
          🌍 Global Standings
        </button>
        <button
          type="button"
          className={styles['meet-bots-link']}
          onClick={() => setShowBots(true)}
        >
          🤖 Meet our Bots
        </button>
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
          <h3 className={styles['mode-title']}>Choose your game mode</h3>
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

          <p style={{ fontSize: '.8rem', color: 'var(--muted)', margin: '.2rem 0' }}>
            Innings ends at {overs} over{overs !== 1 ? 's' : ''} or {wickets} wicket
            {wickets !== 1 ? 's' : ''} — whichever comes first.
          </p>

          <button type="submit" className="btn-primary">
            Create Room
          </button>
          <button type="button" className={styles['bot-btn']} onClick={handlePlayBot}>
            🤖 Play vs Bot
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
          <div className={styles['t-sub-tabs']}>
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
              <label>Players</label>
              <div className="over-options">
                {([4, 8] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={tSize === n ? 'over-btn selected' : 'over-btn'}
                    onClick={() => setTSize(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
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
              <p style={{ fontSize: '.8rem', color: 'var(--muted)', margin: '.2rem 0', lineHeight: 1.4 }}>
                {tSize === 8 ? (
                  <>
                    8 players · two groups of 4 · top 2 of each group reach the
                    semi-finals, then the <strong style={{ color: '#fbbf24' }}>FINAL</strong>.
                  </>
                ) : (
                  <>
                    4 players · round-robin (12 matches) · then the top 2 play a{' '}
                    <strong style={{ color: '#fbbf24' }}>FINAL</strong> for the title.
                  </>
                )}{' '}
                Short of players? Empty seats fill with bots.
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
        <div className={`card ${styles['history-card']}`}>
          <div className={styles['stats-header']}>Last 10 Matches</div>
          {history === null ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '1.5rem' }}>
              <div className="spinner" />
            </div>
          ) : history.length === 0 ? (
            <p className={styles['fp-empty']} style={{ marginTop: '.5rem' }}>
              No matches played yet.
            </p>
          ) : (
            <div className={styles['history-list']}>
              {history.map((m, i) => (
                <div key={i} className={`${styles['history-row']} ${styles[m.result]}`}>
                  <span className={`${styles['history-badge']} ${styles[m.result]}`}>
                    {m.result === 'win' ? 'W' : m.result === 'loss' ? 'L' : 'T'}
                  </span>
                  <div className={styles['history-info']}>
                    <span className={styles['history-opp']}>vs {m.opponent}</span>
                    <span className={styles['history-meta']}>
                      {m.overs !== undefined && m.wickets !== undefined
                        ? `${m.overs} ov · ${m.wickets} wkt`
                        : null}
                    </span>
                  </div>
                  <div className={styles['history-right']}>
                    <span className={styles['history-score']}>
                      {m.myScore} – {m.oppScore}
                    </span>
                    <span className={styles['history-date']}>
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

      {showBots && <MeetBots onClose={() => setShowBots(false)} />}
      {showStandings && (
        <GlobalStandings myId={user?.id ?? null} onClose={() => setShowStandings(false)} />
      )}
    </div>
  );
}
