// Mirrors client/src/tournament/TournamentLobby.tsx.
import type { TournamentState } from '@cric/types';
import { ask, menu } from '../prompt.ts';
import { socket } from '../socket.ts';
import { resetToLobby, state, waitForTick } from '../state.ts';

function printTournament(t: TournamentState): void {
  console.log(`\nTournament ${t.code} — ${t.players.length}/${t.size} players, phase: ${t.phase}`);
  t.groups.forEach((group, gi) => {
    const label = t.groups.length > 1 ? ` Group ${String.fromCharCode(65 + gi)}` : '';
    console.log(`Players${label}: ${group.map((idx) => t.players[idx]?.name ?? '?').join(', ')}`);
  });

  console.log('\nFixtures:');
  for (const f of t.fixtures) {
    const p1 = t.players[f.player1Idx]?.name ?? '?';
    const p2 = t.players[f.player2Idx]?.name ?? '?';
    const label = f.label ?? (f.isFinal ? 'Final' : `Match ${f.matchNum}`);
    const score = f.status === 'upcoming' ? '' : ` ${f.p1Score}-${f.p2Score}`;
    console.log(`  [${f.status}] ${label}: ${p1} vs ${p2}${score}`);
  }

  if (t.liveScore) {
    const ls = t.liveScore;
    console.log(
      `\nLive: ${ls.batsmanName} batting vs ${ls.bowlerName} — ${ls.score}/${ls.wicketsLost} (${ls.balls} balls)` +
        (ls.target !== null ? `, target ${ls.target}` : '')
    );
  }

  console.log('\nPoints table:');
  for (const p of t.players) {
    const entry = t.pointsTable[p.id];
    if (!entry) continue;
    console.log(
      `  ${p.name}: P${entry.played} W${entry.won} L${entry.lost} T${entry.tied} Pts${entry.points} NRR${entry.nrr.toFixed(3)}`
    );
  }
}

export async function tournamentLobbyScreen(): Promise<void> {
  if (state.awaitingFinalReady) {
    console.log('\n🏆 GRAND FINALE — the bracket is set, you\'re in the final!');
    await ask('Press Enter to start the final...');
    state.awaitingFinalReady = false;
    socket.emit('final_ready');
    await waitForTick();
    return;
  }

  if (!state.tournamentState) {
    await waitForTick();
    return;
  }
  printTournament(state.tournamentState);

  const choice = await menu('Tournament lobby', [
    { key: '1', label: 'Start with bots (fill empty seats)' },
    { key: '2', label: 'Wait for the next update' },
    { key: 'b', label: 'Leave tournament' },
  ]);
  if (choice === '1') {
    socket.emit('start_tournament_with_bots');
    await waitForTick();
  } else if (choice === '2') {
    await waitForTick();
  } else {
    await resetToLobby();
  }
}
