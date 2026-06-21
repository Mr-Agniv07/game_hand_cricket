// Global, context-aware model of how HUMAN players pick their numbers, learned
// from the BallEvent history. Bots use it as a "prior" so they read a human
// opponent well from the very FIRST ball, instead of waiting for the in-match
// frequency count to build up. It improves automatically as more games are
// logged — trained at boot, then updated live as humans play.
//
// It is intentionally a single SHARED model (not per-player): it captures how
// people play in general. Each bot's personality still decides how much it
// trusts and acts on the prediction, so all bots stay distinct.
//
// Context awareness: predictions are conditioned on the role (batting vs
// bowling), the innings, the phase of the innings, and the player's previous
// move (a first-order pattern, e.g. "after a 6 they often play 1"). Sparse
// contexts back off to broader ones so the model is useful even early on.

export type Role = 'bat' | 'bowl';

type CountTable = Map<string, number[]>; // context key -> counts indexed 1..6 (0 unused)
const tables: Record<Role, CountTable> = { bat: new Map(), bowl: new Map() };
let totalObservations = 0;

const MIN_TO_PREDICT = 50; // stay silent (cold start) until we've seen this many human balls
const MIN_PER_CELL = 12; // a context bucket needs this many samples before we trust it

/** Coarse innings phase (0 = powerplay-ish, 1 = middle, 2 = death). */
export function phaseOf(ballIndex: number, totalBalls: number): number {
  const f = totalBalls > 0 ? ballIndex / totalBalls : 0;
  return f < 0.4 ? 0 : f < 0.75 ? 1 : 2;
}

/** Backoff context keys, most specific first. */
function keysFor(innings: number, phase: number, prevMove: number | null): string[] {
  const pm = prevMove ?? 0;
  return [`i${innings}|p${phase}|m${pm}`, `p${phase}|m${pm}`, `m${pm}`, '*'];
}

/** Record one human ball into every backoff level. */
export function observeHuman(
  role: Role,
  innings: number,
  phase: number,
  prevMove: number | null,
  move: number
): void {
  if (move < 1 || move > 6) return;
  const table = tables[role];
  for (const key of keysFor(innings, phase, prevMove)) {
    let c = table.get(key);
    if (!c) {
      c = new Array(7).fill(0);
      table.set(key, c);
    }
    c[move]++;
  }
  totalObservations++;
}

/** True once there's enough data for predictions to be meaningful. */
export function isReady(): boolean {
  return totalObservations >= MIN_TO_PREDICT;
}

/**
 * Predicted distribution over the human's next number (index 1..6), using the
 * finest context bucket that has enough data; null if the model is too cold or
 * the context is unseen.
 */
export function predict(
  role: Role,
  innings: number,
  phase: number,
  prevMove: number | null
): number[] | null {
  if (!isReady()) return null;
  const table = tables[role];
  for (const key of keysFor(innings, phase, prevMove)) {
    const c = table.get(key);
    if (!c) continue;
    let tot = 0;
    for (let i = 1; i <= 6; i++) tot += c[i];
    if (tot >= MIN_PER_CELL) {
      const dist = new Array(7).fill(0);
      for (let i = 1; i <= 6; i++) dist[i] = (c[i] + 0.5) / (tot + 3); // Laplace-smoothed
      return dist;
    }
  }
  return null;
}

/** Wipe the model (used to rebuild from scratch at boot). */
export function reset(): void {
  tables.bat.clear();
  tables.bowl.clear();
  totalObservations = 0;
}
