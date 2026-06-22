import { useEffect, useState, useCallback } from 'react';
import { apiGet } from '../api';
import styles from './BotLeague.module.css';
import TournamentLobby from '../tournament/TournamentLobby';
import type { BotLeagueData, BotLeagueActive, BotTournamentSummary } from '@cric/types';
import type { AppSocket } from '../socket';
import type { ClientUser } from '../types';

const noop = () => {};

/** The champion bot's name for a finished league, or null if not decided yet. */
function championName(a: BotLeagueActive): string | null {
  const id = a.state.champion;
  if (!id) return null;
  return a.state.players.find((p) => p.id === id)?.name ?? null;
}

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
  const [watchingId, setWatchingId] = useState<string | null>(null);

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
    function onReset() {
      setMsg('Rankings reset to base. 🔄');
      load();
      setTimeout(() => setMsg(''), 4000);
    }
    socket.on('bot_league_started', onStarted);
    socket.on('bot_rankings_reset', onReset);
    return () => {
      socket.off('bot_league_started', onStarted);
      socket.off('bot_rankings_reset', onReset);
    };
  }, [socket, load]);

  const rankings = data?.rankings[format] ?? [];
  const liveForFormat: BotLeagueActive | undefined = data?.active.find((a) => a.format === format);
  // Most recently finished league for this format (shows the winner once a league ends).
  const recentForFormat: BotLeagueActive | undefined = data?.recent
    .filter((a) => a.format === format)
    .slice(-1)[0];
  // The league being watched — live OR just-finished — refreshed from each poll.
  const watching = watchingId
    ? [...(data?.active ?? []), ...(data?.recent ?? [])].find((a) => a.id === watchingId)
    : undefined;
  const pastForFormat = (data?.history ?? []).filter((t) => t.format === format);

  function handleStart() {
    if (starting || liveForFormat) return;
    setStarting(true);
    setMsg('');
    socket.emit('start_bot_league', { format });
    // Safety: clear the spinner even if the server stays silent (e.g. rejected).
    setTimeout(() => setStarting(false), 4000);
  }

  function handleReset() {
    if (data && data.active.length > 0) {
      setMsg('Finish the live league before resetting.');
      return;
    }
    if (!window.confirm('Reset ALL bot rankings (ratings, records and trophies) to zero?')) return;
    socket.emit('reset_bot_rankings');
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
              <button
                className={styles.resetBtn}
                onClick={handleReset}
                disabled={!!data && data.active.length > 0}
                title="Reset all bot rankings to zero"
              >
                🔄 Reset
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
              {liveForFormat && (
                <LiveCard active={liveForFormat} onWatch={() => setWatchingId(liveForFormat.id)} />
              )}

              {!liveForFormat && recentForFormat && championName(recentForFormat) && (
                <div className={styles.champ}>
                  <span>
                    🏆 <strong>{championName(recentForFormat)}</strong> won the latest {format}-over
                    league
                  </span>
                  <button
                    className={styles.viewBtn}
                    onClick={() => setWatchingId(recentForFormat.id)}
                  >
                    View result
                  </button>
                </div>
              )}

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

              <div className={styles.sectionTitle}>Past {format}-Over Tournaments</div>
              {pastForFormat.length === 0 ? (
                <p className={styles.empty}>
                  No {format}-over tournaments recorded yet — finish a league and the winner shows up
                  here.
                </p>
              ) : (
                pastForFormat.map((t, i) => <PastCard key={`${t.finishedAt}-${i}`} t={t} />)
              )}
            </>
          )}
        </div>
      </div>

      {watching && (
        <div className={styles.specOverlay} onClick={() => setWatchingId(null)}>
          <div className={styles.specCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.specHeader}>
              <h2>
                {watching.state.phase === 'complete' ? (
                  <>🏆 Bot League · {watching.format} Over — Final Result</>
                ) : (
                  <>
                    <span className={styles.liveDot} /> Bot League · {watching.format} Over —
                    Spectating
                  </>
                )}
              </h2>
              <button
                className={styles.close}
                onClick={() => setWatchingId(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className={styles.specBody}>
              {championName(watching) && (
                <div className={styles.champBanner}>
                  🏆 Champion: <strong>{championName(watching)}</strong>
                </div>
              )}
              <TournamentLobby
                tournamentState={watching.state}
                myId={null}
                onLeave={noop}
                onStartWithBots={noop}
              />
            </div>
          </div>
        </div>
      )}

      {/* The watched league ended while spectating. */}
      {watchingId && !watching && (
        <div className={styles.specOverlay} onClick={() => setWatchingId(null)}>
          <div className={styles.specCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.specHeader}>
              <h2>🏆 League finished</h2>
              <button
                className={styles.close}
                onClick={() => setWatchingId(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className={styles.specBody}>
              <p className={styles.empty}>
                This league has wrapped up — the rankings have been updated. Close to see the new
                standings.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PastCard({ t }: { t: BotTournamentSummary }) {
  const [open, setOpen] = useState(false);
  const date = new Date(t.finishedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return (
    <div className={styles.pastCard}>
      <button className={styles.pastHead} onClick={() => setOpen((o) => !o)}>
        <span className={styles.pastTrophy}>🏆</span>
        <span className={styles.pastChamp}>{t.champion}</span>
        <span className={styles.pastMeta}>
          {t.runnerUp ? `def. ${t.runnerUp}` : ''} · {date}
        </span>
        <span className={styles.pastToggle}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className={styles.pastBody}>
          {t.standings.length === 0 ? (
            <p className={styles.pastNote}>
              Played before history tracking — only the champion was recorded.
            </p>
          ) : (
            t.standings.map((s, i) => (
              <div key={s.name} className={styles.pastRow}>
                <span className={styles.pastRank}>{i + 1}</span>
                <span className={styles.pastName}>{s.name}</span>
                <span className={styles.pastWl}>
                  {s.won}W · {s.lost}L
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function LiveCard({ active, onWatch }: { active: BotLeagueActive; onWatch: () => void }) {
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
      <button className={styles.watchBtn} onClick={onWatch}>
        ▶ Watch Live
      </button>
    </div>
  );
}
