import { useEffect, useState, useCallback } from 'react';
import { apiGet } from '../api';
import styles from './BotLeague.module.css';
import TournamentLobby from '../tournament/TournamentLobby';
import TournamentResult from '../tournament/TournamentResult';
import type {
  BotLeagueData,
  BotLeagueActive,
  BotTournamentSummary,
  TournamentState,
} from '@cric/types';
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
  const [pastView, setPastView] = useState<BotTournamentSummary | null>(null);
  const [now, setNow] = useState(Date.now());

  // Tick once a second for the bidding countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(() => {
    apiGet<BotLeagueData>('/api/bot-league', user?.token)
      .then(setData)
      .catch(() => {});
  }, [user?.token]);

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
    function onBid({ botName }: { botName: string }) {
      setMsg(`Backed ${botName} — win 50 🪙 if they're champion!`);
      load();
      setTimeout(() => setMsg(''), 4000);
    }
    socket.on('bot_league_started', onStarted);
    socket.on('bot_rankings_reset', onReset);
    socket.on('bid_placed', onBid);
    return () => {
      socket.off('bot_league_started', onStarted);
      socket.off('bot_rankings_reset', onReset);
      socket.off('bid_placed', onBid);
    };
  }, [socket, load]);

  function handleBid(tournamentId: string, botName: string) {
    socket.emit('place_bid', { tournamentId, botName });
  }

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
  // Reigning champion per format = the most recent completed tournament's winner.
  const champ5 = data?.history.find((t) => t.format === 5)?.champion ?? null;
  const champ10 = data?.history.find((t) => t.format === 10)?.champion ?? null;

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
              <div className={styles.currentChamps}>
                <div className={styles.ccTitle}>👑 Current Champions</div>
                <div className={styles.ccRow}>
                  <span className={styles.ccFmt}>5 Over</span>
                  <span className={styles.ccName}>{champ5 ?? '—'}</span>
                </div>
                <div className={styles.ccRow}>
                  <span className={styles.ccFmt}>10 Over</span>
                  <span className={styles.ccName}>{champ10 ?? '—'}</span>
                </div>
              </div>

              {liveForFormat &&
                (liveForFormat.state.phase === 'waiting' ? (
                  <>
                    <div className={styles.bidWindow}>
                      ⏳ Bidding open — {format}-over league starts in{' '}
                      <strong>{fmtCountdown(liveForFormat.bidsCloseAt, now)}</strong>
                    </div>
                    <BidPanel
                      active={liveForFormat}
                      user={user}
                      biddingOpen
                      onBid={(b) => handleBid(liveForFormat.id, b)}
                    />
                  </>
                ) : (
                  <>
                    <LiveCard
                      active={liveForFormat}
                      onWatch={() => setWatchingId(liveForFormat.id)}
                    />
                    <BidPanel
                      active={liveForFormat}
                      user={user}
                      biddingOpen={false}
                      onBid={(b) => handleBid(liveForFormat.id, b)}
                    />
                  </>
                ))}

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
                pastForFormat.map((t, i) => (
                  <PastCard key={`${t.finishedAt}-${i}`} t={t} onView={() => setPastView(t)} />
                ))
              )}
            </>
          )}
        </div>
      </div>

      {/* Live spectating: the in-progress lobby view (groups, fixtures, live score). */}
      {watching && watching.state.phase !== 'complete' && (
        <div className={styles.specOverlay} onClick={() => setWatchingId(null)}>
          <div className={styles.specCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.specHeader}>
              <h2>
                <span className={styles.liveDot} /> Bot League · {watching.format} Over — Spectating
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

      {/* Finished league just watched: full result summary (groups + knockouts). */}
      {watching && watching.state.phase === 'complete' && (
        <ResultOverlay state={watching.state} onClose={() => setWatchingId(null)} />
      )}

      {/* The watched league ended and is no longer in the feed. */}
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

      {/* Full detail of a past tournament: group standings + knockouts. */}
      {pastView?.state && (
        <ResultOverlay state={pastView.state} title={pastView.name} onClose={() => setPastView(null)} />
      )}
    </div>
  );
}

/**
 * A completed tournament's result summary in an overlay — reuses the player-facing
 * TournamentResult (group standings + knockouts), with awards stripped (bot
 * leagues don't surface achievements) and no "you" highlighting.
 */
function ResultOverlay({
  state,
  title,
  onClose,
}: {
  state: TournamentState;
  title?: string;
  onClose: () => void;
}) {
  return (
    <div className={styles.specOverlay} onClick={onClose}>
      <button className={styles.resultClose} onClick={onClose} aria-label="Close">
        ✕
      </button>
      <div className={styles.resultWrap} onClick={(e) => e.stopPropagation()}>
        {title && <div className={styles.resultTitle}>🏆 {title}</div>}
        <TournamentResult tournamentState={{ ...state, awards: null }} myId={null} onLeave={onClose} />
      </div>
    </div>
  );
}

function PastCard({ t, onView }: { t: BotTournamentSummary; onView: () => void }) {
  const [open, setOpen] = useState(false);
  const hasFull = !!t.state;
  const date = new Date(t.finishedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return (
    <div className={styles.pastCard}>
      <button className={styles.pastHead} onClick={hasFull ? onView : () => setOpen((o) => !o)}>
        <span className={styles.pastTrophy}>🏆</span>
        <span className={styles.pastInfo}>
          <span className={styles.pastTitle}>{t.name}</span>
          <span className={styles.pastMeta}>
            <span className={styles.pastChamp}>{t.champion}</span>
            {t.runnerUp ? ` def. ${t.runnerUp}` : ''} · {date}
          </span>
        </span>
        <span className={styles.pastToggle}>{hasFull ? '⤢' : open ? '▲' : '▼'}</span>
      </button>
      {!hasFull && open && (
        <div className={styles.pastBody}>
          <p className={styles.pastNote}>
            Group &amp; knockout detail wasn&apos;t recorded for this tournament — only the champion
            is known. New tournaments show the full summary.
          </p>
        </div>
      )}
    </div>
  );
}

/** mm:ss until `closeAt`, or 0:00. */
function fmtCountdown(closeAt: number | null | undefined, now: number): string {
  const s = closeAt ? Math.max(0, Math.floor((closeAt - now) / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function BidPanel({
  active,
  user,
  biddingOpen,
  onBid,
}: {
  active: BotLeagueActive;
  user: ClientUser | null;
  biddingOpen: boolean;
  onBid: (botName: string) => void;
}) {
  if (active.myBid) {
    return (
      <div className={styles.bidNote}>
        🎟️ You backed <strong>{active.myBid}</strong> — 50 🪙 if they win the league!
      </div>
    );
  }
  if (!biddingOpen) {
    return <div className={styles.bidNote}>🎟️ Bidding closed — the league is underway.</div>;
  }
  if (!user) {
    return (
      <div className={styles.bidNote}>🎟️ Log in to back a bot — win 50 🪙 if they take the title.</div>
    );
  }
  return (
    <div className={styles.bidBox}>
      <div className={styles.bidTitle}>🎟️ Back the champion — free · win 50 🪙</div>
      <div className={styles.bidGrid}>
        {active.state.players.map((p) => (
          <button key={p.id} className={styles.bidBtn} onClick={() => onBid(p.name)}>
            {p.name}
          </button>
        ))}
      </div>
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
