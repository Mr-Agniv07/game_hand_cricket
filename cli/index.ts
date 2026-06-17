// Entry point: boot (restore session/room, mirroring App.tsx's recovery effect)
// then dispatch to the screen matching the current phase, exactly mirroring the
// conditional rendering in client/src/App.tsx.
import { setSocketAuth, socket } from './socket.ts';
import { bindSocketListeners, restoreSession, setPhase, state, waitWhilePhase } from './state.ts';
import { closePrompt } from './prompt.ts';
import { getActiveRoom } from './storage.ts';
import { authScreen } from './screens/auth.ts';
import { lobbyScreen } from './screens/lobby.ts';
import { tossScreen } from './screens/toss.ts';
import { batBowlScreen } from './screens/batBowl.ts';
import { inningsScreen } from './screens/innings.ts';
import { resultScreen } from './screens/result.ts';
import { tournamentLobbyScreen } from './screens/tournamentLobby.ts';
import { tournamentResultScreen } from './screens/tournamentResult.ts';

bindSocketListeners();

process.on('SIGINT', () => {
  if (state.roomId) socket.emit('leave_room');
  closePrompt();
  socket.disconnect();
  process.exit(0);
});

async function boot(): Promise<void> {
  const room = getActiveRoom();
  const restored = await restoreSession();

  if (room) {
    // Page-refresh-equivalent recovery: connect immediately so `rejoin_room`
    // lands well inside the server's disconnect grace window.
    setSocketAuth(restored.hasToken && state.user ? state.user.token : undefined);
    socket.connect();
    setTimeout(() => {
      if (!state.recovering) return;
      state.recovering = false;
      state.roomId = null;
      setPhase(state.user ? 'lobby' : 'auth');
    }, 6000);
    return; // phase is set by the recovering 'state' handler, or the fallback above
  }

  if (restored.hasToken && state.user) {
    setSocketAuth(state.user.token);
    socket.connect();
    setPhase('lobby');
  } else {
    setPhase('auth');
  }
}

async function main(): Promise<void> {
  await boot();
  for (;;) {
    switch (state.phase) {
      case 'loading':
        await waitWhilePhase('loading');
        break;
      case 'auth':
        await authScreen();
        break;
      case 'lobby':
        await lobbyScreen();
        break;
      case 'waiting':
        console.log(`\nWaiting for opponent... room code: ${state.roomId}`);
        await waitWhilePhase('waiting');
        break;
      case 'toss_call':
        await tossScreen();
        break;
      case 'bat_bowl':
        await batBowlScreen();
        break;
      case 'innings':
        await inningsScreen();
        break;
      case 'result':
        await resultScreen();
        break;
      case 'tournament_lobby':
        await tournamentLobbyScreen();
        break;
      case 'tournament_result':
        await tournamentResultScreen();
        break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
