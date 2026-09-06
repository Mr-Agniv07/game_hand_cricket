import { useEffect, useState, useCallback, useRef } from 'react';
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
  LiveMatchScore,
} from '@cric/types';
import type { AppSocket } from '../socket';
import type { ClientUser } from '../types';

const noop = () => {};

/** Display label for a bot event: the 16-team Super League vs a normal N-over league. */
function eventLabel(state: TournamentState, format: number): string {
  if (state.isQualifier) return 'Qualifying Playoffs';
  return state.size === 16 ? 'Super League' : `${format} Over`;
}

/** The champion bot's name for a finished league, or null if not decided yet. */
function championName(a: BotLeagueActive): string | null {
  const id = a.state.champion;
  if (!id) return null;
  return a.state.players.find((p) => p.id === id)?.name ?? null;
}

type Tab = '5' | '10' | 'super';

/** A live/just-finished league is the Super League iff it fielded 16 teams. */
const isSuperActive = (a: BotLeagueActive) => a.state.size === 16;
/** A history record is a Super League iff its final state had 16 teams (or by name, which
 *  also covers older 12-team Super Leagues recorded before the 16-bot expansion). */
const isSuperSummary = (t: BotTournamentSummary) =>
  t.state?.size === 16 || t.name.startsWith('Bot Super League');

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
  const [pastView, setPastView] = useState<BotTournamentSummary | null>(null);
  // Rankings view: 'season' (current-season stats) vs 'career' (all-time totals).
  const [rankView, setRankView] = useState<'season' | 'career'>('season');
  // A past season being browsed (its standings + that season's tournaments), or null.
  const [seasonView, setSeasonView] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  // 3 headlines shown at a time, picked at random from the news pool and rotated
  // every few seconds so the feed feels alive and looks different each time.
  const [newsShown, setNewsShown] = useState<string[]>([]);
  // The Draw ceremony overlay (group reveal after bidding closes), or null.
  const [draw, setDraw] = useState<{ format: number; isSuperLeague: boolean; groups: string[][] } | null>(null);
  // Ball-by-ball live score for the watched league, pushed between polls so the
  // spectate scoreboard advances continuously instead of jumping every 3s.
  const [liveOverride, setLiveOverride] = useState<{
    id: string;
    currentMatchIndex: number;
    liveScore: LiveMatchScore | null;
  } | null>(null);

  // Tick once a second for the bidding countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Pick 3 random headlines ONCE per open — the first time the news pool loads after
  // this window is mounted. They stay fixed while it's open; closing and reopening the
  // Bot League window remounts this component, which re-picks a fresh random 3.
  const newsKey = (data?.news ?? []).join('|');
  const newsPickedRef = useRef(false);
  useEffect(() => {
    if (newsPickedRef.current) return; // already chose this session's headlines
    const pool = newsKey ? newsKey.split('|') : [];
    if (pool.length === 0) return; // wait for the first non-empty load
    const bag = [...pool];
    const out: string[] = [];
    const n = Math.min(3, bag.length);
    while (out.length < n) out.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
    setNewsShown(out);
    newsPickedRef.current = true;
  }, [newsKey]);

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
    function onBid({ botName, prize }: { botName: string; prize: number }) {
      setMsg(`Backed ${botName} — win ${prize} 🪙 if they're champion!`);
      load();
      setTimeout(() => setMsg(''), 4000);
    }
    function onStopped() {
      setMsg('League stopped. ⏹');
      load();
      setTimeout(() => setMsg(''), 4000);
    }
    function onSeasonEnded({ number, champion }: { number: number; champion: string | null }) {
      setMsg(`🏆 Season ${number} champion: ${champion ?? '—'}! Season ${number + 1} begins.`);
      load();
      setTimeout(() => setMsg(''), 8000);
    }
    function onDrawReveal(p: {
      format: number;
      isSuperLeague: boolean;
      groups: string[][];
      revealMs: number;
    }) {
      setDraw({ format: p.format, isSuperLeague: p.isSuperLeague, groups: p.groups });
      load();
      setTimeout(() => setDraw(null), p.revealMs);
    }
    socket.on('bot_league_started', onStarted);
    socket.on('bot_rankings_reset', onReset);
    socket.on('bid_placed', onBid);
    socket.on('bot_league_stopped', onStopped);
    socket.on('bot_season_ended', onSeasonEnded);
    socket.on('bot_draw_reveal', onDrawReveal);
    return () => {
      socket.off('bot_league_started', onStarted);
      socket.off('bot_rankings_reset', onReset);
      socket.off('bid_placed', onBid);
      socket.off('bot_league_stopped', onStopped);
      socket.off('bot_season_ended', onSeasonEnded);
      socket.off('bot_draw_reveal', onDrawReveal);
    };
  }, [socket, load]);

  function handleBid(tournamentId: string, botName: string) {
    socket.emit('place_bid', { tournamentId, botName });
  }

  // While watching, join the tournament's SPECTATOR-ONLY room so live-bid offers
  // AND the per-ball live score arrive. This room gets no participant
  // `tournament_state` events, so it can't interfere with the poll-driven spectate
  // view. Standings/fixtures still come from the poll; only the scoreboard is live.
  useEffect(() => {
    if (!watchingId) return;
    socket.emit('watch_tournament', { id: watchingId });
    function onLiveScore(p: { id: string; currentMatchIndex: number; liveScore: LiveMatchScore | null }) {
      if (p.id === watchingId) setLiveOverride(p);
    }
    socket.on('spectator_live_score', onLiveScore);
    return () => {
      socket.emit('unwatch_tournament', { id: watchingId });
      socket.off('spectator_live_score', onLiveScore);
      setLiveOverride(null);
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
  // In 'career' view, re-sort the (season-sorted) rows by all-time totals.
  const displayRankings =
    rankView === 'career'
      ? [...rankings].sort(
          (a, b) =>
            b.careerTrophies - a.careerTrophies ||
            b.careerWinPct - a.careerWinPct ||
            b.careerWins - a.careerWins
        )
      : rankings;
  const liveForFormat: BotLeagueActive | undefined = data?.active.find(activeForTab);
  // Most recently finished league for this tab (shows the winner once it ends).
  const recentForFormat: BotLeagueActive | undefined = data?.recent
    .filter(activeForTab)
    .slice(-1)[0];
  // The league being watched — live OR just-finished — refreshed from each poll.
  const watching = watchingId
    ? [...(data?.active ?? []), ...(data?.recent ?? [])].find((a) => a.id === watchingId)
    : undefined;
  // Driven by the poll: when the league is gone from active/recent the view
  // clears (shows the "finished" fallback) instead of freezing on a stale snapshot.
  // The ball-by-ball override (socket) supersedes the poll's live score, but only
  // while it matches the currently-live match — so a match change falls back to the
  // poll instead of showing a stale scoreboard from the previous game.
  const baseWatch = watching?.state;
  const watchState: TournamentState | undefined =
    baseWatch &&
    liveOverride &&
    watching &&
    liveOverride.id === watching.id &&
    liveOverride.currentMatchIndex === baseWatch.currentMatchIndex
      ? { ...baseWatch, liveScore: liveOverride.liveScore }
      : baseWatch;
  // Past tournaments here are the CURRENT season's only — earlier seasons live
  // behind the "Past Seasons" browser, so this list stays uncluttered.
  const curSeason = data?.season?.number;
  const pastForFormat = (data?.history ?? []).filter(
    (t) => summaryForTab(t) && (curSeason == null || t.season === curSeason)
  );
  // Reigning champion per bucket = the most recent completed tournament's winner
  // THIS season (a fresh season shows blank until its first title is decided).
  const seasonHistory = (data?.history ?? []).filter(
    (t) => curSeason == null || t.season === curSeason
  );
  const champ5 = seasonHistory.find((t) => t.format === 5 && !isSuperSummary(t))?.champion ?? null;
  const champ10 = seasonHistory.find((t) => t.format === 10 && !isSuperSummary(t))?.champion ?? null;
  const champSuper = seasonHistory.find(isSuperSummary)?.champion ?? null;

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
              {newsShown.length > 0 && (
                <div className={styles.news}>
                  <div className={styles.newsTitle}>
                    <span className={styles.newsDot} /> League News
                  </div>
                  {newsShown.map((n, i) => (
                    <div key={n} className={styles.newsItem}>
                      <TypedLine text={n} delay={i * 500} />
                    </div>
                  ))}
                </div>
              )}

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

              {/* Season banner: current season + progress toward its end + past champions. */}
              {data.season && (
                <div className={styles.seasonBanner}>
                  <div className={styles.seasonHead}>
                    <span className={styles.seasonTitle}>🗓️ Season {data.season.number}</span>
                    <span className={styles.seasonSub}>ends at 20 · 20 · 10 leagues</span>
                  </div>
                  <div className={styles.seasonProgress}>
                    <span>5-over <strong>{data.season.leagues5}</strong>/{data.season.caps.five}</span>
                    <span>10-over <strong>{data.season.leagues10}</strong>/{data.season.caps.ten}</span>
                    <span>Super <strong>{data.season.leaguesSuper}</strong>/{data.season.caps.super}</span>
                  </div>
                  {data.season.pastChampions.length > 0 && (
                    <div className={styles.pastChamps}>
                      <div className={styles.pastChampsTitle}>Past Seasons — tap to open</div>
                      {data.season.pastChampions.map((s) => (
                        <button
                          key={s.number}
                          className={styles.pastChampRow}
                          onClick={() => setSeasonView(s.number)}
                        >
                          <span>Season {s.number} ›</span>
                          <span>
                            🏆 <strong>{s.champion ?? '—'}</strong>
                            {s.championTrophies != null ? ` · ${s.championTrophies} 🏆` : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 📊 AI Pundit's Take — placed ABOVE the bidding card / bot list so it's
                  seen immediately, not buried under the bot buttons. */}
              {liveForFormat?.story?.pundit && (
                <div className={styles.aiBox}>
                  <div className={styles.aiTag}>📊 Pundit&apos;s Take</div>
                  <p className={styles.aiText}>{liveForFormat.story.pundit}</p>
                </div>
              )}

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
                <>
                  <div className={styles.champ}>
                    <span>
                      🏆 <strong>{championName(recentForFormat)}</strong> won the latest{' '}
                      {recentForFormat.state.size === 16 ? 'Super League' : `${format}-over league`}
                    </span>
                    <button
                      className={styles.viewBtn}
                      onClick={() => setWatchingId(recentForFormat.id)}
                    >
                      View result
                    </button>
                  </div>
                  {/* 📰 AI recap + 🎬 Player of the Tournament for the just-finished league. */}
                  {recentForFormat.story?.recap && (
                    <div className={styles.aiBox}>
                      <div className={styles.aiTag}>📰 Recap</div>
                      <p className={styles.aiText}>{recentForFormat.story.recap}</p>
                      {recentForFormat.story.potm && (
                        <p className={styles.aiPotm}>🎬 {recentForFormat.story.potm}</p>
                      )}
                    </div>
                  )}
                </>
              )}

              <div className={styles.rankHead}>
                <div className={styles.sectionTitle}>
                  {isSuper ? 'Bot Rankings (10-Over)' : `${format}-Over Rankings`}
                </div>
                <div className={styles.viewToggle}>
                  <button
                    className={rankView === 'season' ? styles.viewOn : styles.viewOff}
                    onClick={() => setRankView('season')}
                  >
                    Season
                  </button>
                  <button
                    className={rankView === 'career' ? styles.viewOn : styles.viewOff}
                    onClick={() => setRankView('career')}
                  >
                    All-time
                  </button>
                </div>
              </div>
              <div className={styles.tableHead}>
                <span className={styles.rank}>#</span>
                <span>Bot</span>
                <span className={styles.num}>Win%</span>
                <span className={styles.num}>🏆</span>
                <span className={styles.rating}>{rankView === 'career' ? 'Played' : 'Rating'}</span>
              </div>
              {displayRankings.map((r, i) => (
                <div
                  key={r.botName}
                  className={[
                    styles.row,
                    // The green/amber league-qualification bands only apply to the
                    // current-season standings (they're about who's seeded into leagues).
                    rankView === 'career' || isSuper
                      ? ''
                      : r.rank <= 10
                        ? styles.qualified
                        : r.rank <= 12
                          ? styles.qualifying
                          : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className={styles.rank}>{rankView === 'career' ? i + 1 : r.rank}</span>
                  <span className={styles.nameCell}>
                    <span className={styles.name}>{r.botName}</span>
                    <span className={styles.sub}>
                      {rankView === 'career'
                        ? `${r.careerPlayed}P · ${r.careerWins}W career`
                        : `${r.played}P · ${r.wins}-${r.losses}-${r.ties}`}
                    </span>
                  </span>
                  <span className={styles.num}>{rankView === 'career' ? r.careerWinPct : r.winPct}%</span>
                  <span className={styles.num}>{rankView === 'career' ? r.careerTrophies : r.trophies}</span>
                  <span className={styles.rating}>{rankView === 'career' ? r.careerPlayed : r.rating}</span>
                </div>
              ))}
              <p className={styles.qualNote}>
                {isSuper
                  ? '⬅ All 16 bots play the Super League — four groups, seeded by 10-over rating.'
                  : '⬅ Top 12 make the league; 11–12 are on the bubble (amber). Ranks 11–16 play the Qualifier to earn games and climb.'}
              </p>

              <div className={styles.sectionTitle}>
                {isSuper ? 'Past Super Leagues' : `Past ${format}-Over Tournaments`}
              </div>
              {pastForFormat.length === 0 ? (
                <p className={styles.empty}>
                  {isSuper
                    ? 'No Super Leagues this season yet — open Past Seasons above for earlier ones.'
                    : `No ${format}-over tournaments this season yet — open Past Seasons above for earlier ones.`}
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
              {watching?.story?.preview && (
                <div className={styles.aiBox}>
                  <div className={styles.aiTag}>🔮 Match Preview</div>
                  <p className={styles.aiText}>{watching.story.preview}</p>
                </div>
              )}
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

      {/* Past-season browser: that season's final standings + its tournaments. */}
      {seasonView != null &&
        (() => {
          const arc = data?.season.pastChampions.find((s) => s.number === seasonView);
          const tours = (data?.history ?? []).filter((t) => t.season === seasonView);
          return (
            <div className={styles.specOverlay} onClick={() => setSeasonView(null)}>
              <div className={styles.specCard} onClick={(e) => e.stopPropagation()}>
                <div className={styles.specHeader}>
                  <h2>🗓️ Season {seasonView}</h2>
                  <button className={styles.close} onClick={() => setSeasonView(null)} aria-label="Close">
                    ✕
                  </button>
                </div>
                <div className={styles.specBody}>
                  {arc?.champion && (
                    <div className={styles.champ}>
                      <span>
                        🏆 Champion: <strong>{arc.champion}</strong>
                        {arc.championTrophies != null ? ` · ${arc.championTrophies} trophies` : ''}
                      </span>
                    </div>
                  )}
                  <div className={styles.sectionTitle}>Final Standings</div>
                  {arc && arc.standings.length > 0 ? (
                    <>
                      <div className={styles.tableHead}>
                        <span className={styles.rank}>#</span>
                        <span>Bot</span>
                        <span className={styles.num}>🏆</span>
                        <span className={styles.num}>Win%</span>
                        <span className={styles.num}>Runs</span>
                      </div>
                      {arc.standings.map((s, i) => (
                        <div key={s.name} className={styles.row}>
                          <span className={styles.rank}>{i + 1}</span>
                          <span className={styles.nameCell}>
                            <span className={styles.name}>{s.name}</span>
                            <span className={styles.sub}>
                              {s.played}P · {s.wins}W
                            </span>
                          </span>
                          <span className={styles.num}>{s.trophies}</span>
                          <span className={styles.num}>{s.winPct}%</span>
                          <span className={styles.num}>{s.runs}</span>
                        </div>
                      ))}
                    </>
                  ) : (
                    <p className={styles.empty}>Final standings weren’t recorded for this season.</p>
                  )}

                  <div className={styles.sectionTitle}>Leagues this season ({tours.length})</div>
                  {tours.length === 0 ? (
                    <p className={styles.empty}>No tournaments from this season are still on record.</p>
                  ) : (
                    (
                      [
                        ['5 Over', tours.filter((t) => t.format === 5 && !isSuperSummary(t))],
                        ['10 Over', tours.filter((t) => t.format === 10 && !isSuperSummary(t))],
                        ['🏆 Super League', tours.filter(isSuperSummary)],
                      ] as [string, BotTournamentSummary[]][]
                    ).map(([label, list]) =>
                      list.length === 0 ? null : (
                        <div key={label}>
                          <div className={styles.subSectionTitle}>
                            {label} ({list.length})
                          </div>
                          {list.map((t, i) => (
                            <PastCard key={`${t.finishedAt}-${i}`} t={t} onView={() => setPastView(t)} />
                          ))}
                        </div>
                      )
                    )
                  )}
                </div>
              </div>
            </div>
          );
        })()}

      {/* 🎩 Draw ceremony: after bidding closes, the random group draw is revealed. */}
      {draw && (
        <div className={styles.drawOverlay}>
          <div className={styles.drawCard}>
            <div className={styles.drawKicker}>🎩 THE DRAW</div>
            <div className={styles.drawTitle}>
              {draw.isSuperLeague ? 'Super League' : `${draw.format}-Over League`}
            </div>
            <div className={styles.drawSub}>The groups have been drawn…</div>
            <div className={styles.drawGroups}>
              {draw.groups.map((g, gi) => (
                <div key={gi} className={styles.drawGroup}>
                  <div className={styles.drawGroupTitle}>Group {String.fromCharCode(65 + gi)}</div>
                  {g.map((name, ni) => (
                    <div
                      key={name}
                      className={styles.drawBot}
                      style={{ animationDelay: `${(gi * g.length + ni) * 0.12 + 0.3}s` }}
                    >
                      {name}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className={styles.drawFoot}>Matches begin shortly…</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A news headline that types itself out (with a blinking caret) for a live-newsroom
 *  feel. Re-types whenever the text changes; `delay` staggers the three lines. */
function TypedLine({ text, delay = 0, speed = 24 }: { text: string; delay?: number; speed?: number }) {
  const [shown, setShown] = useState('');
  useEffect(() => {
    setShown('');
    let i = 0;
    let typer: ReturnType<typeof setInterval> | undefined;
    const starter = setTimeout(() => {
      typer = setInterval(() => {
        i += 1;
        setShown(text.slice(0, i));
        if (i >= text.length && typer) clearInterval(typer);
      }, speed);
    }, delay);
    return () => {
      clearTimeout(starter);
      if (typer) clearInterval(typer);
    };
  }, [text, delay, speed]);
  const typing = shown.length < text.length;
  return (
    <>
      {shown}
      {typing && <span className={styles.caret} />}
    </>
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
  const stake = active.bidStake ?? 0;
  const prize = active.bidPrize ?? 0;
  if (active.myBid) {
    return (
      <div className={styles.bidNote}>
        🎟️ You backed <strong>{active.myBid}</strong> — {prize} 🪙 if they win the league!
      </div>
    );
  }
  if (!biddingOpen) {
    return <div className={styles.bidNote}>🎟️ Bidding closed — the league is underway.</div>;
  }
  if (!user) {
    return (
      <div className={styles.bidNote}>
        🎟️ Log in to back a bot — {stake} 🪙 to enter, win {prize} 🪙 if they take the title.
      </div>
    );
  }
  const canAfford = (user.coins ?? 0) >= stake;
  return (
    <div className={styles.bidBox}>
      <div className={styles.bidTitle}>
        🎟️ Back the champion — {stake} 🪙 to enter · win {prize} 🪙
      </div>
      {!canAfford && (
        <div className={styles.bidNote}>Not enough coins — backing a bot costs {stake} 🪙.</div>
      )}
      <div className={styles.bidGrid}>
        {active.state.players.map((p) => (
          <button
            key={p.id}
            className={styles.bidBtn}
            disabled={!canAfford}
            onClick={() => onBid(p.name)}
          >
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
      {active.story?.preview && <div className={styles.livePreview}>🔮 {active.story.preview}</div>}
      <button className={styles.watchBtn} onClick={onWatch}>
        ▶ Watch Live
      </button>
    </div>
  );
}
