// Mirrors client/src/tournament/TournamentResult.tsx.
import { menu } from '../prompt.ts';
import { resetToLobby, state } from '../state.ts';

export async function tournamentResultScreen(): Promise<void> {
  const t = state.tournamentState;
  if (t) {
    const champion = t.players.find((p) => p.id === t.champion);
    console.log(`\n🏆 Tournament ${t.code} complete!`);
    console.log(champion ? `Champion: ${champion.name}` : 'No champion recorded.');
    console.log('\nFinal points table:');
    for (const p of t.players) {
      const entry = t.pointsTable[p.id];
      if (!entry) continue;
      console.log(`  ${p.name}: P${entry.played} W${entry.won} L${entry.lost} T${entry.tied} Pts${entry.points}`);
    }
  }
  await menu('Tournament finished', [{ key: '1', label: 'Back to lobby' }]);
  await resetToLobby();
}
