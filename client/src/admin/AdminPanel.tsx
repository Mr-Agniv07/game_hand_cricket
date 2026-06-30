import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../api';
import styles from './AdminPanel.module.css';
import type { AdminData } from '@cric/types';
import type { AppSocket } from '../socket';
import type { ClientUser } from '../types';

interface Props {
  socket: AppSocket;
  user: ClientUser | null;
  onClose: () => void;
}

const KIND_LABEL: Record<string, string> = {
  tournament: '🏆 Tournament',
  quick: '⚡ Quick',
  'vs-bot': '🤖 vs Bot',
  casual: '🎮 Casual',
  'super-league': '🏆 Super League',
  'bot-league': '🤖 Bot League',
  human: '👤 Human',
};

export default function AdminPanel({ socket, user, onClose }: Props) {
  const [data, setData] = useState<AdminData | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    apiGet<AdminData>('/api/admin', user?.token)
      .then((d) => {
        setData(d);
        setErr('');
      })
      .catch(() => setErr('Could not load admin data (are you the admin?).'));
  }, [user?.token]);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const flash = (m: string) => {
      setMsg(m);
      load();
      setTimeout(() => setMsg(''), 4000);
    };
    const onStarted = ({ format }: { format: number }) => flash(`${format}-over event started 🤖`);
    const onStopped = () => flash('League stopped ⏹');
    const onReset = () => flash('Rankings reset 🔄');
    const onErr = ({ message }: { message: string }) => flash(message);
    socket.on('bot_league_started', onStarted);
    socket.on('bot_league_stopped', onStopped);
    socket.on('bot_rankings_reset', onReset);
    socket.on('error', onErr);
    return () => {
      socket.off('bot_league_started', onStarted);
      socket.off('bot_league_stopped', onStopped);
      socket.off('bot_rankings_reset', onReset);
      socket.off('error', onErr);
    };
  }, [socket, load]);

  const startLeague = (format: number) => socket.emit('start_bot_league', { format });
  const startSuper = () => socket.emit('start_bot_super_league');
  const startQualifier = (format: number) => socket.emit('start_bot_qualifier', { format });
  const stopLeagues = () => {
    if (window.confirm('Stop ALL running bot leagues? They will be dropped with no result.'))
      socket.emit('stop_bot_league', {});
  };
  const resetRankings = () => {
    if (window.confirm('Reset ALL bot rankings, trophies and head-to-head to zero?'))
      socket.emit('reset_bot_rankings');
  };

  const s = data?.stats;
  const statRows: [string, number | undefined][] = [
    ['Registered users', s?.users],
    ['Played ≥1 game', s?.usersPlayed],
    ['Online now', s?.online],
    ['Total games played', s?.totalGamesPlayed],
    ['Total runs scored', s?.totalRunsScored],
    ['Match-history rows', s?.matchHistoryRows],
    ['Friendships', s?.friendships],
    ['Coins in circulation', s?.coinsInCirculation],
    ['Tournaments played', s?.tournamentsPlayed],
    ['Tournaments won', s?.tournamentsWon],
    ['Bot leagues completed', s?.botLeaguesCompleted],
    ['Bot H2H pairs', s?.botH2HPairs],
    ['Bot ranking rows', s?.botRankingRows],
    ['Live matches', s?.liveRooms],
    ['Active tournaments', s?.activeTournaments],
    ['In Quick-Match queue', s?.queueWaiting],
  ];

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>🛠 Admin Panel</h2>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          {err && <div className={styles.err}>{err}</div>}
          {msg && <div className={styles.msg}>{msg}</div>}

          {/* Bot-league controls */}
          <div className={styles.section}>Bot League Controls</div>
          <div className={styles.controls}>
            <button className={styles.start} onClick={() => startLeague(5)}>
              ▶ Start 5-Over
            </button>
            <button className={styles.start} onClick={() => startLeague(10)}>
              ▶ Start 10-Over
            </button>
            <button className={styles.super} onClick={startSuper}>
              🏆 Super League
            </button>
            <button className={styles.start} onClick={() => startQualifier(5)}>
              🎟 5-Over Qualifier
            </button>
            <button className={styles.start} onClick={() => startQualifier(10)}>
              🎟 10-Over Qualifier
            </button>
            <button className={styles.stop} onClick={stopLeagues}>
              ⏹ Stop
            </button>
            <button className={styles.reset} onClick={resetRankings}>
              🔄 Reset
            </button>
          </div>

          {/* Stats */}
          <div className={styles.section}>Database Stats</div>
          {data === null ? (
            <div className={styles.loading}>
              <div className="spinner" />
            </div>
          ) : (
            <div className={styles.statGrid}>
              {statRows.map(([label, val]) => (
                <div key={label} className={styles.stat}>
                  <span className={styles.statVal}>{val ?? '—'}</span>
                  <span className={styles.statLabel}>{label}</span>
                </div>
              ))}
            </div>
          )}

          {/* Active tournaments */}
          <div className={styles.section}>
            Active Tournaments {data ? `(${data.tournaments.length})` : ''}
          </div>
          {data && data.tournaments.length === 0 ? (
            <div className={styles.empty}>None running.</div>
          ) : (
            (data?.tournaments ?? []).map((t) => (
              <div key={t.code} className={styles.row}>
                <div className={styles.rowTop}>
                  <span className={styles.badge}>{KIND_LABEL[t.kind] ?? t.kind}</span>
                  <span className={styles.rowCode}>{t.code}</span>
                  <span className={styles.rowMeta}>
                    {t.format ? `${t.format}ov · ` : ''}
                    {t.size} teams · {t.phase}
                  </span>
                </div>
                <div className={styles.rowSub}>
                  {t.progress} — {t.players.join(', ')}
                </div>
              </div>
            ))
          )}

          {/* Live matches */}
          <div className={styles.section}>
            Live Matches {data ? `(${data.liveMatches.length})` : ''}
          </div>
          {data && data.liveMatches.length === 0 ? (
            <div className={styles.empty}>No matches in progress.</div>
          ) : (
            (data?.liveMatches ?? []).map((m) => (
              <div key={m.roomId} className={styles.row}>
                <div className={styles.rowTop}>
                  <span className={styles.badge}>{KIND_LABEL[m.kind] ?? m.kind}</span>
                  <span className={styles.rowTeams}>
                    {m.players.map((p) => p.name).join(' vs ') || '—'}
                  </span>
                </div>
                <div className={styles.rowSub}>
                  {m.overs}ov/{m.wickets}w · inns {m.innings} · {m.score} · {m.phase}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
