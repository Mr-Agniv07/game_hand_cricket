import { useEffect, useState, useCallback } from 'react';
import { apiGet } from '../api';
import styles from './BotLeague.module.css';
import type { BotLeagueData, BotLeagueActive } from '@cric/types';
import type { AppSocket } from '../socket';
import type { ClientUser } from '../types';

type Format = 5 | 10;

interface Props {
  socket: AppSocket;
  user: ClientUser | null;
  onClose: () => void;
}

export default function BotLeague({ socket, user, onClose }: Props) {
  const [format, setFormat] = useState<Format>(5);
  const [data, setData] = useState<BotLeagueData | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [starting, setStarting] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    apiGet<BotLeagueData>('/api/bot-league')
      .then(setData)
      .catch(() => {});
  }, []);

  // Initial load + poll every 3s so live tournaments stay current.
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  // Am I the admin? (server compares my username to ADMIN_USERNAME)
  useEffect(() => {
    if (!user?.token) return;
    apiGet<{ isAdmin?: boolean }>('/api/me', user.token)
      .then((me) => setIsAdmin(!!me.isAdmin))
      .catch(() => {});
  }, [user?.token]);

  // React to a successful start.
  useEffect(() => {
    function onStarted({ format: f }: { format: number }) {
      setStarting(false);
      setMsg(`${f}-over bot league started! 🤖`);
      load();
      setTimeout(() => setMsg(''), 4000);
    }
    socket.on('bot_league_started', onStarted);
    return () => {
      socket.off('bot_league_started', onStarted);
    };
  }, [socket, load]);

  const rankings = data?.rankings[format] ?? [];
  const liveForFormat: BotLeagueActive | undefined = data?.active.find((a) => a.format === format);

  function handleStart() {
    if (starting || liveForFormat) return;
    setStarting(true);
    setMsg('');
    socket.emit('start_bot_league', { format });
    // Safety: clear the spinner even if the server stays silent (e.g. rejected).
    setTimeout(() => setStarting(false), 4000);
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>🤖 Bot League</h2>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.tabs}>
          {([5, 10] as const).map((f) => (
            <button
              key={f}
              className={format === f ? `${styles.tab} ${styles.active}` : styles.tab}
              onClick={() => setFormat(f)}
            >
              {f} Over
            </button>
          ))}
        </div>

        <div className={styles.body}>
          {isAdmin && (
            <div className={styles.adminBar}>
              <button
                className={styles.startBtn}
                onClick={handleStart}
                disabled={starting || !!liveForFormat}
              >
                {liveForFormat
                  ? `${format}-Over league in progress…`
                  : starting
                    ? 'Starting…'
                    : `▶ Start ${format}-Over League`}
              </button>
            </div>
          )}
          {msg && <div className={styles.msg}>{msg}</div>}

          {data === null ? (
            <div className={styles.loading}>
              <div className="spinner" />
            </div>
          ) : (
            <>
              {liveForFormat && <LiveCard active={liveForFormat} />}

              <div className={styles.sectionTitle}>{format}-Over Rankings</div>
              <div className={styles.tableHead}>
                <span className={styles.rank}>#</span>
                <span>Bot</span>
                <span className={styles.num}>Win%</span>
                <span className={styles.num}>🏆</span>
                <span className={styles.rating}>Rating</span>
              </div>
              {rankings.map((r) => (
                <div
                  key={r.botName}
                  className={r.rank <= 8 ? `${styles.row} ${styles.qualified}` : styles.row}
                >
                  <span className={styles.rank}>{r.rank}</span>
                  <span className={styles.nameCell}>
                    <span className={styles.name}>{r.botName}</span>
                    <span className={styles.sub}>
                      {r.played}P · {r.wins}-{r.losses}-{r.ties}
                    </span>
                  </span>
                  <span className={styles.num}>{r.winPct}%</span>
                  <span className={styles.num}>{r.trophies}</span>
                  <span className={styles.rating}>{r.rating}</span>
                </div>
              ))}
              <p className={styles.qualNote}>
                ⬅ Top 8 by rating qualify for the next league.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LiveCard({ active }: { active: BotLeagueActive }) {
  const s = active.state;
  const done = s.fixtures.filter((f) => f.status === 'done').length;
  const total = s.fixtures.length;
  const ls = s.liveScore;
  return (
    <div className={styles.live}>
      <div className={styles.liveHead}>
        <span className={styles.liveDot} /> Live · {active.format} Over
      </div>
      {ls ? (
        <>
          <div className={styles.liveScore}>
            🏏 {ls.batsmanName} {ls.score}/{ls.wicketsLost}
            <span className={styles.liveMeta}> ({ls.overs} ov)</span>
          </div>
          <div className={styles.liveMeta}>
            vs {ls.bowlerName}
            {ls.target !== null ? ` · chasing ${ls.target}` : ''} · match {done + 1} of {total}
          </div>
        </>
      ) : (
        <div className={styles.liveMeta}>
          {done} of {total} matches played…
        </div>
      )}
    </div>
  );
}
