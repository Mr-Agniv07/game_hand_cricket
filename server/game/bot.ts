import { randomUUID } from 'crypto';
import { totalBalls, type Room, type RoomPlayer } from './room.ts';
import { predict as predictHuman, isReady as humanModelReady, phaseOf, type Role } from './opponentModel.ts';

// ─── Identity ────────────────────────────────────────────────────────────────

export const BOT_NAMES = [
  'Botinho',
  'Sir Bot-a-lot',
  'RoboHitter',
  'Bot Kohli',
  'Captain Circuit',
  'Glitch Gabbar',
  'Auto Sachin',
  'Pixel Pacer',
  'MS Droid',
  'Wall-E Willow',
  'Binary Bumrah',
  'Turbo Tendulkar',
];

/** A bot's id is namespaced so it can never collide with a real socket id. */
export function makeBotId(): string {
  return `bot:${randomUUID()}`;
}

export function isBot(p: RoomPlayer | { isBot?: boolean }): boolean {
  return !!p.isBot;
}

/**
 * True if `name` belongs to the bot roster (case-insensitive). Lets other modules
 * (e.g. head-to-head stats) tag a bot opponent by the name stored in match
 * history, without exposing which hidden personality it plays.
 */
export function isBotName(name: string): boolean {
  return BOT_NAMES.some((n) => n.toLowerCase() === name.toLowerCase());
}

/** Pick a bot name not already used by `taken` (case-insensitive). */
export function randomBotName(taken: string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const free = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
  const pool = free.length ? free : BOT_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Personalities ─────────────────────────────────────────────────────────
//
// A bot's behaviour is defined purely by a set of personality parameters; the
// decision algorithm (pickBotMove) is shared by all of them. This keeps the
// "what it does" cleanly separate from the "who it is", so styles are easy to
// tune. There are fewer styles than bot names, so two bots can share a style.
//
//   aggression    — batting: lean toward big numbers (4/5/6);
//                   bowling: how hard it commits to the wicket ball.
//   adaptability  — how strongly it reads & acts on the opponent's habits.
//   volatility    — how much pure randomness it injects (unpredictability).
//   riskTolerance — willingness to risk the dismissal (low = plays it safe).
//   situationalIq — how much the match state (chase / required rate / wickets)
//                   reshapes its aggression.
//   memory        — how quickly and deeply it builds a read on the opponent.
//   chaos         — periodically reinvents its own sub-style mid-innings.
//   situational   — aggression is driven entirely by the match state.

interface Personality {
  aggression: number;
  adaptability: number;
  volatility: number;
  riskTolerance: number;
  situationalIq: number;
  memory: number;
  chaos?: boolean;
  situational?: boolean;
}

const PERSONALITIES: Record<string, Personality> = {
  // 🔥 Attacks constantly, hunts wickets, barely cares about getting out.
  Aggressor: { aggression: 0.95, adaptability: 0.4, volatility: 0.45, riskTolerance: 0.95, situationalIq: 0.5, memory: 0.3 },
  // 🎲 Big risks, big rewards — streaky and wildly unpredictable.
  Gambler: { aggression: 0.7, adaptability: 0.3, volatility: 0.95, riskTolerance: 1.0, situationalIq: 0.4, memory: 0.2 },
  // ⚖️ Balanced across everything — the "default human".
  'All-Rounder': { aggression: 0.5, adaptability: 0.5, volatility: 0.45, riskTolerance: 0.5, situationalIq: 0.55, memory: 0.5 },
  // 🌀 No plan, no pattern — reinvents itself every few balls.
  Chaos: { aggression: 0.55, adaptability: 0.2, volatility: 1.0, riskTolerance: 0.7, situationalIq: 0.2, memory: 0.1, chaos: true },
  // 🎯 Plays against YOU — obsessed with learning and countering your habits.
  Hunter: { aggression: 0.6, adaptability: 0.95, volatility: 0.25, riskTolerance: 0.55, situationalIq: 0.7, memory: 1.0 },
  // 🧠 The scoreboard decides everything — cold, calculated, situational.
  Strategist: { aggression: 0.5, adaptability: 0.9, volatility: 0.2, riskTolerance: 0.5, situationalIq: 1.0, memory: 0.8, situational: true },
  // 🧱 Lives at 1/2/3 — survival first, miserable to dislodge. Now reads the
  //    match a bit sharper (higher situationalIq) so it lifts the tempo when a
  //    chase demands it, without abandoning its low-risk core.
  Wall: { aggression: 0.25, adaptability: 0.45, volatility: 0.12, riskTolerance: 0.12, situationalIq: 0.9, memory: 0.8 },
  // 🛡️ Doesn't make mistakes — consistent, disciplined, low variance. Tuned to
  //    think more strategically (higher situationalIq) while staying patient.
  Guardian: { aggression: 0.35, adaptability: 0.6, volatility: 0.12, riskTolerance: 0.22, situationalIq: 0.92, memory: 0.7 },
};
const STYLE_LABELS = Object.keys(PERSONALITIES);

// Every roster bot is pinned to ONE fixed personality here. This is the permanent,
// authoritative mapping — it freezes the current pairing so it can NEVER reshuffle,
// even if the PERSONALITIES set is later renamed, reordered, added to or removed
// from (any of which would change the name-hash). Do not edit these assignments:
// the whole point is that a given bot always plays the same way, forever.
const STYLE_OVERRIDES: Record<string, string> = {
  Botinho: 'Chaos',
  'Sir Bot-a-lot': 'Chaos',
  RoboHitter: 'Aggressor',
  'Bot Kohli': 'Aggressor',
  'Captain Circuit': 'Strategist',
  'Glitch Gabbar': 'Wall',
  'Auto Sachin': 'Gambler',
  'Pixel Pacer': 'Strategist',
  'MS Droid': 'All-Rounder',
  'Wall-E Willow': 'Guardian',
  'Binary Bumrah': 'Wall',
  'Turbo Tendulkar': 'Hunter',
};

/**
 * The bot's fixed personality. Roster bots are pinned in STYLE_OVERRIDES (the
 * permanent mapping); any other name (shouldn't happen) falls back to a stable
 * name-hash so it's still deterministic.
 */
function styleForName(name: string): string {
  const pinned = STYLE_OVERRIDES[name];
  if (pinned) return pinned;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return STYLE_LABELS[h % STYLE_LABELS.length];
}

/** Build a fresh bot RoomPlayer; its personality is fixed by its name. */
export function makeBotPlayer(takenNames: string[]): RoomPlayer {
  const name = randomBotName(takenNames);
  return { id: makeBotId(), name, userId: null, isBot: true, botStyle: styleForName(name) };
}

/**
 * Build a bot RoomPlayer with a SPECIFIC roster name (its personality follows
 * from the name). Used by the bot league, which fields named bots by ranking
 * rather than picking randomly.
 */
export function makeBotPlayerNamed(name: string): RoomPlayer {
  return { id: makeBotId(), name, userId: null, isBot: true, botStyle: styleForName(name) };
}

// ─── Decision algorithm (shared by every personality) ────────────────────────

const rnd = (): number => 1 + Math.floor(Math.random() * 6);
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const clampSigned = (x: number): number => Math.max(-1, Math.min(1, x));

type Brain = NonNullable<Room['botBrain']>[number];
function brainFor(room: Room, idx: number): Brain {
  room.botBrain ??= {};
  return (room.botBrain[idx] ??= { recent: [], momentum: 0, ballsSeen: 0, mode: null });
}

/** Aggression implied purely by the match state (the Strategist's whole game). */
function situationalAggression(room: Room, isBowling: boolean): number {
  const inn = room.innings[room.currentInnings];
  if (room.currentInnings === 1) {
    const need = room.innings[0].score + 1 - inn.score;
    const ballsLeft = totalBalls(room) - inn.balls;
    if (isBowling) return need <= 8 ? 0.9 : 0.55; // defend hard at the death
    if (ballsLeft <= 0) return 0.6;
    return Math.max(0.2, Math.min(0.95, need / ballsLeft / 4)); // chase the required rate
  }
  return isBowling ? 0.55 : 0.6; // first innings: steady, slightly positive
}

/**
 * Pick a batting number: a boundary-lean from `aggression`, strongly avoiding
 * the bowler's predicted `avoid` number, and softly avoiding the bot's own last
 * move (so a reader can't pin it down). `antiRepeat` scales that self-variation.
 */
function weightedBat(aggression: number, avoid: number | null, recent: number[], antiRepeat: number): number {
  const lastOwn = recent.length ? recent[recent.length - 1] : 0;
  const weights: number[] = [];
  for (let i = 1; i <= 6; i++) {
    let w = 1 + (aggression - 0.5) * 1.7 * ((i - 3.5) / 2.5);
    w = Math.max(0.05, w);
    if (i === avoid) w *= 0.12;
    if (i === lastOwn) w *= 1 - antiRepeat * 0.45;
    weights.push(w);
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < 6; i++) {
    r -= weights[i];
    if (r <= 0) return i + 1;
  }
  return 6;
}

function argmax(counts: number[]): number {
  let hot = 1;
  let max = -1;
  for (let i = 1; i <= 6; i++) {
    if (counts[i] > max) {
      max = counts[i];
      hot = i;
    }
  }
  return hot;
}

/**
 * The opponent's most likely next number — null until there's enough to go on.
 *
 * Against a HUMAN we start from the trained global model (a smart prior, good
 * from ball one) and blend in the live in-match count, which takes over as the
 * match's own data accumulates. Against a BOT (tournaments/sims) there's no
 * human prior, so we fall back to the original live-count read unchanged.
 * `memory` makes sharper bots act on fewer samples and trust the live read sooner.
 */
function readOpponent(room: Room, oppIdx: number, isBowling: boolean, memory: number): number | null {
  const counts = room.botMoveCounts?.[oppIdx];
  let liveTotal = 0;
  if (counts) for (let i = 1; i <= 6; i++) liveTotal += counts[i];

  // Trained prior — only meaningful when the opponent is a human. This is the
  // only "extra" step on top of the core personality logic, so guard it alone:
  // if the model ever fails, the bot degrades to its normal live read (still its
  // intended personality move) rather than breaking the whole decision.
  let prior: number[] | null = null;
  if (humanModelReady() && !room.players[oppIdx]?.isBot) {
    try {
      const oppRole: Role = isBowling ? 'bat' : 'bowl'; // what the opponent is doing
      const innings = room.currentInnings + 1;
      const phase = phaseOf(room.innings[room.currentInnings].balls, totalBalls(room));
      const prevMove = room.mlLastMoves?.[oppIdx] ?? null;
      prior = predictHuman(oppRole, innings, phase, prevMove);
    } catch (err) {
      console.error('[bot] human-model prediction failed — using live read only:', err);
      prior = null;
    }
  }

  // No prior (bot opponent, or model still cold): original live-count read.
  if (!prior) {
    const threshold = Math.max(2, Math.round(5 - memory * 3));
    return counts && liveTotal >= threshold ? argmax(counts) : null;
  }

  // Hybrid: blend prior with the live count; the live read's weight grows with
  // in-match samples (sharper memory → it takes over faster).
  const priorStrength = 8 - memory * 4; // memory 1 → 4 balls, memory 0 → 8 balls
  const liveW = liveTotal / (liveTotal + priorStrength);
  let hot = 1;
  let max = -1;
  for (let i = 1; i <= 6; i++) {
    const live = liveTotal && counts ? counts[i] / liveTotal : 1 / 6;
    const v = (1 - liveW) * prior[i] + liveW * live;
    if (v > max) {
      max = v;
      hot = i;
    }
  }
  return hot;
}

/**
 * Choose the bot's number (1–6). The shared core reads the opponent and reacts
 * to the match; each personality's parameters bias every step — how aggressive
 * it is, how much it trusts the read, how random it plays, and how much risk it
 * accepts. Momentum nudges aggression up on a hot streak; the Chaos style swaps
 * in a fresh random sub-style every few balls.
 */
export function pickBotMove(room: Room, botIdx: number): number {
  const p = PERSONALITIES[room.players[botIdx]?.botStyle ?? ''] ?? PERSONALITIES['All-Rounder'];
  const isBowling = botIdx === room.bowlerIdx;
  const oppIdx = isBowling ? room.batsmanIdx! : room.bowlerIdx!;
  const brain = brainFor(room, botIdx);

  let aggression = p.aggression;
  let volatility = p.volatility;

  // Chaos: adopt a brand-new random sub-style for a short burst, then switch.
  if (p.chaos) {
    if (!brain.mode || brain.ballsSeen >= brain.mode.until) {
      brain.mode = {
        aggression: Math.random(),
        volatility: 0.4 + Math.random() * 0.6,
        until: brain.ballsSeen + 2 + Math.floor(Math.random() * 4),
      };
    }
    aggression = brain.mode.aggression;
    volatility = brain.mode.volatility;
  }

  // Match awareness reshapes aggression (Strategist fully; others partially).
  if (p.situational) {
    aggression = situationalAggression(room, isBowling);
  } else if (p.situationalIq > 0) {
    const k = p.situationalIq * 0.5;
    aggression = clamp01(aggression * (1 - k) + situationalAggression(room, isBowling) * k);
  }
  // Confidence/momentum: a good streak makes it bolder, a wobble more cautious.
  aggression = clamp01(aggression + brain.momentum * 0.2);

  const hot = readOpponent(room, oppIdx, isBowling, p.memory);

  if (isBowling) {
    const actOnRead = hot !== null && Math.random() < p.adaptability;
    // Unpredictable bowling: Chaos/Gambler vary wildly, Wall/Guardian stay steady.
    if (!actOnRead || Math.random() < volatility * 0.45) return rnd();
    // Commit to the wicket ball harder when more aggressive / risk-tolerant.
    const commit = 0.4 + aggression * 0.4 + p.riskTolerance * 0.15;
    return Math.random() < commit ? hot! : rnd();
  }

  // Batting. A pure free swing some of the time (scaled by volatility).
  if (Math.random() < volatility * 0.4) {
    return weightedBat(aggression, null, brain.recent, p.adaptability);
  }
  // Otherwise avoid the bowler's danger number — readers and cautious bots avoid
  // it more; risk-tolerant bots chance it.
  const avoidProb = clamp01(p.adaptability * 0.6 + (1 - p.riskTolerance) * 0.5);
  const avoid = hot !== null && Math.random() < avoidProb ? hot : null;
  return weightedBat(aggression, avoid, brain.recent, p.adaptability);
}

/**
 * Record both players' moves so bots can adapt, and update each bot's live brain
 * (recent moves + momentum/confidence). Cheap; only called for rooms with a bot.
 */
export function recordMoveCounts(
  room: Room,
  batIdx: number,
  batMove: number,
  bowlIdx: number,
  bowlMove: number
): void {
  room.botMoveCounts ??= {};
  (room.botMoveCounts[batIdx] ??= new Array(7).fill(0))[batMove]++;
  (room.botMoveCounts[bowlIdx] ??= new Array(7).fill(0))[bowlMove]++;

  const out = batMove === bowlMove;

  const bat = brainFor(room, batIdx);
  bat.recent.push(batMove);
  if (bat.recent.length > 5) bat.recent.shift();
  bat.ballsSeen++;
  if (out) bat.momentum = clampSigned(bat.momentum - 0.5); // dismissed → rattled
  else if (batMove >= 5) bat.momentum = clampSigned(bat.momentum + 0.25); // big hit → bolder
  else bat.momentum *= 0.85; // drift back to neutral

  const bowl = brainFor(room, bowlIdx);
  bowl.recent.push(bowlMove);
  if (bowl.recent.length > 5) bowl.recent.shift();
  bowl.ballsSeen++;
  if (out) bowl.momentum = clampSigned(bowl.momentum + 0.4); // took a wicket → bolder
  else bowl.momentum = clampSigned(bowl.momentum - 0.08);
}
