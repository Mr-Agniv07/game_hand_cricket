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
import type { SocketData } from '../game/types.ts';
import {
  incrementAchievements,
  getBotRankings,
  recordBotTrophy,
  recordBotTournament,
  resetBotRankings,
  findById,
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
  stage: 'group' | 'semi' | 'final';
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
  /** 4 (single group) or 8 (two groups). */
  size: number;
  /** Player-index arrays per group. One group for 4 players, two for 8. */
  groups: number[][];
  players: TournamentPlayerEntry[];
  phase: 'waiting' | 'in_progress' | 'complete';
  fixtures: InternalFixtureMatch[];
  currentMatchIndex: number;
  pointsTable: Record<string, InternalPointsEntry>;
  liveScore: LiveMatchScore | null;
  /** True once the semifinals have been appended (8-player only). */
  semisCreated?: boolean;
  /** True once the playoff final has been appended to fixtures. */
  finalCreated?: boolean;
  /** Final winner's player id (set when the final is decided). */
  champion?: string | null;
  /** Batting awards, computed at finalize. */
  awards?: TournamentAwards | null;
  /** True for an admin-launched all-bot league (feeds the global bot rankings). */
  isBotLeague?: boolean;
  /** Ranked format (5 or 10 overs) — only set for bot-league tournaments. */
  format?: number;
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
 * Append the final. For 8 players it's the two semi winners; for 4 it's the top
 * two of the single group (player1 = higher seed, so a tied final goes to them).
 * The final does NOT count toward the league points table.
 */
function setupFinal(io: GameServer, t: Tournament): void {
  t.finalCreated = true;
  let p1: number;
  let p2: number;
  if (t.size === 8) {
    const semis = t.fixtures.filter((f) => f.stage === 'semi');
    p1 = fixtureWinnerIdx(semis[0]);
    p2 = fixtureWinnerIdx(semis[1]);
  } else {
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
  // All currently-scheduled fixtures are done — open the next stage.
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

  if (tournament.size === 8) {
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
  // Defensive: if we somehow finalized without a recorded champion, fall back to
  // the league topper so the result screen always has a winner.
  if (!tournament.champion) {
    const topIdx = rankedPlayerIndices(tournament)[0];
    tournament.champion = tournament.players[topIdx]?.id ?? null;
  }
  tournament.awards = computeAwards(tournament);
  recordTournamentAchievements(tournament);
  // Bot league: credit the champion a trophy and save a durable history record
  // (champion, runner-up, final standings) so past winners survive restarts.
  if (tournament.isBotLeague && tournament.format && tournament.champion) {
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
  advanceDelayMs = 4000
): void {
  const fixture = tournament.fixtures[matchIndex];
  if (!fixture || fixture.status === 'done') return;

  fixture.status = 'done';
  const p1Id = tournament.players[fixture.player1Idx].id;
  const p2Id = tournament.players[fixture.player2Idx].id;
  const p1Lost = p1Id === loserId;
  fixture.result = p1Lost ? 'p2' : 'p1';
  const winnerId = p1Lost ? p2Id : p1Id;

  if (fixture.stage === 'final') {
    // A forfeited final: the surviving player is champion; no league points.
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
  } else {
    // Bot-vs-bot final, human-vs-human, or any regular match: start normally.
    driveBots(io, roomId, room, rooms);
  }
}

// ─── Bot league ───────────────────────────────────────────────────────────────

/**
 * Launch an admin-triggered all-bot league for a format (5 or 10 overs): field
 * the current top-8 ranked bots into an 8-team tournament that runs itself (no
 * human host). Spectators watch via the polled public state. Returns the new
 * tournament, or null if one for this format is already running / not enough bots.
 */
export function startBotLeague(
  io: GameServer,
  rooms: Map<string, Room>,
  format: number
): Tournament | null {
  const fmt = Number(format) === 10 ? 10 : 5;
  // Only one live league per format at a time.
  for (const t of tournaments.values())
    if (t.isBotLeague && t.format === fmt && t.phase !== 'complete') return null;

  const top8 = getBotRankings(fmt).slice(0, 8); // current top 8 by rating
  if (top8.length < 8) return null;

  const tournament: Tournament = {
    id: randomUUID(),
    code: makeRoomId(tournaments),
    overs: fmt,
    wickets: fmt,
    size: 8,
    groups: [],
    players: top8.map((r) => makeBotPlayerNamed(r.botName)),
    phase: 'in_progress',
    fixtures: [],
    currentMatchIndex: 0,
    pointsTable: {},
    liveScore: null,
    isBotLeague: true,
    format: fmt,
  };
  tournaments.set(tournament.code, tournament);
  generateFixture(tournament);
  io.to('t:' + tournament.id).emit('tournament_state', publicTournamentState(tournament));
  startTournamentMatch(io, rooms, tournament, 0);
  return tournament;
}

/** In-progress bot leagues, as lightweight spectator summaries. */
export function activeBotLeagues(): { id: string; format: number; state: TournamentState }[] {
  const out: { id: string; format: number; state: TournamentState }[] = [];
  for (const t of tournaments.values())
    if (t.isBotLeague && t.phase !== 'complete')
      out.push({ id: t.id, format: t.format ?? t.overs, state: publicTournamentState(t) });
  return out;
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

// ─── Socket handlers ──────────────────────────────────────────────────────────

export function registerTournamentHandlers(io: GameServer, rooms: Map<string, Room>): void {
  io.on('connection', (socket) => {
    socket.on('create_tournament', ({ playerName, overs, wickets, size }) => {
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
        overs: clampCount(overs, 2),
        wickets: clampCount(wickets, 2),
        size: size === 8 ? 8 : 4, // only 4 or 8 supported
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
  });
}
