// Mirrors client/src/game/GameScreen.tsx — both batsman and bowler submit a
// number 1-6 every ball; matching numbers = OUT (server-authoritative, see
// server/game/logic.ts resolveBall). "declare" mirrors the Declare button,
// which forfeits and returns to the lobby immediately client-side.
import { ask } from '../prompt.ts';
import { socket } from '../socket.ts';
import { resetToLobby, state, waitForTick } from '../state.ts';

export async function inningsScreen(): Promise<void> {
  while (state.phase === 'innings') {
    const gs = state.gameState;
    if (gs) {
      const role =
        state.myPlayerIdx === gs.batsmanIdx
          ? 'batting'
          : state.myPlayerIdx === gs.bowlerIdx
            ? 'bowling'
            : 'spectating';
      // lastBall is nulled at innings_start, so when present it's always the
      // current innings' most recent ball — more current than gameState,
      // which only refreshes on the next `state` broadcast.
      const score = state.lastBall?.score ?? gs.score;
      const balls = state.lastBall?.balls ?? gs.balls;
      const wicketsLost = state.lastBall?.wicketsLost ?? gs.wicketsLost;
      console.log(
        `\n[${role}] Score ${score}/${wicketsLost} after ${balls} ball(s)` +
          (gs.target !== null ? `, target ${gs.target}` : '')
      );
    }

    const ans = await ask('Pick a number 1-6 (or "declare"): ');
    if (ans.toLowerCase() === 'declare') {
      socket.emit('declare');
      await resetToLobby();
      return;
    }

    const n = parseInt(ans, 10);
    if (!Number.isInteger(n) || n < 1 || n > 6) {
      console.log('Enter a number from 1 to 6.');
      continue;
    }

    const seqBefore = state.ballSeq;
    socket.emit('play_move', { number: n });
    while (state.ballSeq === seqBefore && state.phase === 'innings') {
      await waitForTick();
    }
  }
}
