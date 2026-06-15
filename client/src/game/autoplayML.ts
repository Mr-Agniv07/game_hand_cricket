// Online learning model for the autoplay feature.
//
// The opponent is modelled separately for each role they occupy: how they pick
// numbers when BATTING vs when BOWLING are different distributions, so they get
// independent models. When you bat, your opponent bowls — predict their 'bowl'
// model and avoid it; when you bowl, they bat — predict their 'bat' model and
// match it.
//
// Each role model combines three signals:
//
//   1. Global frequency table — how often they pick each number in that role.
//      Laplace-smoothed (priors = 1) so early balls don't dominate.
//   2. First-order Markov transitions — what they tend to pick next.
//      Blended in once BLEND_THRESHOLD observations exist (60% Markov, 40% global).
//   3. Recency decay — every recordMove() multiplies existing counts by DECAY
//      before adding the new one, so recent behaviour outweighs old.
//
// Decisions are sampled from a weighted distribution (not argmin/argmax) to stay
// unpredictable to an observant opponent while still biasing toward good picks.
//
// newInnings() clears the recent-move sequences (so Markov context doesn't bleed
// across the role swap) but preserves the per-role frequency/transition tables.

const NUMBERS = 6;
const PRIOR_SUM = NUMBERS; // freq priors are six 1s at indices 1..6
const BLEND_THRESHOLD = 5;
const MARKOV_WEIGHT = 0.6;
const DECAY = 0.95;
// Inverse-weight smoothing for the batsman: a larger floor stops a single
// near-zero-probability number from dominating the sample (which would make the
// bot's batting predictable). Bigger ⇒ flatter ⇒ less exploitable.
const BAT_SMOOTH = 0.15;

export type OppRole = 'bat' | 'bowl';

function emptyRole(): RoleModel {
  return {
    freq: [0, 1, 1, 1, 1, 1, 1],
    transitions: Array.from({ length: NUMBERS + 1 }, () => [0, 1, 1, 1, 1, 1, 1]),
  };
}

interface RoleModel {
  freq: number[]; // freq[1..6]: decayed count; index 0 unused
  transitions: number[][]; // transitions[last][next]; row/col 0 unused
}

export class HandCricketML {
  private models: Record<OppRole, RoleModel> = { bat: emptyRole(), bowl: emptyRole() };
  // Recent move sequence per role — only the last entry (Markov context) matters.
  private recent: Record<OppRole, number[]> = { bat: [], bowl: [] };
  // Total observations per role, including any seeded from a loaded profile, so
  // the Markov blend can engage immediately when a rich profile is loaded
  // instead of waiting for BLEND_THRESHOLD fresh live balls.
  private obs: Record<OppRole, number> = { bat: 0, bowl: 0 };

  recordMove(move: number, role: OppRole): void {
    if (move < 1 || move > NUMBERS) return;
    const m = this.models[role];
    // Decay all counts before recording — recent moves matter more.
    for (let i = 1; i <= NUMBERS; i++) {
      m.freq[i] *= DECAY;
      for (let j = 1; j <= NUMBERS; j++) m.transitions[i][j] *= DECAY;
    }
    const last = this.recent[role].at(-1);
    if (last !== undefined) m.transitions[last][move] += 1;
    m.freq[move] += 1;
    this.recent[role].push(move);
    this.obs[role] += 1;
  }

  private predictProbs(role: OppRole): number[] {
    const m = this.models[role];
    const last = this.recent[role].at(-1);
    const freqTotal = m.freq.reduce((a, b) => a + b, 0);
    const freqProbs = m.freq.map((c) => c / freqTotal);

    if (last !== undefined && this.obs[role] >= BLEND_THRESHOLD) {
      const trans = m.transitions[last];
      const transTotal = trans.reduce((a, b) => a + b, 0);
      return trans.map(
        (c, i) => MARKOV_WEIGHT * (c / transTotal) + (1 - MARKOV_WEIGHT) * freqProbs[i]
      );
    }
    return freqProbs;
  }

  // Weighted random sample from weights[1..6] (index 0 is always 0/ignored).
  private sample(weights: number[]): number {
    let total = 0;
    for (let i = 1; i <= NUMBERS; i++) total += weights[i];
    let r = Math.random() * total;
    for (let i = 1; i <= NUMBERS; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return NUMBERS;
  }

  // I'm batting → opponent is bowling. Sample inversely from their predicted
  // bowl distribution: prefer numbers they rarely bowl (less chance of OUT).
  pickAsBatsman(): number {
    const probs = this.predictProbs('bowl');
    const weights = probs.map((p, i) => (i === 0 ? 0 : 1 / (p + BAT_SMOOTH)));
    return this.sample(weights);
  }

  // I'm bowling → opponent is batting. Sample directly from their predicted bat
  // distribution: prefer numbers they often play (higher chance of matching = OUT).
  pickAsBowler(): number {
    return this.sample(this.predictProbs('bat'));
  }

  // Between innings: clear the recent sequences so Markov context doesn't bleed,
  // but keep the per-role frequency/transition tables.
  newInnings(): void {
    this.recent = { bat: [], bowl: [] };
  }

  // Stats for the opponent in their current role (the role you're predicting).
  getStats(oppRole: OppRole): MLStats {
    const m = this.models[oppRole];
    const freqTotal = m.freq.reduce((a, b) => a + b, 0);
    const freqPct = m.freq.map((c) => Math.round((c / freqTotal) * 100));
    const lastMove = this.recent[oppRole].at(-1) ?? null;
    let transitionPct: number[] | null = null;
    if (lastMove !== null) {
      const row = m.transitions[lastMove];
      const rowTotal = row.reduce((a, b) => a + b, 0);
      transitionPct = row.map((c) => Math.round((c / rowTotal) * 100));
    }
    return { freqPct, transitionPct, lastMove, totalObservations: this.obs[oppRole] };
  }

  toData(): MLModelData {
    const dump = (m: RoleModel): RoleModelData => ({
      freq: [...m.freq],
      transitions: m.transitions.map((row) => [...row]),
    });
    return { bat: dump(this.models.bat), bowl: dump(this.models.bowl) };
  }

  // Seed a role from stored data — but only if we haven't started learning that
  // role live yet, so a slow profile fetch can't clobber moves already observed
  // this match.
  fromData(data: MLModelData): void {
    const seed = (src: RoleModelData | undefined, role: OppRole) => {
      if (!src || this.obs[role] > 0) return;
      const m = this.models[role];
      if (src.freq?.length === NUMBERS + 1) m.freq = [...src.freq];
      if (src.transitions?.length === NUMBERS + 1) m.transitions = src.transitions.map((r) => [...r]);
      // Estimate observations from the accumulated frequency mass above the
      // priors so the Markov blend can engage without waiting for live balls.
      const total = m.freq.reduce((a, b) => a + b, 0);
      this.obs[role] = Math.max(0, Math.round(total - PRIOR_SUM));
    };
    seed(data?.bat, 'bat');
    seed(data?.bowl, 'bowl');
  }
}

export interface RoleModelData {
  freq: number[];
  transitions: number[][];
}

export interface MLModelData {
  bat: RoleModelData;
  bowl: RoleModelData;
}

export interface MLStats {
  freqPct: number[]; // [0, pct1..pct6] — opponent pick % per number
  transitionPct: number[] | null; // [0, pct1..pct6] given last move, null if no history
  lastMove: number | null;
  totalObservations: number;
}
