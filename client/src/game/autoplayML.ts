// Lightweight online-learning model for the autoplay feature.
//
// Tracks the opponent's move history with:
//   - a global frequency table (how often they pick each number)
//   - a first-order Markov transition matrix (what they tend to pick after each number)
//
// Both structures use Laplace smoothing (initialised to 1) so early decisions
// aren't dominated by a single observation.
//
// After enough history the model blends both signals (60 % Markov, 40 % global).
// Before that it falls back to global frequency alone.

const NUMBERS = 6;
const BLEND_THRESHOLD = 5; // balls before switching to Markov blend
const MARKOV_WEIGHT = 0.6;

export class HandCricketML {
  private opponentMoves: number[] = [];
  // freq[1..6] — count of opponent picking i; index 0 unused
  private freq = [0, 1, 1, 1, 1, 1, 1];
  // transitions[last][next] — count of (last → next); row/col 0 unused
  private transitions: number[][] = Array.from({ length: NUMBERS + 1 }, () => [
    0, 1, 1, 1, 1, 1, 1,
  ]);

  recordMove(move: number): void {
    if (move < 1 || move > NUMBERS) return;
    const last = this.opponentMoves.at(-1);
    if (last !== undefined) this.transitions[last][move]++;
    this.freq[move]++;
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

  // As batsman: pick the number the bowler is LEAST likely to match
  pickAsBatsman(): number {
    const probs = this.predictProbs();
    let best = 1;
    for (let i = 2; i <= NUMBERS; i++) if (probs[i] < probs[best]) best = i;
    return best;
  }

  // As bowler: pick the number the batsman is MOST likely to play
  pickAsBowler(): number {
    const probs = this.predictProbs();
    let best = 1;
    for (let i = 2; i <= NUMBERS; i++) if (probs[i] > probs[best]) best = i;
    return best;
  }

  reset(): void {
    this.opponentMoves = [];
    this.freq = [0, 1, 1, 1, 1, 1, 1];
    this.transitions = Array.from({ length: NUMBERS + 1 }, () => [0, 1, 1, 1, 1, 1, 1]);
  }
}
