// Mirrors client/src/toss/TossScreen.tsx.
import type { TossCall } from '@cric/types';
import { ask } from '../prompt.ts';
import { socket } from '../socket.ts';
import { state, waitWhilePhase } from '../state.ts';

export async function tossScreen(): Promise<void> {
  const info = state.tossInfo;
  if (info) {
    console.log(`\n${info.callerName} is calling the toss...`);
    if (info.callerId === state.myId) {
      let call: TossCall | null = null;
      while (!call) {
        const ans = (await ask('Call heads or tails (h/t): ')).toLowerCase();
        if (ans.startsWith('h')) call = 'heads';
        else if (ans.startsWith('t')) call = 'tails';
        else console.log('Please enter h or t.');
      }
      socket.emit('toss_call', { call });
    } else {
      console.log('Waiting for the toss call...');
    }
  }
  await waitWhilePhase('toss_call');
}
