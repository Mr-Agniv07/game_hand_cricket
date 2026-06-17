// Mirrors client/src/result/ResultScreen.tsx.
import { menu } from '../prompt.ts';
import { socket } from '../socket.ts';
import { resetToLobby, resetToTournamentLobby, state, waitWhilePhase } from '../state.ts';

export async function resultScreen(): Promise<void> {
  const go = state.gameOver;
  if (go) {
    console.log(`\nFinal score: ${go.players.map((p, i) => `${p} ${go.scores[i]}`).join(' vs ')}`);
  }

  const options = [{ key: '1', label: 'Play again (back to lobby)' }];
  if (!state.isTournamentMatch) {
    options.push({
      key: '2',
      label: state.rematchState === 'opponent_wants' ? 'Accept rematch' : 'Request rematch',
    });
  } else {
    options.push({ key: '3', label: 'Back to tournament' });
  }

  const choice = await menu('Match over', options);
  // The tournament can complete (phase -> 'tournament_result') while this prompt
  // is still pending, e.g. after the final's game_over — don't act on a stale
  // choice and clobber that transition (mirrors the stale-timer guards in the
  // web client's App.tsx).
  if (state.phase !== 'result') return;
  if (choice === '1') {
    await resetToLobby();
  } else if (choice === '2') {
    socket.emit('request_rematch');
    state.rematchState = 'waiting';
    console.log('Waiting for opponent...');
    await waitWhilePhase('result');
  } else if (choice === '3') {
    resetToTournamentLobby();
  }
}
