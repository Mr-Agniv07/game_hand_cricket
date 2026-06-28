import { useEffect, useState, useCallback } from 'react';
import { apiGet } from '../api';
import styles from './BotLeague.module.css';
import TournamentLobby from '../tournament/TournamentLobby';
import TournamentResult from '../tournament/TournamentResult';
import LiveBids from './LiveBids';
import type {
  BotLeagueData,
  BotLeagueActive,
  BotTournamentSummary,
  TournamentState,
} from '@cric/types';
import type { AppSocket } from '../socket';
import type { ClientUser } from '../types';

const noop = () => {};

/** Display label for a bot event: the 12-team Super League vs a normal N-over league. */
function eventLabel(state: TournamentState, format: number): string {
  return state.size === 12 ? 'Super League' : `${format} Over`;
}

/** The champion bot's name for a finished league, or null if not decided yet. */
function championName(a: BotLeagueActive): string | null {
  const id = a.state.champion;
  if (!id) return null;
  return a.state.players.find((p) => p.id === id)?.name ?? null;
}

type Tab = '5' | '10' | 'super';

/** A live/just-finished league is the Super League iff it fielded 12 teams. */
const isSuperActive = (a: BotLeagueActive) => a.state.size === 12;
/** A history record is a Super League iff its final state had 12 teams (or by name, for safety). */
const isSuperSummary = (t: BotTournamentSummary) =>
  t.state?.size === 12 || t.name.startsWith('Bot Super League');

interface Props {
  socket: AppSocket;
  user: ClientUser | null;
  onClose: () => void;
}

export default function BotLeague({ socket, user, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('5');
  const [data, setData] = useState<BotLeagueData | null>(null);
  const [msg, setMsg] = useState('');
  const [watchingId, setWatchingId] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<TournamentState | null>(null);
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

  // Refresh the view when the admin starts/stops/resets from the Admin Panel.
  useEffect(() => {
    function onStarted({ format: f }: { format: number }) {
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
    function onStopped() {
      setMsg('League stopped. ⏹');
      load();
      setTimeout(() => setMsg(''), 4000);
    }
    socket.on('bot_league_started', onStarted);
    socket.on('bot_rankings_reset', onReset);
    socket.on('bid_placed', onBid);
    socket.on('bot_league_stopped', onStopped);
    return () => {
      socket.off('bot_league_started', onStarted);
      socket.off('bot_rankings_reset', onReset);
      socket.off('bid_placed', onBid);
      socket.off('bot_league_stopped', onStopped);
    };
  }, [socket, load]);

  function handleBid(tournamentId: string, botName: string) {
    socket.emit('place_bid', { tournamentId, botName });
  }

  // While watching a live tournament, drive the view from the socket in REAL TIME
  // (join its room, update on every ball) instead of the 3s HTTP poll — which
  // mobile browsers throttle/suspend in the background, freezing the standings.
  useEffect(() => {
    if (!watchingId) return;
    setLiveState(null);
    socket.emit('watch_tournament', { id: watchingId });
    function onState(s: TournamentState) {
      if (s.id === watchingId) setLiveState(s);
    }
    socket.on('tournament_state', onState);
    return () => {
      socket.off('tournament_state', onState);
      socket.emit('unwatch_tournament', { id: watchingId });
    };
  }, [socket, watchingId]);

  const isSuper = tab === 'super';
  // Both the 10-over and Super League tabs read the 10-over rating pool.
  const format: 5 | 10 = tab === '5' ? 5 : 10;

  // Tab → which active/recent/history rows belong here. The Super League is a
  // 10-over event, so it's filtered OUT of the 10-over tab and INTO its own.
  const activeForTab = (a: BotLeagueActive) =>
    isSuper ? isSuperActive(a) : a.format === format && !isSuperActive(a);
  const summaryForTab = (t: BotTournamentSummary) =>
    isSuper ? isSuperSummary(t) : t.format === format && !isSuperSummary(t);

  const rankings = data?.rankings[format] ?? [];
  const liveForFormat: BotLeagueActive | undefined = data?.active.find(activeForTab);
  // Most recently finished league for this tab (shows the winner once it ends).
  const recentForFormat: BotLeagueActive | undefined = data?.recent
    .filter(activeForTab)
    .slice(-1)[0];
  // The league being watched — live OR just-finished — refreshed from each poll.
  const watching = watchingId
    ? [...(data?.active ?? []), ...(data?.recent ?? [])].find((a) => a.id === watchingId)
    : undefined;
  // Prefer the real-time socket state; fall back to the last polled snapshot.
  const watchState: TournamentState | undefined = watchingId
    ? liveState && liveState.id === watchingId
      ? liveState
      : watching?.state
    : undefined;
  const pastForFormat = (data?.history ?? []).filter(summaryForTab);
  // Reigning champion per bucket = the most recent completed tournament's winner.
  const champ5 = data?.history.find((t) => t.format === 5 && !isSuperSummary(t))?.champion ?? null;
  const champ10 = data?.history.find((t) => t.format === 10 && !isSuperSummary(t))?.champion ?? null;
  const champSuper = data?.history.find(isSuperSummary)?.champion ?? null;

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
          {(['5', '10', 'super'] as const).map((tk) => (
            <button
              key={tk}
              className={tab === tk ? `${styles.tab} ${styles.active}` : styles.tab}
              onClick={() => setTab(tk)}
            >
              {tk === 'super' ? '🏆 Super' : `${tk} Over`}
            </button>
          ))}
        </div>

        <div className={styles.body}>
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
                <div className={styles.ccRow}>
                  <span className={styles.ccFmt}>🏆 Super League</span>
                  <span className={styles.ccName}>{champSuper ?? '—'}</span>
                </div>
              </div>

              {liveForFormat &&
                (liveForFormat.state.phase === 'waiting' ? (
                  <>
                    <div className={styles.bidWindow}>
                      ⏳ Bidding open — {eventLabel(liveForFormat.state, format)} starts in{' '}
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
                    🏆 <strong>{championName(recentForFormat)}</strong> won the latest{' '}
                    {recentForFormat.state.size === 12 ? 'Super League' : `${format}-over league`}
                  </span>
                  <button
                    className={styles.viewBtn}
                    onClick={() => setWatchingId(recentForFormat.id)}
                  >
                    View result
                  </button>
                </div>
              )}

              <div className={styles.sectionTitle}>
                {isSuper ? 'Bot Rankings (10-Over rating)' : `${format}-Over Rankings`}
              </div>
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
                  className={
                    !isSuper && r.rank <= 8 ? `${styles.row} ${styles.qualified}` : styles.row
                  }
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
                {isSuper
                  ? '⬅ All 12 bots play the Super League — seeded by 10-over rating.'
                  : '⬅ Top 8 by rating qualify for the next league.'}
              </p>

              <div className={styles.sectionTitle}>
                {isSuper ? 'Past Super Leagues' : `Past ${format}-Over Tournaments`}
              </div>
              {pastForFormat.length === 0 ? (
                <p className={styles.empty}>
                  {isSuper
                    ? 'No Super Leagues recorded yet — finish one and the winner shows up here.'
                    : `No ${format}-over tournaments recorded yet — finish a league and the winner shows up here.`}
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
      {watchState && watchState.phase !== 'complete' && (
        <div className={styles.specOverlay} onClick={() => setWatchingId(null)}>
          <div className={styles.specCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.specHeader}>
              <h2>
                <span className={styles.liveDot} /> Bot League · {eventLabel(watchState, watchState.overs)} — Spectating
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
                tournamentState={watchState}
                myId={null}
                onLeave={noop}
                onStartWithBots={noop}
              />
            </div>
          </div>
          {/* Live in-play prediction bids float over the spectate view. */}
          {watchingId && <LiveBids socket={socket} tournamentId={watchingId} user={user} />}
        </div>
      )}

      {/* Finished league just watched: full result summary (groups + knockouts). */}
      {watchState && watchState.phase === 'complete' && (
        <ResultOverlay state={watchState} onClose={() => setWatchingId(null)} />
      )}

      {/* The watched league ended and is no longer in the feed. */}
      {watchingId && !watchState && (
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
        <span className={styles.liveDot} /> Live · {eventLabel(s, active.format)}
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
