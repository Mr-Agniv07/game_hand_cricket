import type { FixtureMatch, TournamentPlayer } from '@cric/types';

const oversStr = (balls: number) => `${Math.floor(balls / 6)}.${balls % 6}`;

export interface FixtureSummary {
  /** Player 1's score line, e.g. "98/5 (4.2/5)" — or "—" when unavailable. */
  s1: string;
  s2: string;
  /** Result line, e.g. "Alice won by 41 runs" / "Bob won by 2 wickets". */
  result: string;
}

/**
 * Derive the display strings for a finished fixture from its scorecard:
 * each team's runs/wickets (overs) and a "won by runs/wickets" result line.
 * Shared by the tournament lobby fixtures and the result-screen knockouts so
 * the wording/logic stays identical.
 */
export function fixtureSummary(
  f: FixtureMatch,
  players: TournamentPlayer[],
  overs: number,
  wickets: number
): FixtureSummary {
  const fp1 = players[f.player1Idx];
  const fp2 = players[f.player2Idx];
  const inns = f.scorecard?.innings ?? [];
  const byName = (name?: string) => inns.find((i) => i.batter === name);
  const line = (name?: string) => {
    const inn = byName(name);
    return inn ? `${inn.runs}/${inn.wickets} (${oversStr(inn.balls)}/${overs})` : '—';
  };

  let result = '';
  if (f.result === 'tie') {
    result = 'Match tied';
  } else if (f.result) {
    const winner = f.result === 'p1' ? fp1 : fp2;
    if (f.superOver) {
      result = `${winner?.name ?? '?'} won the Super Over`;
    } else if (winner?.name === inns[0]?.batter) {
      // Winner batted first → defended → won by runs.
      const margin = (inns[0]?.runs ?? 0) - (inns[1]?.runs ?? 0);
      result = `${winner?.name} won by ${margin} run${margin !== 1 ? 's' : ''}`;
    } else {
      // Winner batted second → chased → won by wickets in hand.
      const left = wickets - (byName(winner?.name)?.wickets ?? 0);
      result = `${winner?.name} won by ${left} wicket${left !== 1 ? 's' : ''}`;
    }
  }

  return { s1: line(fp1?.name), s2: line(fp2?.name), result };
}
