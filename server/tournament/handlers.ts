import { randomUUID } from 'crypto';
import type { Server, DefaultEventsMap } from 'socket.io';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  TournamentState,
  TournamentPlayer,
  FixtureMatch,
  PointsTableEntry,
  LiveMatchScore,
  MatchScorecard,
  TournamentAwards,
} from '@cric/types';
import { makeRoomId, createRoom, publicState, cleanName, clampCount, type Room } from '../game/room.ts';
import { makeBotPlayer, makeBotPlayerNamed, isBot } from '../game/bot.ts';
import { driveBots } from '../game/logic.ts';
import {
  liveBidsStart,
  liveBidsEnd,
  liveBidsStop,
  liveBidsPreMatch,
  placeLiveBid,
} from './livebids.ts';
import type { SocketData } from '../game/types.ts';
import {
  incrementAchievements,
  getBotRankings,
  recordBotTrophy,
  recordBotTournament,
  resetBotRankings,
  findById,
  hasUnlock,
  overUnlockId,
  addCoins,
  getEconomy,
  getBotHeadToHead,
  COIN_REWARDS,
} from '../db.ts';
import type { UserAchievements } from '@cric/types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TournamentPlayerEntry {
  id: string;
  name: string;
  userId: string | null;
  /** Stable per-browser id; lets guests (no userId) reconnect to the tournament. */
  clientId?: string | null;
  /** Computer-controlled entrant — fills empty slots and auto-plays its matches. */
  isBot?: boolean;
  /** Bot personality label (carried into the match room). */
  botStyle?: string;
}

export interface InternalFixtureMatch {
  matchNum: number;
  player1Idx: number;
  player2Idx: number;
  status: 'upcoming' | 'live' | 'done';
  result: 'p1' | 'p2' | 'tie' | null;
  p1Score: number;
  p2Score: number;
  roomId: string | null;
  isFinal?: boolean;
  stage: 'group' | 'quarter' | 'semi' | 'final';
  group?: 'A' | 'B';
  label?: string;
  superOver?: boolean;
  scorecard?: MatchScorecard;
}

export interface InternalPointsEntry {
  played: number;
  won: number;
  lost: number;
  tied: number;
  points: number;
  runsScored: number;
  ballsFaced: number;
  runsConceded: number;
  ballsBowled: number;
}

export interface Tournament {
  id: string;
  code: string;
  overs: number;
  wickets: number;
  /** 4 (single group), 8 (two groups of 4), or 12 (two groups of 6 — the Super League). */
  size: number;
  /** Player-index arrays per group. One group for 4 players, two for 8/12. */
  groups: number[][];
  players: TournamentPlayerEntry[];
  phase: 'waiting' | 'in_progress' | 'complete';
  fixtures: InternalFixtureMatch[];
  currentMatchIndex: number;
  pointsTable: Record<string, InternalPointsEntry>;
  liveScore: LiveMatchScore | null;
  /** True once the quarterfinals have been appended (12-player Super League only). */
  quartersCreated?: boolean;
  /** True once the semifinals have been appended (8- and 12-player). */
  semisCreated?: boolean;
  /** True once the playoff final has been appended to fixtures. */
  finalCreated?: boolean;
  /** Final winner's player id (set when the final is decided). */
  champion?: string | null;
  /** Batting awards, computed at finalize. */
  awards?: TournamentAwards | null;
  /** True for an admin-launched all-bot league (feeds the global bot rankings). */
  isBotLeague?: boolean;
  /** True for the 12-bot Super League (all 12 bots, two groups of 6 → quarters). */
  isSuperLeague?: boolean;
  /** True for the 5-over Qualifying Playoffs: the bottom-6 ranked bots play a single
   *  round-robin so they earn games + rating movement. No knockouts, no title. */
  isQualifier?: boolean;
  /** Ranked format (5 or 10 overs) — only set for bot-league tournaments. */
  format?: number;
  /** Spectator bids on the champion: userId → backed bot name (bot leagues only). */
  bids?: Record<string, string>;
  /** Epoch ms when the pre-match bidding window closes (bot leagues only). */
  bidsCloseAt?: number;
  /** Cache for the (expensive) brute-force qualification, keyed by games played so
   *  far — recomputed only when a result changes, not on every per-ball emit. */
  _qualCache?: { doneCount: number; result: Record<string, 'Q' | 'E'> };
  /** Cache for live-match insight lines, keyed by current match + games played. */
  _insightCache?: { key: string; result: { headToHead: string | null; lines: string[] } | null };
  /** NRR margin coaching for the current match, computed ONCE at its innings break
   *  (never in the per-ball hot path) and echoed by the insight builder. */
  _marginInsight?: { matchIndex: number; lines: string[] };
}

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

// ─── State ───────────────────────────────────────────────────────────────────

export const tournaments = new Map<string, Tournament>(); // keyed by tournament code

// ─── Fixture template ─────────────────────────────────────────────────────────

// Round-robin home+away: 12 matches total, each pair plays twice
const FIXTURE_TEMPLATE: [number, number][] = [
  [0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2],
  [1, 0], [3, 2], [2, 0], [3, 1], [3, 0], [2, 1],
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeNRR(e: InternalPointsEntry): number {
  if (e.ballsFaced === 0 || e.ballsBowled === 0) return 0;
  return (e.runsScored * 6) / e.ballsFaced - (e.runsConceded * 6) / e.ballsBowled;
}

/** Fisher–Yates shuffle (returns a new array). */
function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Single round-robin pairings for a set of player indices (circle method). */
function singleRoundRobin(indices: number[]): [number, number][] {
  const arr = [...indices];
  if (arr.length % 2 !== 0) arr.push(-1); // bye marker (unused for groups of 4)
  const m = arr.length;
  const half = m / 2;
  const pairs: [number, number][] = [];
  let order = [...arr];
  for (let r = 0; r < m - 1; r++) {
    for (let i = 0; i < half; i++) {
      const a = order[i];
      const b = order[m - 1 - i];
      if (a !== -1 && b !== -1) pairs.push([a, b]);
    }
    order = [order[0], order[m - 1], ...order.slice(1, m - 1)];
  }
  return pairs;
}

/** Double round-robin: each pair plays twice (home + away). */
function doubleRoundRobin(indices: number[]): [number, number][] {
  const single = singleRoundRobin(indices);
  return [...single, ...single.map(([a, b]): [number, number] => [b, a])];
}

/** Rank a subset of player indices by points desc, then NRR desc. */
function rankedGroupIndices(t: Tournament, indices: number[]): number[] {
  return [...indices].sort((a, b) => {
    const ea = t.pointsTable[t.players[a].id];
    const eb = t.pointsTable[t.players[b].id];
    if (!ea || !eb) return 0;
    if (eb.points !== ea.points) return eb.points - ea.points;
    return computeNRR(eb) - computeNRR(ea);
  });
}

/** All players ranked (used for the 4-player single-group final). */
function rankedPlayerIndices(t: Tournament): number[] {
  return rankedGroupIndices(
    t,
    t.players.map((_, i) => i)
  );
}

/**
 * Aggregate every finished fixture's scorecard into batting awards: most runs
 * (Orange Cap), most sixes, and Player of the Tournament (runs weighted for
 * sixes). Aggregated by batter name (unique within a tournament in practice).
 */
function computeAwards(t: Tournament): TournamentAwards {
  const agg = new Map<string, { runs: number; sixes: number; wickets: number }>();
  const get = (name: string) => {
    let a = agg.get(name);
    if (!a) {
      a = { runs: 0, sixes: 0, wickets: 0 };
      agg.set(name, a);
    }
    return a;
  };
  for (const f of t.fixtures) {
    if (!f.scorecard) continue;
    for (const inn of f.scorecard.innings) {
      const bat = get(inn.batter);
      bat.runs += inn.runs;
      bat.sixes += inn.sixes;
      // The bowler of an innings takes the wickets that fell in it.
      get(inn.bowler).wickets += inn.wickets;
    }
  }
  let orangeCap: TournamentAwards['orangeCap'] = null;
  let mostSixes: TournamentAwards['mostSixes'] = null;
  let purpleCap: TournamentAwards['purpleCap'] = null;
  let playerOfTournament: TournamentAwards['playerOfTournament'] = null;
  let bestImpact = -1;
  for (const [name, a] of agg) {
    if (!orangeCap || a.runs > orangeCap.runs) orangeCap = { name, runs: a.runs };
    if (!mostSixes || a.sixes > mostSixes.sixes) mostSixes = { name, sixes: a.sixes };
    if (!purpleCap || a.wickets > purpleCap.wickets) purpleCap = { name, wickets: a.wickets };
    // Impact rewards an all-round game: runs, big-hitting, and wickets.
    const impact = a.runs + 8 * a.sixes + 20 * a.wickets;
    if (impact > bestImpact) {
      bestImpact = impact;
      playerOfTournament = { name, runs: a.runs, sixes: a.sixes, wickets: a.wickets };
    }
  }
  return {
    orangeCap,
    mostSixes: mostSixes && mostSixes.sixes > 0 ? mostSixes : null,
    purpleCap: purpleCap && purpleCap.wickets > 0 ? purpleCap : null,
    playerOfTournament,
  };
}

/** The advancing player index of a finished knockout fixture (tie → higher seed = player1). */
function fixtureWinnerIdx(f: InternalFixtureMatch): number {
  if (f.result === 'p2') return f.player2Idx;
  return f.player1Idx; // 'p1', 'tie', or unset → the seeded player
}

/**
 * Append the two semifinals (8-player only): SF1 = A1 vs B2, SF2 = B1 vs A2.
 * player1 is the group winner, so a tied semi is awarded to the group winner.
 */
function setupSemis(io: GameServer, t: Tournament): void {
  t.semisCreated = true;
  const aRank = rankedGroupIndices(t, t.groups[0]);
  const bRank = rankedGroupIndices(t, t.groups[1]);
  const [a1, a2] = aRank;
  const [b1, b2] = bRank;
  const base = t.fixtures.length;
  t.fixtures.push({
    matchNum: base + 1,
    player1Idx: a1,
    player2Idx: b2,
    status: 'upcoming',
    result: null,
    p1Score: 0,
    p2Score: 0,
    roomId: null,
    stage: 'semi',
    label: 'Semi Final 1',
  });
  t.fixtures.push({
    matchNum: base + 2,
    player1Idx: b1,
    player2Idx: a2,
    status: 'upcoming',
    result: null,
    p1Score: 0,
    p2Score: 0,
    roomId: null,
    stage: 'semi',
    label: 'Semi Final 2',
  });
  io.to('t:' + t.id).emit('tournament_state', publicTournamentState(t));
}

/**
 * Append the four Super League quarterfinals (12-player only): the top 4 of each
 * group cross over — Q1 A1·B4, Q2 A2·B3, Q3 A3·B2, Q4 A4·B1. player1 is the
 * higher group seed, so a tied quarter is awarded to them.
 */
function setupQuarters(io: GameServer, t: Tournament): void {
  t.quartersCreated = true;
  const a = rankedGroupIndices(t, t.groups[0]);
  const b = rankedGroupIndices(t, t.groups[1]);
  const pairs: [number, number, string][] = [
    [a[0], b[3], 'Quarter Final 1'],
    [a[1], b[2], 'Quarter Final 2'],
    [a[2], b[1], 'Quarter Final 3'],
    [a[3], b[0], 'Quarter Final 4'],
  ];
  for (const [p1, p2, label] of pairs) {
    t.fixtures.push({
      matchNum: t.fixtures.length + 1,
      player1Idx: p1,
      player2Idx: p2,
      status: 'upcoming',
      result: null,
      p1Score: 0,
      p2Score: 0,
      roomId: null,
      stage: 'quarter',
      label,
    });
  }
  io.to('t:' + t.id).emit('tournament_state', publicTournamentState(t));
}

/**
 * Append the two Super League semifinals (12-player only) from the quarter
 * winners: SF1 = W(Q1) vs W(Q4), SF2 = W(Q2) vs W(Q3). player1 is the W(Q1)/
 * W(Q2) side, so a tied semi is awarded to them.
 */
function setupSuperSemis(io: GameServer, t: Tournament): void {
  t.semisCreated = true;
  const qf = t.fixtures.filter((f) => f.stage === 'quarter'); // Q1..Q4 in order
  const w = (i: number) => fixtureWinnerIdx(qf[i]);
  const base = t.fixtures.length;
  t.fixtures.push({
    matchNum: base + 1,
    player1Idx: w(0),
    player2Idx: w(3),
    status: 'upcoming',
    result: null,
    p1Score: 0,
    p2Score: 0,
    roomId: null,
    stage: 'semi',
    label: 'Semi Final 1',
  });
  t.fixtures.push({
    matchNum: base + 2,
    player1Idx: w(1),
    player2Idx: w(2),
    status: 'upcoming',
    result: null,
    p1Score: 0,
    p2Score: 0,
    roomId: null,
    stage: 'semi',
    label: 'Semi Final 2',
  });
  io.to('t:' + t.id).emit('tournament_state', publicTournamentState(t));
}

/**
 * Append the final. For 8 players it's the two semi winners; for 4 it's the top
 * two of the single group (player1 = higher seed, so a tied final goes to them).
 * The final does NOT count toward the league points table.
 */
function setupFinal(io: GameServer, t: Tournament): void {
  t.finalCreated = true;
  let p1: number;
  let p2: number;
  const semis = t.fixtures.filter((f) => f.stage === 'semi');
  if (semis.length === 2) {
    // 8- and 12-player brackets: the two semi winners contest the final.
    p1 = fixtureWinnerIdx(semis[0]);
    p2 = fixtureWinnerIdx(semis[1]);
  } else {
    // 4-player: the top two of the single group.
    [p1, p2] = rankedPlayerIndices(t);
  }
  t.fixtures.push({
    matchNum: t.fixtures.length + 1,
    player1Idx: p1,
    player2Idx: p2,
    status: 'upcoming',
    result: null,
    p1Score: 0,
    p2Score: 0,
    roomId: null,
    isFinal: true,
    stage: 'final',
    label: 'Final',
  });
  io.to('t:' + t.id).emit('tournament_state', publicTournamentState(t));
}

/**
 * Advance the bracket after `completedIdx` finished: play the next scheduled
 * fixture, else move to the next stage (group → semis(8) → final → finalize).
 * Centralised so every completion path (normal end, forfeit, missing player)
 * agrees on what comes next.
 */
export function advanceTournament(
  io: GameServer,
  rooms: Map<string, Room>,
  t: Tournament,
  completedIdx: number
): void {
  const next = completedIdx + 1;
  if (next < t.fixtures.length) {
    startTournamentMatch(io, rooms, t, next);
    return;
  }
  // Qualifier: a flat round-robin — once every game is played, just wrap up. No
  // knockouts (its whole purpose is rating movement for the lower bots).
  if (t.isQualifier) {
    finalizeTournament(io, t);
    return;
  }
  // All currently-scheduled fixtures are done — open the next stage.
  // 12-player Super League: group → quarters → semis → final → finalize.
  if (t.size === 12) {
    if (!t.quartersCreated) {
      const firstQuarter = t.fixtures.length;
      setupQuarters(io, t);
      startTournamentMatch(io, rooms, t, firstQuarter);
    } else if (!t.semisCreated) {
      const firstSemi = t.fixtures.length;
      setupSuperSemis(io, t);
      startTournamentMatch(io, rooms, t, firstSemi);
    } else if (!t.finalCreated) {
      setupFinal(io, t);
      startTournamentMatch(io, rooms, t, t.fixtures.length - 1);
    } else {
      finalizeTournament(io, t);
    }
    return;
  }
  if (t.size === 8 && !t.semisCreated) {
    const firstSemi = t.fixtures.length;
    setupSemis(io, t);
    startTournamentMatch(io, rooms, t, firstSemi);
  } else if (!t.finalCreated) {
    setupFinal(io, t);
    startTournamentMatch(io, rooms, t, t.fixtures.length - 1);
  } else {
    finalizeTournament(io, t);
  }
}

/**
 * A tournament player's identity is their socket.id, stored in both
 * players[].id and as the pointsTable key. Remap both together when the socket
 * id changes on reconnect, or lobby highlighting and points updates land on a
 * dead id. Centralised so the join_tournament and rejoin_room paths agree.
 */
export function remapTournamentSocketId(t: Tournament, oldId: string, newId: string): void {
  if (oldId === newId) return;
  const player = t.players.find((p) => p.id === oldId);
  if (player) player.id = newId;
  const entry = t.pointsTable[oldId];
  if (entry) {
    t.pointsTable[newId] = entry;
    delete t.pointsTable[oldId];
  }
  // The champion is also a socket id; if we don't remap it too, the result
  // screen can't match it to any player after reconnect and falls back to the
  // league topper — silently crowning the wrong player (often a bot).
  if (t.champion === oldId) t.champion = newId;
}

/** How many teams advance from each group: 4 from the 12-team Super League's
 *  groups of 6, otherwise the top 2 (groups of 4, or the single 4-team group). */
function qualifyCountFor(size: number): number {
  return size === 12 ? 4 : 2;
}

/** Remaining (not-yet-played) GROUP games involving this player index. */
function remainingGroupGames(t: Tournament, idx: number): number {
  return t.fixtures.filter(
    (f) =>
      f.stage === 'group' &&
      f.status !== 'done' &&
      (f.player1Idx === idx || f.player2Idx === idx)
  ).length;
}

/** Group points per index (0 if missing). */
function groupPointsOf(t: Tournament, idx: number): number {
  const id = t.players[idx]?.id;
  return (id && t.pointsTable[id]?.points) || 0;
}

/** Remaining group games WITHIN this group, as [p1Idx, p2Idx] pairs. */
function remainingGroupPairs(t: Tournament, group: number[]): [number, number][] {
  return t.fixtures
    .filter(
      (f) =>
        f.stage === 'group' &&
        f.status !== 'done' &&
        group.includes(f.player1Idx) &&
        group.includes(f.player2Idx)
    )
    .map((f) => [f.player1Idx, f.player2Idx] as [number, number]);
}

/**
 * Brute-force the clinch over every win/loss/tie combination of the remaining
 * games — so it understands fixture interdependence (rivals who must still play
 * EACH OTHER can't all overtake you). Sound + NRR-agnostic:
 *   guaranteed (= 'Q'): top-K in EVERY outcome, counting points-ties pessimistically
 *                       (any team that can equal you is treated as above you).
 *   possible   (= not 'E'): top-K in SOME outcome, counting ties optimistically.
 */
function bruteForceClinch(
  basePts: Map<number, number>,
  group: number[],
  remGames: [number, number][],
  K: number
): { guaranteed: Set<number>; possible: Set<number> } {
  const guaranteed = new Set<number>(group);
  const possible = new Set<number>();
  const total = 3 ** remGames.length;
  for (let mask = 0; mask < total; mask++) {
    const fin = new Map(basePts);
    let m = mask;
    for (const [a, b] of remGames) {
      const o = m % 3;
      m = (m - o) / 3;
      if (o === 0) fin.set(a, fin.get(a)! + 2);
      else if (o === 1) fin.set(b, fin.get(b)! + 2);
      else {
        fin.set(a, fin.get(a)! + 1);
        fin.set(b, fin.get(b)! + 1);
      }
    }
    for (const me of group) {
      const mp = fin.get(me)!;
      let above = 0;
      let equal = 0;
      for (const o2 of group) {
        if (o2 === me) continue;
        const op = fin.get(o2)!;
        if (op > mp) above++;
        else if (op === mp) equal++;
      }
      if (above + equal >= K) guaranteed.delete(me); // not safe if ties go against me
      if (above < K) possible.add(me); // could be top-K if ties go my way
    }
  }
  return { guaranteed, possible };
}

/** Sound points-only floor/ceiling clinch — cheap fallback when too many games
 *  remain to brute force (early on, when nothing is clinched anyway). */
function conservativeClinch(t: Tournament, group: number[], K: number, out: Record<string, 'Q' | 'E'>): void {
  const info = group.map((idx) => {
    const points = groupPointsOf(t, idx);
    return { idx, id: t.players[idx]?.id, floor: points, ceiling: points + 2 * remainingGroupGames(t, idx) };
  });
  for (const me of info) {
    if (!me.id) continue;
    const threats = info.filter((o) => o.idx !== me.idx && o.ceiling >= me.floor).length;
    const lockedAbove = info.filter((o) => o.idx !== me.idx && o.floor > me.ceiling).length;
    if (threats < K) out[me.id] = 'Q';
    else if (lockedAbove >= K) out[me.id] = 'E';
  }
}

const MAX_BRUTE_GAMES = 11; // 3^11 ≈ 177k — fine once per match (cached)

function computeQualificationFresh(t: Tournament): Record<string, 'Q' | 'E'> {
  const out: Record<string, 'Q' | 'E'> = {};
  if (!t.groups.length) return out;
  const K = qualifyCountFor(t.size);

  for (const group of t.groups) {
    const remGames = remainingGroupPairs(t, group);

    if (remGames.length === 0) {
      // Group done → final table decides, tie-break by NRR (same order the bracket uses).
      const nrrOf = (idx: number) => {
        const e = t.pointsTable[t.players[idx]?.id ?? ''];
        return e ? computeNRR(e) : 0;
      };
      [...group]
        .sort((a, b) => groupPointsOf(t, b) - groupPointsOf(t, a) || nrrOf(b) - nrrOf(a))
        .forEach((idx, pos) => {
          const id = t.players[idx]?.id;
          if (id) out[id] = pos < K ? 'Q' : 'E';
        });
      continue;
    }

    if (remGames.length > MAX_BRUTE_GAMES) {
      conservativeClinch(t, group, K, out); // too early to clinch anyway
      continue;
    }

    const basePts = new Map(group.map((idx) => [idx, groupPointsOf(t, idx)]));
    const { guaranteed, possible } = bruteForceClinch(basePts, group, remGames, K);
    for (const idx of group) {
      const id = t.players[idx]?.id;
      if (!id) continue;
      if (guaranteed.has(idx)) out[id] = 'Q';
      else if (!possible.has(idx)) out[id] = 'E';
    }
  }
  return out;
}

/**
 * Per-player knockout-qualification status for the group stage — 'Q' (guaranteed
 * top-N regardless of remaining results AND net run rate) or 'E' (can't reach
 * top-N in any outcome). Brute-forces the remaining fixtures so it respects
 * interdependence (rivals that must still play each other). Cached by games
 * played, so the brute force runs at most once per completed match.
 */
function computeQualification(t: Tournament): Record<string, 'Q' | 'E'> {
  if (t.isQualifier) return {}; // no knockout to qualify for — it's a rating round-robin
  const doneCount = t.fixtures.filter((f) => f.status === 'done').length;
  if (t._qualCache && t._qualCache.doneCount === doneCount) return t._qualCache.result;
  const result = computeQualificationFresh(t);
  t._qualCache = { doneCount, result };
  return result;
}

// ─── Live-match insights ────────────────────────────────────────────────────

type TeamInfo = { idx: number; points: number; remaining: number };

/** Clinch status for one team given a set of group infos (floors/ceilings). */
function statusFromInfos(infos: TeamInfo[], meIdx: number, K: number): 'Q' | 'E' | null {
  const me = infos.find((i) => i.idx === meIdx);
  if (!me) return null;
  const floor = me.points;
  const ceiling = me.points + 2 * me.remaining;
  const threats = infos.filter((o) => o.idx !== meIdx && o.points + 2 * o.remaining >= floor).length;
  const lockedAbove = infos.filter((o) => o.idx !== meIdx && o.points > ceiling).length;
  if (threats < K) return 'Q';
  if (lockedAbove >= K) return 'E';
  return null;
}

/** Apply a hypothetical decided result to a copy of the group infos. */
function withResult(infos: TeamInfo[], winnerIdx: number, loserIdx: number): TeamInfo[] {
  return infos.map((i) =>
    i.idx === winnerIdx
      ? { ...i, points: i.points + 2, remaining: Math.max(0, i.remaining - 1) }
      : i.idx === loserIdx
        ? { ...i, remaining: Math.max(0, i.remaining - 1) }
        : i
  );
}

/** Remaining games with the first occurrence of the {a,b} fixture removed. */
function removeGame(games: [number, number][], a: number, b: number): [number, number][] {
  const i = games.findIndex(
    ([x, y]) => (x === a && y === b) || (x === b && y === a)
  );
  return i === -1 ? games : [...games.slice(0, i), ...games.slice(i + 1)];
}

/**
 * One team's qualification stake line for the live group match — brute-forced so
 * it's accurate (respects who-plays-whom). "already through" / "eliminated" use
 * the guaranteed/possible clinch; otherwise it forces THIS match win/lose to see
 * if a win secures a spot or a loss is fatal.
 */
function matchScenario(
  t: Tournament,
  group: number[],
  remGames: [number, number][],
  K: number,
  me: number,
  opp: number,
  name: string
): string | null {
  // CRITICAL: bruteForceClinch is 3^remGames. With many games left (e.g. a Super
  // League group of 6 = 15 games → 3^15 ≈ 14M, called 3× per team) this blocks the
  // event loop for minutes and the whole server goes unresponsive. Gate it exactly
  // like computeQualificationFresh: when too many games remain, fall back to the
  // cheap floor/ceiling clinch (nothing is clinched that early anyway).
  if (remGames.length > MAX_BRUTE_GAMES) {
    const infos: TeamInfo[] = group.map((idx) => ({
      idx,
      points: groupPointsOf(t, idx),
      remaining: remainingGroupGames(t, idx),
    }));
    if (statusFromInfos(infos, me, K) === 'Q') return `${name}: already through — playing for seeding.`;
    if (statusFromInfos(infos, me, K) === 'E') return `${name}: eliminated — pride on the line.`;
    const loseOut = statusFromInfos(withResult(infos, opp, me), me, K) === 'E';
    const winSecures = statusFromInfos(withResult(infos, me, opp), me, K) === 'Q';
    if (loseOut) return `${name}: must win to stay alive${winSecures ? ' — a win seals it' : ''}.`;
    if (winSecures) return `${name}: a win secures a knockout spot.`;
    return null;
  }

  const basePts = new Map(group.map((i) => [i, groupPointsOf(t, i)]));
  const base = bruteForceClinch(basePts, group, remGames, K);
  if (base.guaranteed.has(me)) return `${name}: already through — playing for seeding.`;
  if (!base.possible.has(me)) return `${name}: eliminated — pride on the line.`;

  const rest = removeGame(remGames, me, opp);
  const winPts = new Map(basePts);
  winPts.set(me, winPts.get(me)! + 2);
  const losePts = new Map(basePts);
  losePts.set(opp, losePts.get(opp)! + 2);
  const winSecures = bruteForceClinch(winPts, group, rest, K).guaranteed.has(me);
  const loseOut = !bruteForceClinch(losePts, group, rest, K).possible.has(me);

  if (loseOut) return `${name}: must win to stay alive${winSecures ? ' — a win seals it' : ''}.`;
  if (winSecures) return `${name}: a win secures a knockout spot.`;
  return null;
}

/**
 * How urgently a team should chase a result in a GROUP match, from its live
 * qualification picture: ~ -0.3 (dead rubber — already through or out) → +1
 * (must win or be eliminated). Bots fold this lightly into their aggression
 * (scaled by situationalIq) so the smart ones lift their game when it matters.
 */
function qualUrgency(infos: TeamInfo[], me: number, opp: number, K: number): number {
  const cur = statusFromInfos(infos, me, K);
  if (cur === 'Q' || cur === 'E') return -0.3; // nothing left to play for
  if (statusFromInfos(withResult(infos, opp, me), me, K) === 'E') return 1.0; // lose = out
  if (statusFromInfos(withResult(infos, me, opp), me, K) === 'Q') return 0.6; // win = through
  return 0.2; // every win still helps the cause
}

/** Per-room-index qualification urgency for a group fixture (else undefined). */
function groupStakesFor(t: Tournament, fixture: InternalFixtureMatch): Record<number, number> | undefined {
  if (fixture.stage !== 'group') return undefined;
  const K = qualifyCountFor(t.size);
  const group = t.groups.find((g) => g.includes(fixture.player1Idx)) ?? [];
  const infos: TeamInfo[] = group.map((idx) => ({
    idx,
    points: (t.players[idx]?.id && t.pointsTable[t.players[idx].id]?.points) || 0,
    remaining: remainingGroupGames(t, idx),
  }));
  return {
    0: qualUrgency(infos, fixture.player1Idx, fixture.player2Idx, K),
    1: qualUrgency(infos, fixture.player2Idx, fixture.player1Idx, K),
  };
}

/** Head-to-head + qualification stakes for the currently-live match (null if none).
 *  Cached by current match + games played so the brute-forced scenarios only run
 *  once per match, not on every per-ball emit. */
// ─── NRR margin coaching (computed ONCE at the innings break) ──────────────────

type NrrTot = { name: string; pts: number; rs: number; bf: number; rc: number; bb: number };
const nrrOf = (x: NrrTot) => (x.bf && x.bb ? (x.rs * 6) / x.bf - (x.rc * 6) / x.bb : 0);
const isTopK = (rows: NrrTot[], name: string, K: number) =>
  [...rows].sort((a, b) => b.pts - a.pts || nrrOf(b) - nrrOf(a)).slice(0, K).some((r) => r.name === name);
/** Smallest x in [lo,hi] with pred(x) true, for a monotonic false→true predicate (null if none). */
const firstTrue = (lo: number, hi: number, pred: (x: number) => boolean): number | null => {
  if (!pred(hi)) return null;
  while (lo < hi) { const m = (lo + hi) >> 1; if (pred(m)) hi = m; else lo = m + 1; }
  return lo;
};
/** Largest x in [lo,hi] with pred(x) true, for a monotonic true→false predicate (null if none). */
const lastTrue = (lo: number, hi: number, pred: (x: number) => boolean): number | null => {
  if (!pred(lo)) return null;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pred(m)) lo = m; else hi = m - 1; }
  return lo;
};

/**
 * Compute the exact NRR margin lines for the group's LAST decisive game, ONCE, at
 * its innings break (when the 1st-innings total is final). Stores them on the
 * tournament so the per-ball insight builder just echoes them — no work in the hot
 * path. Defended/chased totals follow the official NRR rules (a side that bats its
 * innings out counts the full over quota; a chasing winner counts only the balls it
 * used). Each threshold is found by binary search over a monotonic predicate.
 * Fully guarded — insight math must never break the game loop.
 */
export function computeMarginInsightAtBreak(
  t: Tournament,
  defenderName: string,
  chaserName: string,
  firstInningsScore: number
): void {
  try {
    if (t.phase !== 'in_progress') return;
    const fx = t.fixtures[t.currentMatchIndex];
    if (!fx || fx.stage !== 'group') return;
    const group = t.groups.find((g) => g.includes(fx.player1Idx));
    if (!group) return;
    if (remainingGroupPairs(t, group).length !== 1) return; // only the last decisive game

    const K = qualifyCountFor(t.size);
    const sixO = 6 * t.overs;
    const S = firstInningsScore;

    const base: NrrTot[] = group.map((idx) => {
      const e = t.pointsTable[t.players[idx]?.id ?? ''];
      return {
        name: t.players[idx]?.name ?? '?',
        pts: e?.points ?? 0,
        rs: e?.runsScored ?? 0,
        bf: e?.ballsFaced ?? 0,
        rc: e?.runsConceded ?? 0,
        bb: e?.ballsBowled ?? 0,
      };
    });
    const ci = base.findIndex((r) => r.name === chaserName);
    const di = base.findIndex((r) => r.name === defenderName);
    if (ci < 0 || di < 0) return;

    // Chaser wins, reaching S+1 with `spare` balls left (used b = sixO - spare).
    const chaseTable = (spare: number): NrrTot[] => {
      const b = Math.max(1, sixO - spare);
      const a = base.map((r) => ({ ...r }));
      const C = a[ci], D = a[di];
      C.pts += 2; C.rs += S + 1; C.bf += b; C.rc += S; C.bb += sixO;
      D.rs += S; D.bf += sixO; D.rc += S + 1; D.bb += b;
      return a;
    };
    // Defender wins by M runs (chaser ends on S-M over the full quota).
    const defendTable = (M: number): NrrTot[] => {
      const a = base.map((r) => ({ ...r }));
      const C = a[ci], D = a[di];
      D.pts += 2; D.rs += S; D.bf += sixO; D.rc += Math.max(0, S - M); D.bb += sixO;
      C.rs += Math.max(0, S - M); C.bf += sixO; C.rc += S; C.bb += sixO;
      return a;
    };
    const cutoffRival = (rows: NrrTot[], exclude: string): string | null => {
      const top = [...rows].sort((a, b) => b.pts - a.pts || nrrOf(b) - nrrOf(a)).slice(0, K).map((r) => r.name);
      if (top.includes(exclude)) return null;
      return top[top.length - 1] ?? null;
    };
    const ptsWall = (rows: NrrTot[], i: number) => rows.filter((r, j) => j !== i && r.pts > rows[i].pts).length >= K;

    const lines: string[] = [];

    // (1) Chaser wins — does it need a fast enough chase, or is the spot unreachable?
    const cMin = firstTrue(0, sixO - 1, (spare) => isTopK(chaseTable(spare), chaserName, K));
    if (cMin !== null && cMin > 0)
      lines.push(`${chaserName}: must chase ${S + 1} with ${cMin}+ ball${cMin > 1 ? 's' : ''} to spare to go through (NRR).`);
    else if (cMin === null && !ptsWall(chaseTable(sixO - 1), ci))
      lines.push(`${chaserName}: out — even the fastest possible win can't overhaul ${cutoffRival(chaseTable(sixO - 1), chaserName) ?? 'the'}'s NRR.`);

    // (2) Defender loses the chase — survives unless the chase is quick?
    const dMax = lastTrue(0, sixO - 1, (spare) => isTopK(chaseTable(spare), defenderName, K));
    if (dMax !== null && dMax < sixO - 1) {
      const third = cutoffRival(chaseTable(dMax + 1), defenderName);
      lines.push(`${defenderName}: survives defeat — unless ${chaserName} wins with ${dMax + 1}+ balls to spare${third && third !== chaserName ? ` (then ${third} goes through on NRR)` : ''}.`);
    }

    // (3) Defender wins — a win enough, a runs margin needed, or unreachable?
    const dMin = firstTrue(1, S, (M) => isTopK(defendTable(M), defenderName, K));
    if (dMin !== null && dMin > 1)
      lines.push(`${defenderName}: a win alone won't do — must win by ${dMin}+ runs to go through (NRR).`);
    else if (dMin === null && !ptsWall(defendTable(S), di))
      lines.push(`${defenderName}: out — even the biggest possible win can't overhaul ${cutoffRival(defendTable(S), defenderName) ?? 'the'}'s NRR.`);

    // (4) Chaser loses — survives unless beaten by too big a margin?
    const cLoseMax = lastTrue(1, S, (M) => isTopK(defendTable(M), chaserName, K));
    if (cLoseMax !== null && cLoseMax < S) {
      const third = cutoffRival(defendTable(cLoseMax + 1), chaserName);
      lines.push(`${chaserName}: survives a loss — unless beaten by ${cLoseMax + 1}+ runs${third && third !== defenderName ? ` (then ${third} goes through on NRR)` : ''}.`);
    }

    if (lines.length === 0) return;
    t._marginInsight = { matchIndex: t.currentMatchIndex, lines };
    t._insightCache = undefined; // bust once so the lines fold into the cached insights
  } catch (e) {
    console.error('[marginInsight] failed (ignored):', e);
  }
}

function computeLiveInsights(t: Tournament): { headToHead: string | null; lines: string[] } | null {
  if (t.phase !== 'in_progress') return null;
  const fx = t.fixtures[t.currentMatchIndex];
  if (!fx || fx.status !== 'live') return null;
  const doneCount = t.fixtures.filter((f) => f.status === 'done').length;
  const cacheKey = `${t.currentMatchIndex}:${doneCount}`;
  if (t._insightCache && t._insightCache.key === cacheKey) return t._insightCache.result;
  const result = computeLiveInsightsFresh(t, fx);
  t._insightCache = { key: cacheKey, result };
  return result;
}

function computeLiveInsightsFresh(
  t: Tournament,
  fx: InternalFixtureMatch
): { headToHead: string | null; lines: string[] } | null {
  const p1 = t.players[fx.player1Idx];
  const p2 = t.players[fx.player2Idx];
  if (!p1 || !p2) return null;

  // Lifetime head-to-head for THIS format (5- and 10-over kept separate) — only
  // meaningful between two roster bots.
  let headToHead: string | null = null;
  if (p1.isBot && p2.isBot) {
    const fmt = t.format ?? t.overs;
    const h = getBotHeadToHead(p1.name, p2.name, fmt);
    headToHead =
      h.played === 0
        ? `First-ever ${fmt}-over meeting between ${p1.name} and ${p2.name}.`
        : `Head-to-head (${fmt}-over): ${p1.name} ${h.xWins}–${h.yWins} ${p2.name}` +
          (h.ties ? ` (${h.ties} tie${h.ties > 1 ? 's' : ''}).` : '.');
  }

  // Qualifier: no knockout to chase, so no qualification stakes/margin lines — just
  // the head-to-head.
  if (t.isQualifier) return headToHead ? { headToHead, lines: [] } : null;

  const lines: string[] = [];
  if (fx.stage === 'group') {
    const K = qualifyCountFor(t.size);
    const group = t.groups.find((g) => g.includes(fx.player1Idx)) ?? [];
    const remGames = remainingGroupPairs(t, group);
    for (const [me, opp] of [
      [fx.player1Idx, fx.player2Idx],
      [fx.player2Idx, fx.player1Idx],
    ] as const) {
      const line = matchScenario(t, group, remGames, K, me, opp, t.players[me]?.name ?? '?');
      if (line) lines.push(line);
    }
    // Echo the NRR margin lines computed once at this match's innings break (no work
    // here — just a cached read, guarded against staleness from a previous match).
    if (t._marginInsight && t._marginInsight.matchIndex === t.currentMatchIndex)
      for (const l of t._marginInsight.lines) lines.push(l);
  } else {
    lines.push(
      fx.stage === 'final'
        ? 'The final — the winner lifts the trophy.'
        : `${fx.label ?? 'Knockout'} — win or go home.`
    );
  }

  if (!headToHead && lines.length === 0) return null;
  return { headToHead, lines };
}

export function publicTournamentState(t: Tournament): TournamentState {
  return {
    id: t.id,
    code: t.code,
    overs: t.overs,
    wickets: t.wickets,
    size: t.size,
    groups: t.groups,
    players: t.players.map((p): TournamentPlayer => ({ id: p.id, name: p.name })),
    phase: t.phase,
    fixtures: t.fixtures.map(
      (f): FixtureMatch => ({
        matchNum: f.matchNum,
        player1Idx: f.player1Idx,
        player2Idx: f.player2Idx,
        status: f.status,
        result: f.result,
        p1Score: f.p1Score,
        p2Score: f.p2Score,
        isFinal: f.isFinal ?? false,
        stage: f.stage,
        group: f.group,
        label: f.label,
        superOver: f.superOver,
        scorecard: f.scorecard,
      })
    ),
    currentMatchIndex: t.currentMatchIndex,
    pointsTable: Object.fromEntries(
      Object.entries(t.pointsTable).map(([id, e]): [string, PointsTableEntry] => [
        id,
        { ...e, nrr: computeNRR(e) },
      ])
    ),
    liveScore: t.liveScore,
    champion: t.champion ?? null,
    awards: t.awards ?? null,
    qualification: computeQualification(t),
    liveInsights: computeLiveInsights(t),
    isQualifier: t.isQualifier,
  };
}

export function generateFixture(tournament: Tournament): void {
  const mkFixture = (
    n: number,
    p1: number,
    p2: number,
    group?: 'A' | 'B'
  ): InternalFixtureMatch => ({
    matchNum: n,
    player1Idx: p1,
    player2Idx: p2,
    status: 'upcoming',
    result: null,
    p1Score: 0,
    p2Score: 0,
    roomId: null,
    stage: 'group',
    group,
  });

  if (tournament.isQualifier) {
    // Qualifying Playoffs: one group, a SINGLE round-robin (everyone plays everyone
    // once). No knockouts — it exists purely to give the lower bots games + rating.
    const all = tournament.players.map((_, i) => i);
    tournament.groups = [all];
    tournament.fixtures = singleRoundRobin(all).map(([p1, p2], i) => mkFixture(i + 1, p1, p2));
  } else if (tournament.size === 12) {
    // Super League: split the 12 into two groups of 6, SINGLE round-robin per
    // group (each team plays the other five once → 5 matches each, 15 per group),
    // interleaved so both groups progress together. Seeded by rank (players arrive
    // in rank order): odd seeds (1st/3rd/5th/7th/9th/11th) to Group A, even seeds
    // to Group B, keeping the top seeds apart.
    let groupA: number[];
    let groupB: number[];
    if (tournament.isBotLeague) {
      groupA = [0, 2, 4, 6, 8, 10];
      groupB = [1, 3, 5, 7, 9, 11];
    } else {
      const order = shuffled(tournament.players.map((_, i) => i));
      groupA = order.slice(0, 6);
      groupB = order.slice(6, 12);
    }
    tournament.groups = [groupA, groupB];
    const aPairs = singleRoundRobin(groupA); // 15 (each pair once)
    const bPairs = singleRoundRobin(groupB); // 15
    const fixtures: InternalFixtureMatch[] = [];
    for (let i = 0; i < Math.max(aPairs.length, bPairs.length); i++) {
      if (aPairs[i]) fixtures.push(mkFixture(fixtures.length + 1, aPairs[i][0], aPairs[i][1], 'A'));
      if (bPairs[i]) fixtures.push(mkFixture(fixtures.length + 1, bPairs[i][0], bPairs[i][1], 'B'));
    }
    tournament.fixtures = fixtures;
  } else if (tournament.size === 8) {
    // Split the 8 into two groups of 4, single round-robin per group, interleaved
    // so both groups progress together. Human tournaments draw randomly; a bot
    // league seeds by rank (players arrive in rank order) — 1st/3rd/5th/7th to
    // Group A, 2nd/4th/6th/8th to Group B, so the top seeds are kept apart.
    let groupA: number[];
    let groupB: number[];
    if (tournament.isBotLeague) {
      groupA = [0, 2, 4, 6];
      groupB = [1, 3, 5, 7];
    } else {
      const order = shuffled(tournament.players.map((_, i) => i));
      groupA = order.slice(0, 4);
      groupB = order.slice(4, 8);
    }
    tournament.groups = [groupA, groupB];
    const aPairs = doubleRoundRobin(groupA); // 12 (each pair twice)
    const bPairs = doubleRoundRobin(groupB); // 12
    const fixtures: InternalFixtureMatch[] = [];
    for (let i = 0; i < Math.max(aPairs.length, bPairs.length); i++) {
      if (aPairs[i]) fixtures.push(mkFixture(fixtures.length + 1, aPairs[i][0], aPairs[i][1], 'A'));
      if (bPairs[i]) fixtures.push(mkFixture(fixtures.length + 1, bPairs[i][0], bPairs[i][1], 'B'));
    }
    tournament.fixtures = fixtures;
  } else {
    // 4 players: one group, double round-robin (the original 12-match template).
    tournament.groups = [tournament.players.map((_, i) => i)];
    tournament.fixtures = FIXTURE_TEMPLATE.map(([p1, p2], i) => mkFixture(i + 1, p1, p2));
  }

  for (const p of tournament.players) {
    tournament.pointsTable[p.id] = {
      played: 0,
      won: 0,
      lost: 0,
      tied: 0,
      points: 0,
      runsScored: 0,
      ballsFaced: 0,
      runsConceded: 0,
      ballsBowled: 0,
    };
  }
}

export function pushLiveScore(
  io: GameServer,
  room: Room,
  lastBall: LiveMatchScore['lastBall']
): void {
  if (!room.tournamentId) return;
  const tournament = tournaments.get(room.tournamentId);
  if (!tournament) return;
  const inn = room.innings[room.currentInnings];
  tournament.liveScore = {
    batsmanName: room.players[room.batsmanIdx!].name,
    bowlerName: room.players[room.bowlerIdx!].name,
    score: inn.score,
    balls: inn.balls,
    overs: room.overs,
    wicketsLost: inn.wicketsLost,
    wickets: room.wickets,
    target: room.currentInnings === 1 ? room.innings[0].score + 1 : null,
    currentInnings: room.currentInnings + 1,
    lastBall,
    tossWinnerName: room.tossWinnerName ?? '',
    tossDecision: room.tossDecision ?? 'bat',
  };
  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
}

/**
 * Credit career honours to the registered players in a finished tournament:
 * champion, the three caps, Most Sixes and Player of the Tournament, plus a
 * "played" tick for everyone. Awards are keyed by name, so map them back to a
 * player to find the userId; bots/guests (no userId) are skipped.
 */
function recordTournamentAchievements(t: Tournament): void {
  const incs: Array<{ userId: string; key: keyof UserAchievements }> = [];
  const add = (userId: string | null | undefined, key: keyof UserAchievements) => {
    if (userId) incs.push({ userId, key });
  };
  const byName = (name?: string | null) =>
    name ? t.players.find((p) => p.name === name) : undefined;

  add(t.players.find((p) => p.id === t.champion)?.userId, 'tournamentsWon');
  const a = t.awards;
  if (a) {
    add(byName(a.orangeCap?.name)?.userId, 'orangeCaps');
    add(byName(a.purpleCap?.name)?.userId, 'purpleCaps');
    add(byName(a.mostSixes?.name)?.userId, 'mostSixesAwards');
    add(byName(a.playerOfTournament?.name)?.userId, 'playerOfTournament');
  }
  for (const p of t.players) add(p.userId, 'tournamentsPlayed');

  incrementAchievements(incs);
}

export function finalizeTournament(io: GameServer, tournament: Tournament): void {
  // Guard against a double finalize (e.g. a forfeited final racing the normal
  // path) — without it, achievements would be counted twice.
  if (tournament.phase === 'complete') return;
  tournament.phase = 'complete';
  // Resolve any remaining live in-play bids (tournament superlatives) + clean up.
  if (tournament.isBotLeague) liveBidsEnd(tournament);
  // Defensive: if we somehow finalized without a recorded champion, fall back to
  // the league topper so the result screen always has a winner.
  if (!tournament.champion) {
    const topIdx = rankedPlayerIndices(tournament)[0];
    tournament.champion = tournament.players[topIdx]?.id ?? null;
  }
  tournament.awards = computeAwards(tournament);
  recordTournamentAchievements(tournament);
  // Bot league: credit the champion a trophy and save a durable history record
  // (champion, runner-up, final standings) so past winners survive restarts. The
  // Qualifier is skipped here — it has no title; per-match ratings already moved
  // during play (recordBotLeagueMatch), which is its entire point.
  if (tournament.isBotLeague && !tournament.isQualifier && tournament.format && tournament.champion) {
    const champ = tournament.players.find((p) => p.id === tournament.champion);
    if (champ) {
      recordBotTrophy(champ.name, tournament.format);

      const finalFix = tournament.fixtures.find((f) => f.stage === 'final');
      let runnerUp: string | null = null;
      if (finalFix) {
        const fp1 = tournament.players[finalFix.player1Idx];
        const fp2 = tournament.players[finalFix.player2Idx];
        const loser = champ.id === fp1?.id ? fp2 : fp1;
        runnerUp = loser?.name ?? null;
      }

      const standings = tournament.players
        .map((p) => {
          const e = tournament.pointsTable[p.id];
          return { name: p.name, won: e?.won ?? 0, lost: e?.lost ?? 0, points: e?.points ?? 0 };
        })
        .sort((a, b) => b.points - a.points)
        .map(({ name, won, lost }) => ({ name, won, lost }));

      recordBotTournament({
        format: tournament.format,
        champion: champ.name,
        runnerUp,
        standings,
        state: publicTournamentState(tournament),
      });
    }
  }

  // Pay out spectator bids: anyone who backed the winning bot earns coins, and is
  // notified live (balance + celebration) if they're online.
  if (tournament.isBotLeague && tournament.bids && tournament.champion) {
    const champName = tournament.players.find((p) => p.id === tournament.champion)?.name;
    if (champName) {
      for (const [userId, botName] of Object.entries(tournament.bids)) {
        if (botName !== champName) continue;
        addCoins(userId, COIN_REWARDS.bidWin);
        const coins = getEconomy(userId).coins;
        for (const [, s] of io.sockets.sockets) {
          if (s.data.userId === userId) {
            s.emit('bid_won', { botName: champName, reward: COIN_REWARDS.bidWin, coins });
            break;
          }
        }
      }
    }
  }

  // Coin reward: a registered champion earns coins for winning a (non-bot-league)
  // tournament that included at least one of their friends.
  if (!tournament.isBotLeague && tournament.champion) {
    const champPlayer = tournament.players.find((p) => p.id === tournament.champion);
    if (champPlayer?.userId) {
      const friendIds = new Set(findById(champPlayer.userId)?.friends ?? []);
      const hadFriend = tournament.players.some(
        (p) => p.id !== champPlayer.id && p.userId && friendIds.has(p.userId)
      );
      if (hadFriend) addCoins(champPlayer.userId, COIN_REWARDS.tournamentWinWithFriend);
    }
  }
  const state = publicTournamentState(tournament);
  io.to('t:' + tournament.id).emit('tournament_state', state);
  io.to('t:' + tournament.id).emit('tournament_complete', {
    players: state.players,
    pointsTable: state.pointsTable,
  });
  // Reap the finished tournament after a grace window long enough for the result
  // screen and any refresh-driven reconnects to still read it. Without this,
  // completed tournaments pile up in the map forever and their stale host
  // socket.id shadows lookups when that player starts a new tournament.
  setTimeout(() => tournaments.delete(tournament.code), 5 * 60_000);
}

/**
 * A player abandoned a live match (disconnect grace elapsed without reconnect).
 * Award the fixture to the surviving player and schedule the next match —
 * without this the whole tournament stalls on this fixture forever, since
 * nothing else advances `currentMatchIndex` once the room is gone.
 * `advanceDelayMs` defaults long enough for the surviving client to clear its
 * "opponent disconnected" screen (3s) and return to the tournament lobby first.
 */
export function forfeitTournamentMatch(
  io: GameServer,
  rooms: Map<string, Room>,
  tournament: Tournament,
  matchIndex: number,
  loserId: string,
  advanceDelayMs = 4000,
  loserRoom?: Room
): void {
  const fixture = tournament.fixtures[matchIndex];
  if (!fixture || fixture.status === 'done') return;

  fixture.status = 'done';
  const fp1 = tournament.players[fixture.player1Idx];
  const fp2 = tournament.players[fixture.player2Idx];
  // loserId is a socket id; resolve it to one of the fixture's tournament players
  // by STABLE identity (userId/clientId), since a mid-match reconnect can desync
  // the room's socket id from the tournament's. Keying the pointsTable off the raw
  // socket id would otherwise miss the loser's entry (and could hand the result to
  // the wrong side). Always pins the loss to one of the two fixture players.
  const loserRp = loserRoom?.players.find((p) => p.id === loserId);
  const isLoser = (tp: TournamentPlayerEntry) =>
    tp.id === loserId ||
    (loserRp != null &&
      ((loserRp.userId != null && tp.userId === loserRp.userId) ||
        (loserRp.clientId != null && tp.clientId === loserRp.clientId)));
  const p1Lost = isLoser(fp1) && !isLoser(fp2);
  fixture.result = p1Lost ? 'p2' : 'p1';
  const winnerId = p1Lost ? fp2.id : fp1.id;
  const loserKey = p1Lost ? fp1.id : fp2.id;

  if (fixture.stage === 'final') {
    // A forfeited final: the surviving player is champion; no league points.
    tournament.champion = winnerId;
  } else if (fixture.stage === 'group') {
    const we = tournament.pointsTable[winnerId];
    const le = tournament.pointsTable[loserKey];
    if (we) {
      we.played += 1;
      we.won += 1;
      we.points += 2;
    }
    if (le) {
      le.played += 1;
      le.lost += 1;
    }
  }
  // semi: no points; the surviving player simply advances via fixture.result.

  tournament.liveScore = null;
  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));

  setTimeout(() => advanceTournament(io, rooms, tournament, matchIndex), advanceDelayMs);
}

// How long to wait for an absent human to (re)connect at the start of their
// match before forfeiting — covers a page refresh (socket id changes), a
// backgrounded mobile tab (socket drops while the OS freezes the page), or a
// network blip. On mobile the tab can't reconnect until the player returns to
// it, and the countdown runs the whole time they're away, so this needs to be
// generous (a quick glance at another app easily exceeds 10–15s). The match
// begins the instant both players are present, so this never delays a normal start.
const MATCH_START_GRACE_MS = 60000;
const MATCH_START_POLL_MS = 1500;

const playerSocket = (io: GameServer, p: TournamentPlayerEntry) =>
  isBot(p) ? undefined : io.sockets.sockets.get(p.id);

export function startTournamentMatch(
  io: GameServer,
  rooms: Map<string, Room>,
  tournament: Tournament,
  matchIndex: number
): void {
  if (matchIndex >= tournament.fixtures.length) {
    finalizeTournament(io, tournament);
    return;
  }

  tournament.currentMatchIndex = matchIndex;
  const fixture = tournament.fixtures[matchIndex];
  fixture.status = 'live';
  // Let the lobby reflect that this fixture is up while we wait for both players.
  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));

  // Give any absent human a grace window to (re)connect before forfeiting.
  awaitPlayersThenBegin(io, rooms, tournament, matchIndex, Date.now());
}

/**
 * Poll for both players to be present, then begin the match. If a human is still
 * missing after the grace window, forfeit. The moment both are present (e.g. a
 * refreshing player re-emitted join_tournament and got remapped), the match
 * starts — so a present opponent never waits longer than necessary.
 */
function awaitPlayersThenBegin(
  io: GameServer,
  rooms: Map<string, Room>,
  tournament: Tournament,
  matchIndex: number,
  since: number
): void {
  const fixture = tournament.fixtures[matchIndex];
  // Bail if the tournament moved on or this fixture was resolved elsewhere.
  if (
    tournament.phase !== 'in_progress' ||
    !fixture ||
    fixture.status !== 'live' ||
    tournament.currentMatchIndex !== matchIndex
  )
    return;

  const p1 = tournament.players[fixture.player1Idx];
  const p2 = tournament.players[fixture.player2Idx];
  const p1Present = isBot(p1) || !!playerSocket(io, p1);
  const p2Present = isBot(p2) || !!playerSocket(io, p2);

  if (p1Present && p2Present) {
    beginTournamentMatch(io, rooms, tournament, matchIndex);
    return;
  }
  if (Date.now() - since >= MATCH_START_GRACE_MS) {
    forfeitAbsentAtStart(io, rooms, tournament, matchIndex, !p1Present);
    return;
  }
  setTimeout(
    () => awaitPlayersThenBegin(io, rooms, tournament, matchIndex, since),
    MATCH_START_POLL_MS
  );
}

/** Grace elapsed with a human still missing — award the fixture to the present side. */
function forfeitAbsentAtStart(
  io: GameServer,
  rooms: Map<string, Room>,
  tournament: Tournament,
  matchIndex: number,
  p1Gone: boolean
): void {
  const fixture = tournament.fixtures[matchIndex];
  if (!fixture || fixture.status === 'done') return;
  const p1 = tournament.players[fixture.player1Idx];
  const p2 = tournament.players[fixture.player2Idx];
  fixture.status = 'done';
  fixture.result = p1Gone ? 'p2' : 'p1';
  const winnerId = p1Gone ? p2.id : p1.id;
  const loserId = p1Gone ? p1.id : p2.id;
  if (fixture.stage === 'final') {
    tournament.champion = winnerId;
  } else if (fixture.stage === 'group') {
    const we = tournament.pointsTable[winnerId];
    const le = tournament.pointsTable[loserId];
    if (we) {
      we.played += 1;
      we.won += 1;
      we.points += 2;
    }
    if (le) {
      le.played += 1;
      le.lost += 1;
    }
  }
  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
  setTimeout(() => advanceTournament(io, rooms, tournament, matchIndex), 1000);
}

/** Both players present — build the room and kick the match off. */
function beginTournamentMatch(
  io: GameServer,
  rooms: Map<string, Room>,
  tournament: Tournament,
  matchIndex: number
): void {
  const fixture = tournament.fixtures[matchIndex];
  const p1 = tournament.players[fixture.player1Idx];
  const p2 = tournament.players[fixture.player2Idx];
  const p1Socket = playerSocket(io, p1);
  const p2Socket = playerSocket(io, p2);

  const roomId = makeRoomId(rooms);
  const room = createRoom(tournament.overs, tournament.wickets);
  // Carry clientId through so a guest (no userId) whose socket id changes on a
  // blip can still be matched by rejoin_room; without it their reconnect fails
  // and the grace timer forfeits the match.
  room.players.push({ id: p1.id, name: p1.name, userId: p1.userId, clientId: p1.clientId, isBot: p1.isBot, botStyle: p1.botStyle });
  room.players.push({ id: p2.id, name: p2.name, userId: p2.userId, clientId: p2.clientId, isBot: p2.isBot, botStyle: p2.botStyle });
  room.hasBot = isBot(p1) || isBot(p2);
  room.tournamentId = tournament.code;
  room.tournamentMatchIdx = matchIndex;
  // Qualification stakes (group matches only) — bots fold this into their play.
  room.qualStakes = groupStakesFor(tournament, fixture);
  rooms.set(roomId, room);
  fixture.roomId = roomId;

  // Only real sockets join the match room / get the start event; bots need neither.
  if (p1Socket) {
    p1Socket.join(roomId);
    p1Socket.data.roomId = roomId;
    p1Socket.emit('tournament_match_starting', {
      roomId,
      opponentName: p2.name,
      matchNum: fixture.matchNum,
      myPlayerIdx: 0,
      isFinal: fixture.isFinal,
    });
  }
  if (p2Socket) {
    p2Socket.join(roomId);
    p2Socket.data.roomId = roomId;
    p2Socket.emit('tournament_match_starting', {
      roomId,
      opponentName: p1.name,
      matchNum: fixture.matchNum,
      myPlayerIdx: 1,
      isFinal: fixture.isFinal,
    });
  }

  const callerIdx = Math.floor(Math.random() * 2);
  room.tossCallerId = room.players[callerIdx].id;
  room.phase = 'toss_call';

  io.to(roomId).emit('state', publicState(room, roomId));
  io.to(roomId).emit('toss_start', {
    callerId: room.tossCallerId,
    callerName: room.players[callerIdx].name,
  });

  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));

  // For a FINAL between a human and a bot, hold the bot until the human taps
  // "Start the Final" (the GRAND FINALE intro), so the bot doesn't play the
  // toss while the human is still on the splash. A fallback timer starts it
  // anyway if the human never signals (refresh, disconnect, etc.).
  const oneBot = isBot(p1) !== isBot(p2); // exactly one finalist is a bot
  if (fixture.isFinal && oneBot) {
    room.finalAwaiting = new Set([p1, p2].filter((p) => !isBot(p)).map((p) => p.id));
    room._finalStartTimer = setTimeout(() => {
      if (rooms.get(roomId) === room && room.finalAwaiting) {
        room.finalAwaiting = undefined;
        driveBots(io, roomId, room, rooms);
      }
    }, 8000);
  } else if (tournament.isBotLeague) {
    // All-bot match: hold it for the pre-match betting window so spectators can
    // bet on this match before its first ball, then start play.
    liveBidsPreMatch(tournament, PRE_MATCH_WINDOW_MS);
    room._finalStartTimer = setTimeout(() => {
      if (rooms.get(roomId) === room) driveBots(io, roomId, room, rooms);
    }, PRE_MATCH_WINDOW_MS);
  } else {
    // Human-vs-human or bot-vs-bot non-league match: start normally.
    driveBots(io, roomId, room, rooms);
  }
}

// ─── Bot league ───────────────────────────────────────────────────────────────

/** How long bidding stays open before a started bot league actually plays. */
const BOT_LEAGUE_BID_WINDOW_MS = 5 * 60_000;

/** Pre-match betting window: each bot-league match is held this long before its
 *  first ball so spectators can place match bids on it. */
const PRE_MATCH_WINDOW_MS = 30_000;

/**
 * Launch an admin-triggered all-bot league for a format (5 or 10 overs): field
 * the current top-8 ranked bots into an 8-team tournament. The teams are decided
 * up front and the league sits in a 5-minute BIDDING window before any match is
 * played; when the window closes it runs itself (no human host). Returns the new
 * tournament, or null if one for this format is already running / not enough bots.
 */
export function startBotLeague(
  io: GameServer,
  rooms: Map<string, Room>,
  format: number,
  superLeague = false
): Tournament | null {
  // The Super League is always 10/10 and fields all 12 bots.
  const fmt = superLeague ? 10 : Number(format) === 10 ? 10 : 5;
  const need = superLeague ? 12 : 8;
  // Only one live bot event per format at a time (incl. the bidding window). A
  // Super League and a regular league are both 10-over events, so this also keeps
  // them from clashing on the 10-over rankings.
  for (const t of tournaments.values())
    if (t.isBotLeague && t.format === fmt && t.phase !== 'complete') return null;

  const ranked = getBotRankings(fmt).slice(0, need); // current top `need` by rating
  if (ranked.length < need) return null;

  const tournament: Tournament = {
    id: randomUUID(),
    code: makeRoomId(tournaments),
    overs: fmt,
    wickets: fmt,
    size: need,
    groups: [],
    players: ranked.map((r) => makeBotPlayerNamed(r.botName)),
    phase: 'waiting', // bidding window — no matches yet
    fixtures: [],
    currentMatchIndex: 0,
    pointsTable: {},
    liveScore: null,
    isBotLeague: true,
    isSuperLeague: superLeague || undefined,
    format: fmt,
    bidsCloseAt: Date.now() + BOT_LEAGUE_BID_WINDOW_MS,
  };
  tournaments.set(tournament.code, tournament);
  generateFixture(tournament); // teams + groups known up front, so spectators can bid
  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));

  // After the bidding window, kick the matches off.
  setTimeout(() => {
    if (tournaments.get(tournament.code) !== tournament || tournament.phase !== 'waiting') return;
    tournament.phase = 'in_progress';
    io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
    liveBidsStart(io, tournament); // start live in-play prediction markets for spectators
    startTournamentMatch(io, rooms, tournament, 0);
  }, BOT_LEAGUE_BID_WINDOW_MS);

  return tournament;
}

/**
 * Launch the 5-over Qualifying Playoffs: the BOTTOM 6 ranked 5-over bots (positions
 * 7–12) play a single round-robin. It's a real bot-league event (so every match moves
 * Elo normally), but with no knockouts and no title — its sole purpose is to give the
 * lower-ranked bots games so they can climb, instead of being stuck just outside the
 * top 8 forever. Returns the tournament, or null if a 5-over event is already running
 * or there aren't 12 ranked bots to take a bottom 6 from.
 */
export function startBotQualifier(io: GameServer, rooms: Map<string, Room>): Tournament | null {
  const fmt = 5;
  // One live 5-over bot event at a time (shares the guard with the regular league).
  for (const t of tournaments.values())
    if (t.isBotLeague && t.format === fmt && t.phase !== 'complete') return null;

  const all = getBotRankings(fmt);
  if (all.length < 12) return null;
  const bottom6 = all.slice(6, 12); // positions 7–12

  const tournament: Tournament = {
    id: randomUUID(),
    code: makeRoomId(tournaments),
    overs: fmt,
    wickets: fmt,
    size: 6,
    groups: [],
    players: bottom6.map((r) => makeBotPlayerNamed(r.botName)),
    phase: 'waiting',
    fixtures: [],
    currentMatchIndex: 0,
    pointsTable: {},
    liveScore: null,
    isBotLeague: true,
    isQualifier: true,
    format: fmt,
    bidsCloseAt: Date.now() + BOT_LEAGUE_BID_WINDOW_MS,
  };
  tournaments.set(tournament.code, tournament);
  generateFixture(tournament);
  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));

  setTimeout(() => {
    if (tournaments.get(tournament.code) !== tournament || tournament.phase !== 'waiting') return;
    tournament.phase = 'in_progress';
    io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
    liveBidsStart(io, tournament);
    startTournamentMatch(io, rooms, tournament, 0);
  }, BOT_LEAGUE_BID_WINDOW_MS);

  return tournament;
}

type ActiveBotLeague = {
  id: string;
  format: number;
  state: TournamentState;
  myBid: string | null;
  bidsCloseAt: number | null;
};

/** Live + bidding-window bot leagues, as spectator summaries (incl. the viewer's bid). */
export function activeBotLeagues(userId?: string | null): ActiveBotLeague[] {
  const out: ActiveBotLeague[] = [];
  for (const t of tournaments.values())
    if (t.isBotLeague && t.phase !== 'complete')
      out.push({
        id: t.id,
        format: t.format ?? t.overs,
        state: publicTournamentState(t),
        myBid: (userId && t.bids?.[userId]) || null,
        bidsCloseAt: t.bidsCloseAt ?? null,
      });
  return out;
}

/**
 * Place (or confirm) a spectator's bid on a bot to win a league. Only allowed
 * during the pre-match bidding window (phase 'waiting'); one bid per user per
 * league, locked in once set. Returns the backed bot, or null if not allowed.
 */
export function placeBotLeagueBid(
  userId: string,
  tournamentId: string,
  botName: string
): string | null {
  const t = [...tournaments.values()].find((x) => x.id === tournamentId);
  if (!t || !t.isBotLeague || t.phase !== 'waiting') return null; // window closed / not a league
  if (!t.players.some((p) => p.name === botName)) return null; // not a participant
  t.bids ??= {};
  if (t.bids[userId]) return t.bids[userId]; // already bid — locked in
  t.bids[userId] = botName;
  return botName;
}

/**
 * Recently-completed bot leagues still held in memory (finalized tournaments are
 * reaped after a grace window). Lets the client show the final standings and the
 * champion's name after a league ends, instead of it vanishing instantly.
 */
export function recentBotLeagues(): { id: string; format: number; state: TournamentState }[] {
  const out: { id: string; format: number; state: TournamentState }[] = [];
  for (const t of tournaments.values())
    if (t.isBotLeague && t.phase === 'complete')
      out.push({ id: t.id, format: t.format ?? t.overs, state: publicTournamentState(t) });
  return out;
}

/**
 * Admin abort of a running bot league: drop it from the map and kill its live
 * match room so the bots stop mid-over. Setting phase to 'complete' makes every
 * pending timer (bidding window, match scheduling, advance) bail. Nothing is
 * recorded (it didn't finish), so history/current-champions are untouched; Elo
 * from matches already completed stays as-is.
 */
export function stopBotLeague(io: GameServer, rooms: Map<string, Room>, t: Tournament): void {
  t.phase = 'complete';
  liveBidsStop(t); // drop live-bid markets without paying out
  tournaments.delete(t.code);
  for (const [roomId, room] of rooms) if (room.tournamentId === t.code) rooms.delete(roomId);
  t.liveScore = null;
  io.to('t:' + t.id).emit('bot_league_stopped', { id: t.id });
}

/** Snapshot of every active tournament (bot + human) for the admin dashboard. */
export function adminTournaments(): import('@cric/types').AdminTournament[] {
  const out: import('@cric/types').AdminTournament[] = [];
  for (const t of tournaments.values()) {
    if (t.phase === 'complete') continue;
    const done = t.fixtures.filter((f) => f.status === 'done').length;
    out.push({
      code: t.code,
      kind: t.isSuperLeague ? 'super-league' : t.isBotLeague ? 'bot-league' : 'human',
      format: t.format ?? null,
      size: t.size,
      phase: t.phase,
      players: t.players.map((p) => p.name),
      progress:
        t.phase === 'waiting'
          ? `${t.players.length}/${t.size} joined`
          : `${done}/${t.fixtures.length} matches`,
    });
  }
  return out;
}

// ─── Socket handlers ──────────────────────────────────────────────────────────

export function registerTournamentHandlers(io: GameServer, rooms: Map<string, Room>): void {
  io.on('connection', (socket) => {
    socket.on('create_tournament', ({ playerName, overs, wickets, size }) => {
      const ov = clampCount(overs, 2);
      const sz = size === 8 ? 8 : 4;
      // Economy gates: longer formats and the 8-player bracket must be unlocked.
      const fmtItem = overUnlockId(ov);
      if (fmtItem && !hasUnlock(socket.data.userId, fmtItem))
        return socket.emit('error', { message: `Unlock the ${ov}-over format in the Store first.` });
      if (sz === 8 && !hasUnlock(socket.data.userId, 'tourney8'))
        return socket.emit('error', { message: 'Unlock 8-player tournaments in the Store first.' });

      // Reap a waiting lobby this socket abandoned (created one, went back, then
      // created another). Left behind, it lingers in the map with the same host
      // socket.id and shadows lookups for the new tournament. Only drop a solo
      // lobby — never one others have already joined.
      for (const [oldCode, t] of tournaments) {
        if (t.phase === 'waiting' && t.players.length === 1 && t.players[0]?.id === socket.id)
          tournaments.delete(oldCode);
      }
      const code = makeRoomId(tournaments);
      const tournamentId = randomUUID();
      const tournament: Tournament = {
        id: tournamentId,
        code,
        overs: ov,
        wickets: clampCount(wickets, 2),
        size: sz, // only 4 or 8 supported
        groups: [],
        players: [
          {
            id: socket.id,
            name: cleanName(playerName),
            userId: socket.data.userId,
            clientId: socket.data.clientId,
          },
        ],
        phase: 'waiting',
        fixtures: [],
        currentMatchIndex: 0,
        pointsTable: {},
        liveScore: null,
      };
      tournaments.set(code, tournament);
      socket.join('t:' + tournamentId);
      socket.data.tournamentId = tournamentId;
      socket.emit('tournament_created', publicTournamentState(tournament));
    });

    socket.on('join_tournament', ({ code, playerName }) => {
      const tournament = tournaments.get(code.toUpperCase());
      if (!tournament) return socket.emit('error', { message: 'Tournament not found.' });

      // Already in tournament with same socket (no-op)
      if (tournament.players.some((p) => p.id === socket.id)) return;

      // Reconnection: a logged-in player whose socket.id changed (refresh, or a
      // between-match / spectator network blip). This MUST run before the
      // phase guard below — otherwise an in-progress tournament rejects the
      // rejoin and the player's dead socket id is never remapped, so their
      // upcoming fixtures forfeit when startTournamentMatch can't find them.
      const reconnIdx = tournament.players.findIndex(
        (p) =>
          (socket.data.userId !== null && p.userId === socket.data.userId) ||
          (socket.data.clientId !== null && p.clientId === socket.data.clientId)
      );

      if (reconnIdx !== -1) {
        remapTournamentSocketId(tournament, tournament.players[reconnIdx].id, socket.id);
        socket.join('t:' + tournament.id);
        socket.data.tournamentId = tournament.id;
        // Use tournament_created so the client transitions to tournament_lobby phase
        socket.emit('tournament_created', publicTournamentState(tournament));
        io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
        return;
      }

      // New joiner — only allowed while the tournament is still gathering players.
      if (tournament.phase !== 'waiting')
        return socket.emit('error', { message: 'Tournament already started.' });

      if (tournament.players.length >= tournament.size)
        return socket.emit('error', { message: 'Tournament is full.' });

      tournament.players.push({
        id: socket.id,
        name: cleanName(playerName),
        userId: socket.data.userId,
        clientId: socket.data.clientId,
      });
      socket.join('t:' + tournament.id);
      socket.data.tournamentId = tournament.id;

      // Use tournament_created so the joining socket transitions to tournament_lobby phase;
      // tournament_state alone doesn't trigger the phase change on the client.
      socket.emit('tournament_created', publicTournamentState(tournament));
      io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));

      if (tournament.players.length === tournament.size) {
        generateFixture(tournament);
        tournament.phase = 'in_progress';
        io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
        startTournamentMatch(io, rooms, tournament, 0);
      }
    });

    socket.on('start_tournament_with_bots', () => {
      // Target the tournament THIS socket is currently in (set on create/join),
      // not a scan by players[0].id: a just-finished tournament lingers in the
      // map with the same host socket.id and would shadow the new one, leaving
      // the lobby stuck (only a refresh — which changes socket.id — recovered it).
      const tournament = [...tournaments.values()].find((t) => t.id === socket.data.tournamentId);
      if (!tournament || tournament.phase !== 'waiting') return;
      if (tournament.players[0]?.id !== socket.id) return; // only the host may start
      if (tournament.players.length < 1 || tournament.players.length >= tournament.size) return;

      // Fill the remaining seats with uniquely-named bots (personality fixed by name).
      while (tournament.players.length < tournament.size) {
        const taken = tournament.players.map((p) => p.name);
        tournament.players.push(makeBotPlayer(taken));
      }

      generateFixture(tournament);
      tournament.phase = 'in_progress';
      io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
      startTournamentMatch(io, rooms, tournament, 0);
    });

    // Admin-only: kick off an all-bot league for a format (top-8 ranked bots).
    socket.on('start_bot_league', ({ format }) => {
      const adminName = process.env.ADMIN_USERNAME;
      const uid = socket.data.userId;
      const user = uid ? findById(uid) : null;
      if (!adminName || !user || user.username !== adminName)
        return socket.emit('error', { message: 'Not authorized to start a bot league.' });

      const fmt = Number(format) === 10 ? 10 : 5;
      const tournament = startBotLeague(io, rooms, fmt);
      if (!tournament)
        return socket.emit('error', { message: `A ${fmt}-over bot league is already running.` });
      socket.emit('bot_league_started', { id: tournament.id, format: fmt });
    });

    // Admin-only: kick off the 12-bot Super League (all bots, 10/10, two groups
    // of 6 → quarters → semis → final). Reuses the bot-league machinery.
    socket.on('start_bot_super_league', () => {
      const adminName = process.env.ADMIN_USERNAME;
      const uid = socket.data.userId;
      const user = uid ? findById(uid) : null;
      if (!adminName || !user || user.username !== adminName)
        return socket.emit('error', { message: 'Not authorized to start the Super League.' });

      const tournament = startBotLeague(io, rooms, 10, true);
      if (!tournament)
        return socket.emit('error', {
          message: 'A 10-over bot event is already running — finish it first.',
        });
      socket.emit('bot_league_started', { id: tournament.id, format: 10 });
    });

    // Admin-only: kick off the 5-over Qualifying Playoffs (bottom-6 round-robin, no
    // knockouts) so the lower bots earn games + rating movement.
    socket.on('start_bot_qualifier', () => {
      const adminName = process.env.ADMIN_USERNAME;
      const uid = socket.data.userId;
      const user = uid ? findById(uid) : null;
      if (!adminName || !user || user.username !== adminName)
        return socket.emit('error', { message: 'Not authorized to start the Qualifier.' });

      const tournament = startBotQualifier(io, rooms);
      if (!tournament)
        return socket.emit('error', {
          message: 'A 5-over bot event is already running — finish it first.',
        });
      socket.emit('bot_league_started', { id: tournament.id, format: 5 });
    });

    // Admin-only: wipe all bot rankings back to base (recover from an interrupted
    // league). Refused while any league is live so a reset can't race live writes.
    socket.on('reset_bot_rankings', () => {
      const adminName = process.env.ADMIN_USERNAME;
      const uid = socket.data.userId;
      const user = uid ? findById(uid) : null;
      if (!adminName || !user || user.username !== adminName)
        return socket.emit('error', { message: 'Not authorized to reset bot rankings.' });
      if (activeBotLeagues().length > 0)
        return socket.emit('error', {
          message: 'Finish or wait for the live league before resetting.',
        });
      resetBotRankings();
      socket.emit('bot_rankings_reset');
    });

    // Admin-only: abort a running bot league (by id, else all running ones). Drops
    // it without recording a result — for killing a league that shouldn't finish.
    socket.on('stop_bot_league', ({ id } = {}) => {
      const adminName = process.env.ADMIN_USERNAME;
      const uid = socket.data.userId;
      const user = uid ? findById(uid) : null;
      if (!adminName || !user || user.username !== adminName)
        return socket.emit('error', { message: 'Not authorized to stop a bot league.' });

      const targets = [...tournaments.values()].filter(
        (t) => t.isBotLeague && t.phase !== 'complete' && (!id || t.id === id)
      );
      if (targets.length === 0)
        return socket.emit('error', { message: 'No running bot league to stop.' });
      for (const t of targets) stopBotLeague(io, rooms, t);
      socket.emit('bot_league_stopped', { id: id ?? null });
    });

    // Spectating a bot tournament → join its SPECTATOR-ONLY room (`spec:<id>`),
    // separate from the players' room (`t:<id>`). This is the key isolation: a
    // spectator must NOT receive participant `tournament_state` events (App.tsx
    // reacts to those and would freeze the poll-driven spectate view). Live-bid
    // offers are broadcast to `spec:<id>` only.
    socket.on('watch_tournament', ({ id }) => {
      if (typeof id === 'string') socket.join('spec:' + id);
    });
    socket.on('unwatch_tournament', ({ id }) => {
      if (typeof id === 'string') socket.leave('spec:' + id);
    });

    // Pick an option on the currently-open live in-play market (must be logged in).
    socket.on('place_live_bid', ({ id, optionId }) => {
      if (!socket.data.userId) return;
      if (typeof id !== 'string' || typeof optionId !== 'string') return;
      const locked = placeLiveBid(socket.data.userId, socket.id, id, optionId);
      if (locked) socket.emit('live_bid_locked', locked);
    });

    // Back a bot to win an in-progress league. Free, one pick per league; pays
    // out coins at finalize if the backed bot is champion.
    socket.on('place_bid', ({ tournamentId, botName }) => {
      if (!socket.data.userId) return socket.emit('error', { message: 'Log in to place a bid.' });
      if (typeof botName !== 'string' || typeof tournamentId !== 'string') return;
      const backed = placeBotLeagueBid(socket.data.userId, tournamentId, botName);
      if (!backed) return socket.emit('error', { message: 'Could not place that bid.' });
      socket.emit('bid_placed', { tournamentId, botName: backed });
    });
  });
}
