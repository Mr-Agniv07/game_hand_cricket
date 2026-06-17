// Mirrors client/src/lobby/Lobby.tsx + the lobby-driving parts of App.tsx.
import type { MatchHistoryEntry } from '@cric/types';
import { apiGet } from '../api.ts';
import { ask, askCount, closePrompt, menu } from '../prompt.ts';
import { socket } from '../socket.ts';
import { clearUser, resetState, setMyPlayerIdx, setPhase, state, waitWhilePhase } from '../state.ts';
import { friendsScreen } from './friends.ts';

async function promptName(): Promise<string> {
  if (state.user) return state.user.username;
  let name = '';
  while (!name) name = await ask('Your name: ');
  return name;
}

async function createRoom(): Promise<void> {
  const playerName = await promptName();
  const overs = await askCount('Overs (default 2): ', 2);
  const wickets = await askCount('Wickets (default 1): ', 1);
  socket.emit('create_room', { playerName, overs, wickets });
  await waitWhilePhase('lobby');
}

async function joinRoom(): Promise<void> {
  const roomId = (await ask('Room code: ')).toUpperCase();
  const playerName = await promptName();
  setMyPlayerIdx(1);
  socket.emit('join_room', { roomId, playerName });
  await waitWhilePhase('lobby');
}

async function playVsBot(): Promise<void> {
  const playerName = await promptName();
  const overs = await askCount('Overs (default 2): ', 2);
  const wickets = await askCount('Wickets (default 1): ', 1);
  socket.emit('play_vs_bot', { playerName, overs, wickets });
  await waitWhilePhase('lobby');
}

async function createTournament(): Promise<void> {
  const playerName = await promptName();
  const overs = await askCount('Overs (default 2): ', 2);
  const wickets = await askCount('Wickets (default 1): ', 1);
  const sizeAns = await ask('Tournament size, 4 or 8 (default 4): ');
  const size = sizeAns === '8' ? 8 : 4;
  socket.emit('create_tournament', { playerName, overs, wickets, size });
  await waitWhilePhase('lobby');
}

async function joinTournament(): Promise<void> {
  const code = (await ask('Tournament code: ')).toUpperCase();
  const playerName = await promptName();
  socket.emit('join_tournament', { code, playerName });
  await waitWhilePhase('lobby');
}

async function showHistory(): Promise<void> {
  if (!state.user) return;
  try {
    const history = await apiGet<MatchHistoryEntry[]>('/api/history', state.user.token);
    if (history.length === 0) {
      console.log('No matches played yet.');
      return;
    }
    console.log('\nLast matches:');
    for (const m of history) {
      console.log(
        `  ${m.date.slice(0, 10)}  vs ${m.opponent}  ${m.result.toUpperCase()}  ${m.myScore}-${m.oppScore}  (${m.overs}ov/${m.wickets}w)`
      );
    }
  } catch (err) {
    console.log(`Could not load history: ${(err as Error).message}`);
  }
}

function showStats(): void {
  if (!state.user) return;
  const s = state.user.stats;
  console.log(
    `\nStats — played ${s.gamesPlayed}, won ${s.wins}, lost ${s.losses}, tied ${s.ties}, runs ${s.runsScored}, high score ${s.highScore}`
  );
}

function logout(): void {
  clearUser();
  state.user = null;
  socket.disconnect();
  resetState();
  setPhase('auth');
}

function quit(): never {
  if (state.roomId) socket.emit('leave_room');
  closePrompt();
  socket.disconnect();
  process.exit(0);
}

export async function lobbyScreen(): Promise<void> {
  if (state.pendingChallenges.length > 0) {
    console.log(`\nYou have ${state.pendingChallenges.length} pending challenge(s) — see Friends to respond.`);
  }

  const options = [
    { key: '1', label: 'Create room' },
    { key: '2', label: 'Join room' },
    { key: '3', label: 'Play vs bot' },
    { key: '4', label: 'Create tournament' },
    { key: '5', label: 'Join tournament' },
  ];
  if (state.user) {
    options.push(
      { key: '6', label: 'Friends' },
      { key: '7', label: 'Match history' },
      { key: '8', label: 'View stats' },
      { key: '9', label: 'Log out' }
    );
  }
  options.push({ key: 'q', label: 'Quit' });

  const choice = await menu(
    state.user ? `Lobby — signed in as ${state.user.username}` : 'Lobby — playing as guest',
    options
  );
  if (choice === '1') return createRoom();
  if (choice === '2') return joinRoom();
  if (choice === '3') return playVsBot();
  if (choice === '4') return createTournament();
  if (choice === '5') return joinTournament();
  if (choice === '6') return friendsScreen();
  if (choice === '7') return showHistory();
  if (choice === '8') return showStats();
  if (choice === '9') return logout();
  if (choice === 'q') quit();
}
