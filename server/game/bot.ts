import { randomUUID } from 'crypto';
import { totalBalls, type Room, type RoomPlayer } from './room.ts';

// ─── Identity ────────────────────────────────────────────────────────────────

const BOT_NAMES = [
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

/** Pick a bot name not already used by `taken` (case-insensitive). */
export function randomBotName(taken: string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const free = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
  const pool = free.length ? free : BOT_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Personalities ─────────────────────────────────────────────────────────
//
// Every bot shares the same adaptive brain (it tracks the opponent's most-played
// number and targets/avoids it). A personality layers a *bias* on top:
//   • explore    — how often it ignores the read and plays freely (unpredictable)
//   • aggression — batting: lean to big numbers (high-scoring but predictable);
//                  bowling: how relentlessly it commits to the wicket ball.

interface Personality {
  explore: number;
  aggression: number;
  /** Aggression is computed live from the match state instead of being fixed. */
  situational?: boolean;
}

const PERSONALITIES: Record<string, Personality> = {
  Aggressive: { explore: 0.22, aggression: 0.85 }, // big hitter, hunts wickets hard
  Defensive: { explore: 0.4, aggression: 0.2 }, // plays low/spread, tough to dislodge
  Safe: { explore: 0.22, aggression: 0.4 }, // careful & consistent, dodges the out
  'Risk Taker': { explore: 0.5, aggression: 0.92 }, // swings big and gambles — boom or bust
  Challenger: { explore: 0.18, aggression: 0.6 }, // reads you sharply and pushes back
  'Situation-wise': { explore: 0.2, aggression: 0.5, situational: true }, // adapts to the chase
  Chaotic: { explore: 0.82, aggression: 0.5 }, // almost pure randomness
  'All-Rounder': { explore: 0.35, aggression: 0.5 }, // balanced
};
const STYLE_LABELS = Object.keys(PERSONALITIES);

/** Dynamic aggression for the "Situation-wise" bot based on the live match. */
function situationalAggression(room: Room, isBowling: boolean): number {
  const inn = room.innings[room.currentInnings];
  if (room.currentInnings === 1) {
    // Second innings: there's a target in play.
    const need = room.innings[0].score + 1 - inn.score;
    const ballsLeft = totalBalls(room) - inn.balls;
    if (isBowling) {
      // Defending — hunt wickets hard when the chaser is closing in.
      return need <= 8 ? 0.9 : 0.55;
    }
    if (ballsLeft <= 0) return 0.6;
    // Chasing — go big if behind the required rate, cruise if ahead.
    return Math.max(0.2, Math.min(0.95, need / ballsLeft / 4));
  }
  // First innings: build/restrict a total at a steady, slightly positive tempo.
  return isBowling ? 0.55 : 0.6;
}

/**
 * Each bot name maps to ONE fixed personality, derived from a hash of the name.
 * Deterministic (a given bot always plays the same way, so players can learn it)
 * but opaque — the assignment isn't written down anywhere, so it stays a
 * surprise to discover through play.
 */
function styleForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return STYLE_LABELS[h % STYLE_LABELS.length];
}

/** Build a fresh bot RoomPlayer; its personality is fixed by its name. */
export function makeBotPlayer(takenNames: string[]): RoomPlayer {
  const name = randomBotName(takenNames);
  return { id: makeBotId(), name, userId: null, isBot: true, botStyle: styleForName(name) };
}

// ─── Move strategy ───────────────────────────────────────────────────────────

const rnd = (): number => 1 + Math.floor(Math.random() * 6);

/**
 * Pick a batting number weighted by aggression (high aggression → favours
 * 4/5/6; low → favours 1/2/3), strongly avoiding `avoid` (the bowler's predicted
 * number) when given.
 */
function weightedBat(aggression: number, avoid: number | null): number {
  const weights: number[] = [];
  for (let i = 1; i <= 6; i++) {
    let w = 1 + (aggression - 0.5) * 1.6 * ((i - 3.5) / 2.5);
    w = Math.max(0.05, w);
    if (i === avoid) w *= 0.12;
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

/**
 * Record both players' moves for the match so bots can adapt. Cheap; only called
 * for rooms that actually contain a bot.
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
}

/**
 * Choose the bot's number (1–6). The adaptive core (shared by all bots) reads
 * the opponent's most-played number; the bot's personality then biases whether
 * it acts on that read and how it shapes its own move.
 *  - As bowler: MATCH the batsman's likely number (a match = wicket).
 *  - As batsman: AVOID the bowler's likely number, weighted by aggression.
 */
export function pickBotMove(room: Room, botIdx: number): number {
  const style = PERSONALITIES[room.players[botIdx]?.botStyle ?? ''] ?? PERSONALITIES['All-Rounder'];
  const oppIdx = botIdx === room.batsmanIdx ? room.bowlerIdx! : room.batsmanIdx!;
  const isBowling = botIdx === room.bowlerIdx;
  const aggression = style.situational ? situationalAggression(room, isBowling) : style.aggression;
  const counts = room.botMoveCounts?.[oppIdx];
  const total = counts ? counts.reduce((a, b) => a + b, 0) : 0;

  // The opponent's most frequent number so far (null until there's enough data).
  let hot: number | null = null;
  if (counts && total >= 3) {
    let max = -1;
    for (let i = 1; i <= 6; i++) {
      if (counts[i] > max) {
        max = counts[i];
        hot = i;
      }
    }
  }

  // Personality decides how often it plays freely instead of acting on the read.
  const playFree = hot === null || Math.random() < style.explore;

  if (isBowling) {
    if (playFree) return rnd();
    // Commit to the wicket ball more often the more aggressive the bot is.
    return Math.random() < 0.5 + aggression * 0.5 ? hot! : rnd();
  }

  // Batting: aggression shapes the number; avoid the read unless playing free.
  return weightedBat(aggression, playFree ? null : hot);
}
