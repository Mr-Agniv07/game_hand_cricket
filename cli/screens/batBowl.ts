// Mirrors client/src/game/BatBowlScreen.tsx.
import type { BatBowlChoice } from '@cric/types';
import { ask } from '../prompt.ts';
import { socket } from '../socket.ts';
import { state, waitWhilePhase } from '../state.ts';

export async function batBowlScreen(): Promise<void> {
  if (state.gameState?.tossWinnerId === state.myId) {
    let choice: BatBowlChoice | null = null;
    while (!choice) {
      const ans = (await ask('You won the toss — bat or bowl first? (bat/bowl): ')).toLowerCase();
      if (ans.startsWith('bat')) choice = 'bat';
      else if (ans.startsWith('bowl')) choice = 'bowl';
      else console.log('Please type "bat" or "bowl".');
    }
    socket.emit('bat_bowl_choice', { choice });
  } else {
    console.log('Waiting for the toss winner to choose bat or bowl...');
  }
  await waitWhilePhase('bat_bowl');
}
