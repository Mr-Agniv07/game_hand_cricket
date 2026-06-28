import { randomUUID } from 'crypto';
import type { Server, DefaultEventsMap } from 'socket.io';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  LiveBidOption,
  LiveBidLockedPayload,
} from '@cric/types';
import type { SocketData } from '../game/types.ts';
import type { Room } from '../game/room.ts';
import type { Tournament } from './handlers.ts';
import { addCoins, getEconomy } from '../db.ts';

// Live in-play prediction markets for spectators of a BOT tournament. Small cards
// pop up frequently, give an ~8s pick window, then vanish; they resolve on the
// real game event (over/match/tournament) and pay a few coins for a correct call.
// Free to play but capped per tournament so it can't be farmed.

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

const PICK_WINDOW_MS = 8000;
const SPAWN_MIN_MS = 7000;
const SPAWN_MAX_MS = 13000;
const CAP_PER_TOURNAMENT = 25;

// KILL SWITCH — live bids are temporarily OFF while we confirm they aren't
// stalling tournaments. With this false, the engine never starts, so every hook
// (onBall/onMatchEnd/place) is an instant no-op (no state ever created).
const LIVE_BIDS_ENABLED = false;

type LBEvent =
  | { type: 'ball' }
  | {
      type: 'matchEnd';
      roomId: string;
      viaSuperOver: boolean;
      inn1: number;
      inn2: number;
      firstBatWon: boolean;
      allOut: boolean;
    }
  | { type: 'tournamentEnd' };

interface LBPick {
  userId: string;
  socketId: string;
  optionId: string;
}

interface LBMarket {
  id: string;
  question: string;
  options: LiveBidOption[];
  reward: number;
  kind: string;
  expiresAt: number;
  picks: Map<string, LBPick>;
  resolved: boolean;
  /** string = winning option id · null = void (no winner) · undefined = not yet resolvable. */
  resolve: (s: LBState, ev: LBEvent) => string | null | undefined;
}

interface LBState {
  code: string;
  tid: string;
  t: Tournament;
  io: GameServer;
  format: number;
  thresholdValue: number;
  spawnTimer?: NodeJS.Timeout;
  open?: LBMarket;
  pending: LBMarket[];
  wonByUser: Map<string, number>;
  offeredKinds: Set<string>;
  matchOffered: Map<string, Set<string>>;
  thresholdOrder: string[];
  hattrickOrder: string[];
  perBotBiggestOver: Map<string, number>;
  match?: { key: string; overRuns: number; consec: number };
}

const states = new Map<string, LBState>(); // keyed by tournament code (== room.tournamentId)

// ─── Helpers ────────────────────────────────────────────────────────────────

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
function sample<T>(arr: T[], n: number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
function runsByName(t: Tournament, name: string): number {
  const p = t.players.find((x) => x.name === name);
  return p ? (t.pointsTable[p.id]?.runsScored ?? 0) : 0;
}

// ─── Market builder ──────────────────────────────────────────────────────────

function buildMarket(s: LBState): LBMarket | null {
  const t = s.t;
  const fmt = s.format;
  const liveFix = t.fixtures[t.currentMatchIndex];
  const roomId = liveFix && liveFix.status === 'live' ? liveFix.roomId : null;

  const matchKindsAll = ['m_superover', 'm_total', 'm_firstwin', 'm_allout', 'm_inn1'];
  const offeredForMatch = roomId ? (s.matchOffered.get(roomId) ?? new Set<string>()) : new Set<string>();
  const matchKinds = roomId ? matchKindsAll.filter((k) => !offeredForMatch.has(k)) : [];
  const tourneyKinds = ['t_top', 't_low', 't_biggest', 't_threshold', 't_hattrick'].filter(
    (k) => !s.offeredKinds.has(k)
  );
  // Weight match markets x2 so the quick ones appear most often.
  const pool = [...matchKinds, ...matchKinds, ...tourneyKinds];
  if (pool.length === 0) return null;
  const kind = pool[Math.floor(Math.random() * pool.length)];

  if (kind.startsWith('m_') && roomId) {
    offeredForMatch.add(kind);
    s.matchOffered.set(roomId, offeredForMatch);
  }
  if (kind.startsWith('t_')) s.offeredKinds.add(kind);

  const id = randomUUID();
  const mk = (
    question: string,
    options: LiveBidOption[],
    reward: number,
    resolve: LBMarket['resolve']
  ): LBMarket => ({
    id,
    question,
    options,
    reward,
    kind,
    expiresAt: Date.now() + PICK_WINDOW_MS,
    picks: new Map(),
    resolved: false,
    resolve,
  });
  const yesno: LiveBidOption[] = [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ];
  const rankedDesc = [...t.players].sort((a, b) => runsByName(t, b.name) - runsByName(t, a.name));
  const atRoom = (ev: LBEvent): ev is Extract<LBEvent, { type: 'matchEnd' }> =>
    ev.type === 'matchEnd' && ev.roomId === roomId;

  switch (kind) {
    case 'm_superover':
      return mk('Will this match need a Super Over?', yesno, 3, (_s, ev) =>
        atRoom(ev) ? (ev.viaSuperOver ? 'yes' : 'no') : undefined
      );
    case 'm_total': {
      const T = fmt === 10 ? 230 + rand(0, 40) : 110 + rand(0, 30);
      return mk(`Both innings combined: ${T}+ runs?`, yesno, 2, (_s, ev) =>
        atRoom(ev) ? (ev.inn1 + ev.inn2 >= T ? 'yes' : 'no') : undefined
      );
    }
    case 'm_firstwin':
      return mk('Will the team batting first win?', yesno, 3, (_s, ev) =>
        atRoom(ev) ? (ev.firstBatWon ? 'yes' : 'no') : undefined
      );
    case 'm_allout':
      return mk('Will any side be bowled out?', yesno, 3, (_s, ev) =>
        atRoom(ev) ? (ev.allOut ? 'yes' : 'no') : undefined
      );
    case 'm_inn1': {
      const T = fmt === 10 ? 110 + rand(0, 40) : 55 + rand(0, 25);
      return mk(`1st innings: ${T}+ runs?`, yesno, 2, (_s, ev) =>
        atRoom(ev) ? (ev.inn1 >= T ? 'yes' : 'no') : undefined
      );
    }
    case 't_top': {
      const cands = rankedDesc.slice(0, 4).map((p) => p.name);
      const options = cands.map((n, i) => ({ id: 'o' + i, label: n }));
      return mk('Tournament top scorer (of these)?', options, 5, (_s, ev) => {
        if (ev.type !== 'tournamentEnd') return undefined;
        let best = 0;
        cands.forEach((n, i) => {
          if (runsByName(t, n) > runsByName(t, cands[best])) best = i;
        });
        return options[best].id;
      });
    }
    case 't_low': {
      const cands = rankedDesc.slice(-4).map((p) => p.name);
      const options = cands.map((n, i) => ({ id: 'o' + i, label: n }));
      return mk('Tournament lowest scorer (of these)?', options, 5, (_s, ev) => {
        if (ev.type !== 'tournamentEnd') return undefined;
        let worst = 0;
        cands.forEach((n, i) => {
          if (runsByName(t, n) < runsByName(t, cands[worst])) worst = i;
        });
        return options[worst].id;
      });
    }
    case 't_biggest': {
      const cands = sample(
        t.players.map((p) => p.name),
        4
      );
      const options = cands.map((n, i) => ({ id: 'o' + i, label: n }));
      return mk('Biggest single over by (of these)?', options, 5, (st, ev) => {
        if (ev.type !== 'tournamentEnd') return undefined;
        let best = 0;
        cands.forEach((n, i) => {
          if ((st.perBotBiggestOver.get(n) ?? 0) > (st.perBotBiggestOver.get(cands[best]) ?? 0))
            best = i;
        });
        return options[best].id;
      });
    }
    case 't_threshold': {
      const cands = sample(
        t.players.map((p) => p.name),
        4
      );
      const options: LiveBidOption[] = [
        ...cands.map((n, i) => ({ id: 'o' + i, label: n })),
        { id: 'none', label: 'None of these' },
      ];
      return mk(`First of these to reach ${s.thresholdValue} in an innings?`, options, 5, (st, ev) => {
        const hit = st.thresholdOrder.find((b) => cands.includes(b));
        if (hit) return 'o' + cands.indexOf(hit);
        return ev.type === 'tournamentEnd' ? 'none' : undefined;
      });
    }
    case 't_hattrick': {
      const cands = sample(
        t.players.map((p) => p.name),
        4
      );
      const options: LiveBidOption[] = [
        ...cands.map((n, i) => ({ id: 'o' + i, label: n })),
        { id: 'none', label: 'No hat-trick' },
      ];
      return mk('First of these to take a hat-trick?', options, 5, (st, ev) => {
        const hit = st.hattrickOrder.find((b) => cands.includes(b));
        if (hit) return 'o' + cands.indexOf(hit);
        return ev.type === 'tournamentEnd' ? 'none' : undefined;
      });
    }
  }
  return null;
}

// ─── Resolution + payout ───────────────────────────────────────────────────────

function resolveMarket(s: LBState, m: LBMarket, winning: string | null): void {
  m.resolved = true;
  if (s.open === m) s.open = undefined;
  const i = s.pending.indexOf(m);
  if (i >= 0) s.pending.splice(i, 1);

  const winLabel = winning ? (m.options.find((o) => o.id === winning)?.label ?? '—') : '—';
  s.io.to('t:' + s.tid).emit('live_bid_resolved', {
    id: m.id,
    winningOptionId: winning,
    winningLabel: winLabel,
  });
  if (!winning) return;

  for (const pick of m.picks.values()) {
    if (pick.optionId !== winning) continue;
    const already = s.wonByUser.get(pick.userId) ?? 0;
    const pay = Math.max(0, Math.min(m.reward, CAP_PER_TOURNAMENT - already));
    if (pay > 0) {
      addCoins(pick.userId, pay);
      s.wonByUser.set(pick.userId, already + pay);
    }
    s.io.to(pick.socketId).emit('live_bid_won', {
      id: m.id,
      reward: pay,
      coins: getEconomy(pick.userId).coins,
      label: winLabel,
    });
  }
}

function sweep(s: LBState, ev: LBEvent): void {
  const markets = s.open ? [s.open, ...s.pending] : [...s.pending];
  for (const m of markets) {
    if (m.resolved) continue;
    let win: string | null | undefined;
    try {
      win = m.resolve(s, ev);
    } catch {
      win = undefined;
    }
    if (win !== undefined) resolveMarket(s, m, win);
  }
}

// ─── Spawning ──────────────────────────────────────────────────────────────────

function scheduleSpawn(s: LBState): void {
  s.spawnTimer = setTimeout(
    () => {
      try {
        if (!s.open && s.t.phase === 'in_progress') {
          const m = buildMarket(s);
          if (m) {
            s.open = m;
            s.io.to('t:' + s.tid).emit('live_bid_offer', {
              id: m.id,
              tournamentId: s.tid,
              question: m.question,
              options: m.options,
              reward: m.reward,
              expiresAt: m.expiresAt,
            });
            // Offer window closes → stop taking picks, keep awaiting its event.
            setTimeout(() => {
              if (s.open === m) {
                s.open = undefined;
                if (!m.resolved) s.pending.push(m);
              }
            }, PICK_WINDOW_MS + 250);
          }
        }
      } catch {
        /* never let a spawn error break anything */
      }
      if (states.get(s.code) === s) scheduleSpawn(s);
    },
    rand(SPAWN_MIN_MS, SPAWN_MAX_MS)
  );
}

// ─── Public API (hooks + actions) ──────────────────────────────────────────────

/** Start the live-bid engine for a bot tournament that just went in-progress. */
export function liveBidsStart(io: GameServer, t: Tournament): void {
  if (!LIVE_BIDS_ENABLED) return; // disabled → engine never starts; all hooks no-op
  if (states.has(t.code)) return;
  const s: LBState = {
    code: t.code,
    tid: t.id,
    t,
    io,
    format: t.format ?? t.overs,
    thresholdValue: (t.format ?? t.overs) === 10 ? 240 : 120,
    pending: [],
    wonByUser: new Map(),
    offeredKinds: new Set(),
    matchOffered: new Map(),
    thresholdOrder: [],
    hattrickOrder: [],
    perBotBiggestOver: new Map(),
  };
  states.set(t.code, s);
  scheduleSpawn(s);
}

/** Tournament finished → resolve every remaining market (superlatives etc.), then clean up. */
export function liveBidsEnd(t: Tournament): void {
  const s = states.get(t.code);
  if (!s) return;
  try {
    sweep(s, { type: 'tournamentEnd' });
  } catch {
    /* ignore */
  }
  if (s.spawnTimer) clearTimeout(s.spawnTimer);
  states.delete(t.code);
}

/** Admin abort → drop the engine without resolving (no payouts). */
export function liveBidsStop(t: Tournament): void {
  const s = states.get(t.code);
  if (!s) return;
  if (s.spawnTimer) clearTimeout(s.spawnTimer);
  states.delete(t.code);
}

/** After each ball of a bot-tournament match — updates trackers and resolves due markets. */
export function liveBidsOnBall(
  _io: GameServer,
  roomId: string,
  room: Room,
  ball: { scored: number; isOut: boolean }
): void {
  try {
    const code = room.tournamentId;
    const s = code ? states.get(code) : undefined;
    if (!s) return;
    const inn = room.innings[room.currentInnings];
    const battingBot = room.players[room.batsmanIdx ?? -1]?.name;
    if (!battingBot) return;

    const key = `${roomId}#${room.currentInnings}`;
    if (!s.match || s.match.key !== key) s.match = { key, overRuns: 0, consec: 0 };
    s.match.overRuns += ball.scored;
    s.match.consec = ball.isOut ? s.match.consec + 1 : 0;
    if (ball.isOut && s.match.consec >= 3) {
      const bowler = room.players[room.bowlerIdx ?? -1]?.name;
      if (bowler && !s.hattrickOrder.includes(bowler)) s.hattrickOrder.push(bowler);
    }
    if (inn.balls % 6 === 0) {
      const prev = s.perBotBiggestOver.get(battingBot) ?? 0;
      if (s.match.overRuns > prev) s.perBotBiggestOver.set(battingBot, s.match.overRuns);
      s.match.overRuns = 0;
    }
    if (inn.score >= s.thresholdValue && !s.thresholdOrder.includes(battingBot))
      s.thresholdOrder.push(battingBot);

    sweep(s, { type: 'ball' });
  } catch {
    /* never break the game loop */
  }
}

/** At the end of a bot-tournament match — resolves match-scoped markets. */
export function liveBidsOnMatchEnd(
  _io: GameServer,
  roomId: string,
  room: Room,
  info: { viaSuperOver: boolean; inn1: number; inn2: number; firstBatWon: boolean; allOut: boolean }
): void {
  try {
    const code = room.tournamentId;
    const s = code ? states.get(code) : undefined;
    if (!s) return;
    sweep(s, { type: 'matchEnd', roomId, ...info });
  } catch {
    /* ignore */
  }
}

/** A spectator picks an option on the currently-open market. */
export function placeLiveBid(
  userId: string,
  socketId: string,
  marketId: string,
  optionId: string
): LiveBidLockedPayload | null {
  for (const s of states.values()) {
    const m = s.open;
    if (!m || m.id !== marketId || m.resolved || Date.now() >= m.expiresAt) continue;
    if (!m.options.some((o) => o.id === optionId)) return null;
    const existing = m.picks.get(userId);
    if (existing) return { id: marketId, optionId: existing.optionId }; // locked once
    m.picks.set(userId, { userId, socketId, optionId });
    return { id: marketId, optionId };
  }
  return null;
}
