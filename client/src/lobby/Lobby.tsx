import { useState, useEffect, useRef } from 'react';
import type { FormEvent } from 'react';
import { apiGet } from '../api';
import styles from './Lobby.module.css';
import MeetBots from './MeetBots';
import GlobalStandings from './GlobalStandings';
import HallOfFame from './HallOfFame';
import BotLeague from './BotLeague';
import type { BotLeagueData } from '@cric/types';
import type { AppSocket } from '../socket';
import type { ClientUser } from '../types';

const OVER_OPTIONS = [1, 2, 3, 5, 10];
const WICKET_OPTIONS = [1, 2, 3, 5, 10];

type LobbyTab = 'quick' | 'create' | 'join' | 'tournament';

interface LobbyProps {
  socket: AppSocket;
  onJoinRoom: (code: string, playerName: string) => void;
  defaultName?: string;
  user?: ClientUser | null;
  onOpenStore: () => void;
}

export default function Lobby({
  socket,
  onJoinRoom,
  defaultName = '',
  user = null,
  onOpenStore,
}: LobbyProps) {
  const [tab, setTab] = useState<LobbyTab>('create');
  const [name, setName] = useState(defaultName);
  const [overs, setOvers] = useState(2);
  const [wickets, setWickets] = useState(2);
  const [joinCode, setJoinCode] = useState('');
  const [joinName, setJoinName] = useState(defaultName);
  const [tOvers, setTOvers] = useState(2);
  const [tWickets, setTWickets] = useState(2);
  const [tSize, setTSize] = useState<4 | 8>(4);
  const [tSubTab, setTSubTab] = useState<'create' | 'join'>('create');
  const [tJoinCode, setTJoinCode] = useState('');
  const [showBots, setShowBots] = useState(false);
  const [showStandings, setShowStandings] = useState(false);
  const [showHallOfFame, setShowHallOfFame] = useState(false);
  const [showBotLeague, setShowBotLeague] = useState(false);
  const [leagueLive, setLeagueLive] = useState(false);
  const [qOvers, setQOvers] = useState(2);
  const [qWickets, setQWickets] = useState(2);
  const [searching, setSearching] = useState(false);
  const searchingRef = useRef(false);

  const loggedIn = !!user;
  const unlocks = user?.unlocks ?? [];
  const overLocked = (o: number) =>
    (o === 3 && !unlocks.includes('over3')) ||
    (o === 5 && !unlocks.includes('over5')) ||
    (o === 10 && !unlocks.includes('over10'));

  /** Render the overs selector with locks on premium formats (5/10). */
  function renderOvers(selected: number, set: (n: number) => void) {
    return OVER_OPTIONS.map((o) => {
      const locked = overLocked(o);
      return (
        <button
          key={o}
          type="button"
          className={`over-btn${selected === o ? ' selected' : ''}${locked ? ' over-locked' : ''}`}
          onClick={() => (locked ? onOpenStore() : set(o))}
          title={locked ? 'Unlock this format in the Store' : ''}
        >
          {o}
          {locked ? ' 🔒' : ''}
        </button>
      );
    });
  }

  // ── Quick Match ──────────────────────────────────────────────────────────
  function setSearchingState(on: boolean) {
    searchingRef.current = on;
    setSearching(on);
  }
  function handleFindMatch() {
    const playerName = user ? user.username : name.trim();
    if (!playerName) return;
    socket.emit('find_match', { playerName, overs: qOvers, wickets: qWickets });
    setSearchingState(true);
  }
  function cancelMatch() {
    socket.emit('cancel_match');
    setSearchingState(false);
  }
  /** Switching tabs (or unmounting) leaves the queue, so we never search invisibly. */
  function switchTab(next: LobbyTab) {
    if (searchingRef.current) cancelMatch();
    setTab(next);
  }
  // Leave the queue if the lobby unmounts while still searching (e.g. logout).
  useEffect(() => {
    return () => {
      if (searchingRef.current) socket.emit('cancel_match');
    };
  }, [socket]);

  // Poll for an in-progress bot league so the homepage button can glow "live".
  useEffect(() => {
    let cancelled = false;
    const check = () =>
      apiGet<BotLeagueData>('/api/bot-league')
        .then((d) => !cancelled && setLeagueLive(d.active.length > 0))
        .catch(() => {});
    check();
    const t = setInterval(check, 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

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

  return (
    <div className={styles['lobby']}>
      <div className="tabs">
        <button
          className={tab === 'quick' ? 'tab active' : 'tab'}
          onClick={() => switchTab('quick')}
        >
          ⚡ Quick
        </button>
        <button
          className={tab === 'create' ? 'tab active' : 'tab'}
          onClick={() => switchTab('create')}
        >
          Create
        </button>
        <button className={tab === 'join' ? 'tab active' : 'tab'} onClick={() => switchTab('join')}>
          Join
        </button>
        <button
          className={tab === 'tournament' ? 'tab active' : 'tab'}
          onClick={() => switchTab('tournament')}
        >
          Tournament
        </button>
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
          onClick={() => setShowHallOfFame(true)}
        >
          🏛️ Hall of Fame
        </button>
        <button
          type="button"
          className={styles['meet-bots-link']}
          onClick={() => setShowBots(true)}
        >
          🤖 Meet our Bots
        </button>
        <button
          type="button"
          className={`${styles['meet-bots-link']}${leagueLive ? ` ${styles['link-live']}` : ''}`}
          onClick={() => setShowBotLeague(true)}
        >
          🏆 Bot League{leagueLive ? ' · LIVE' : ''}
        </button>
      </div>

      {tab === 'quick' && (
        <div className="card form">
          {searching ? (
            <div className={styles['quick-searching']}>
              <div className="spinner" />
              <div className={styles['quick-search-title']}>Searching for an opponent…</div>
              <div className={styles['quick-search-mode']}>
                {qOvers} over{qOvers !== 1 ? 's' : ''} · {qWickets} wicket{qWickets !== 1 ? 's' : ''}
              </div>
              <p style={{ fontSize: '.8rem', color: 'var(--muted)', textAlign: 'center' }}>
                You'll be paired the moment someone else picks this mode.
              </p>
              <button type="button" className={styles['bot-btn']} onClick={cancelMatch}>
                Cancel
              </button>
            </div>
          ) : (
            <>
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
              <h3 className={styles['mode-title']}>Find a random opponent</h3>
              <label>Number of Overs</label>
              <div className="over-options">{renderOvers(qOvers, setQOvers)}</div>
              <label>Number of Wickets</label>
              <div className="over-options">
                {WICKET_OPTIONS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={qWickets === w ? 'over-btn selected' : 'over-btn'}
                    onClick={() => setQWickets(w)}
                  >
                    {w}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: '.8rem', color: 'var(--muted)', margin: '.2rem 0' }}>
                You'll be matched with anyone else searching for {qOvers} over
                {qOvers !== 1 ? 's' : ''} · {qWickets} wicket{qWickets !== 1 ? 's' : ''}.
              </p>
              <button
                type="button"
                className="btn-primary"
                onClick={handleFindMatch}
                disabled={!loggedIn && !name.trim()}
              >
                ⚡ Find Match
              </button>
            </>
          )}
        </div>
      )}

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
          <div className="over-options">{renderOvers(overs, setOvers)}</div>

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
                {([4, 8] as const).map((n) => {
                  const locked = n === 8 && !unlocks.includes('tourney8');
                  return (
                    <button
                      key={n}
                      type="button"
                      className={`over-btn${tSize === n ? ' selected' : ''}${locked ? ' over-locked' : ''}`}
                      onClick={() => (locked ? onOpenStore() : setTSize(n))}
                      title={locked ? 'Unlock 8-player tournaments in the Store' : ''}
                    >
                      {n}
                      {locked ? ' 🔒' : ''}
                    </button>
                  );
                })}
              </div>
              <label>Overs per Match</label>
              <div className="over-options">{renderOvers(tOvers, setTOvers)}</div>
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

      {showBots && <MeetBots onClose={() => setShowBots(false)} />}
      {showStandings && (
        <GlobalStandings myId={user?.id ?? null} onClose={() => setShowStandings(false)} />
      )}
      {showHallOfFame && <HallOfFame user={user} onClose={() => setShowHallOfFame(false)} />}
      {showBotLeague && (
        <BotLeague socket={socket} user={user} onClose={() => setShowBotLeague(false)} />
      )}
    </div>
  );
}
