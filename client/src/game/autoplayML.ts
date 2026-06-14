// Online learning model for the autoplay feature.
//
// Three signals applied together:
//
//   1. Global frequency table — how often the opponent picks each number.
//      Laplace-smoothed (priors = 1) so early balls don't dominate.
//
//   2. First-order Markov transitions — what they tend to pick after each number.
//      Blended in after BLEND_THRESHOLD observations (60 % Markov, 40 % global).
//
//   3. Recency decay — each recordMove() multiplies existing counts by DECAY
//      before adding the new observation, so recent behaviour outweighs old.
//
// Decisions are probabilistic, not deterministic: picks are sampled from a
// weighted distribution rather than always returning argmin/argmax. This keeps
// the ML unpredictable to an observant opponent while still biasing toward
// good choices.
//
// newInnings() clears the move sequence (so Markov context doesn't bleed across
// innings) but preserves the frequency table — player biases carry over.

const NUMBERS = 6;
const BLEND_THRESHOLD = 5;
const MARKOV_WEIGHT = 0.6;
const DECAY = 0.95;

export class HandCricketML {
  private opponentMoves: number[] = [];
  // freq[1..6]: decayed count of opponent picking i; index 0 unused
  private freq = [0, 1, 1, 1, 1, 1, 1];
  // transitions[last][next]: decayed count of (last → next); row/col 0 unused
  private transitions: number[][] = Array.from({ length: NUMBERS + 1 }, () => [
    0, 1, 1, 1, 1, 1, 1,
  ]);

  recordMove(move: number): void {
    if (move < 1 || move > NUMBERS) return;
    // Decay all counts before recording — recent moves matter more
    for (let i = 1; i <= NUMBERS; i++) {
      this.freq[i] *= DECAY;
      for (let j = 1; j <= NUMBERS; j++) this.transitions[i][j] *= DECAY;
    }
    const last = this.opponentMoves.at(-1);
    if (last !== undefined) this.transitions[last][move] += 1;
    this.freq[move] += 1;
    this.opponentMoves.push(move);
  }

  private predictProbs(): number[] {
    const last = this.opponentMoves.at(-1);
    const freqTotal = this.freq.reduce((a, b) => a + b, 0);
    const freqProbs = this.freq.map((c) => c / freqTotal);

    if (last !== undefined && this.opponentMoves.length >= BLEND_THRESHOLD) {
      const trans = this.transitions[last];
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

  // As batsman: sample inversely — prefer numbers the bowler rarely picks.
  pickAsBatsman(): number {
    const probs = this.predictProbs();
    const weights = probs.map((p, i) => (i === 0 ? 0 : 1 / (p + 1e-6)));
    return this.sample(weights);
  }

  // As bowler: sample directly — prefer numbers the batsman often picks.
  pickAsBowler(): number {
    return this.sample(this.predictProbs());
  }

  // Between innings: clear move sequence so Markov context doesn't bleed,
  // but keep frequency data — player biases persist across innings.
  newInnings(): void {
    this.opponentMoves = [];
  }
}
