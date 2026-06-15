import { randomUUID } from 'crypto';
import type { Room, RoomPlayer } from './room.ts';

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

/** Build a fresh bot RoomPlayer with a unique-ish name. */
export function makeBotPlayer(takenNames: string[]): RoomPlayer {
  return { id: makeBotId(), name: randomBotName(takenNames), userId: null, isBot: true };
}

// ─── Move strategy ───────────────────────────────────────────────────────────

const rnd = (): number => 1 + Math.floor(Math.random() * 6);

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
 * Choose the bot's number (1–6) for the current ball.
 *  - As bowler it tries to MATCH the batsman's most frequent number (a match =
 *    wicket).
 *  - As batsman it AVOIDS the bowler's most frequent number (to not get out).
 * Plays randomly early on, and explores ~35% of the time so it stays beatable
 * and unpredictable.
 */
export function pickBotMove(room: Room, botIdx: number): number {
  const oppIdx = botIdx === room.batsmanIdx ? room.bowlerIdx! : room.batsmanIdx!;
  const isBowling = botIdx === room.bowlerIdx;
  const counts = room.botMoveCounts?.[oppIdx];
  const total = counts ? counts.reduce((a, b) => a + b, 0) : 0;

  if (!counts || total < 3 || Math.random() < 0.35) return rnd();

  // Opponent's most frequent number so far.
  let hot = 1;
  let max = -1;
  for (let i = 1; i <= 6; i++) {
    if (counts[i] > max) {
      max = counts[i];
      hot = i;
    }
  }

  if (isBowling) return hot; // match the batsman → aim for the wicket

  // Batsman: pick something other than the bowler's likely number.
  let pick = rnd();
  let guard = 0;
  while (pick === hot && guard++ < 6) pick = rnd();
  return pick;
}
