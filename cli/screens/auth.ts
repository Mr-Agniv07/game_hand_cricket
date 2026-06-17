// Mirrors client/src/auth/AuthScreen.tsx + App.tsx's handleAuthSuccess/handleGuestPlay.
import type { AuthResponse } from '@cric/types';
import { apiPost } from '../api.ts';
import { ask, menu } from '../prompt.ts';
import { socket, setSocketAuth } from '../socket.ts';
import { saveUser, setPhase, state } from '../state.ts';

function applyAuth(data: AuthResponse): void {
  state.user = { id: data.id, username: data.username, token: data.token, stats: data.stats };
  saveUser({ id: data.id, username: data.username, token: data.token });
  setSocketAuth(data.token);
  if (!socket.connected) socket.connect();
  setPhase('lobby');
}

async function login(): Promise<boolean> {
  const username = await ask('Username: ');
  const password = await ask('Password: ');
  try {
    applyAuth(await apiPost<AuthResponse>('/api/login', { username, password }));
    return true;
  } catch (err) {
    console.log(`Login failed: ${(err as Error).message}`);
    return false;
  }
}

async function signup(): Promise<boolean> {
  const username = await ask('Choose a username (2-20 chars): ');
  const password = await ask('Choose a password (min 4 chars): ');
  const confirm = await ask('Confirm password: ');
  if (password !== confirm) {
    console.log('Passwords do not match.');
    return false;
  }
  try {
    applyAuth(await apiPost<AuthResponse>('/api/signup', { username, password }));
    return true;
  } catch (err) {
    console.log(`Sign up failed: ${(err as Error).message}`);
    return false;
  }
}

function guestPlay(): void {
  setSocketAuth(null);
  if (!socket.connected) socket.connect();
  setPhase('lobby');
}

export async function authScreen(): Promise<void> {
  for (;;) {
    const choice = await menu('Welcome to Cric Flick', [
      { key: '1', label: 'Sign in' },
      { key: '2', label: 'Sign up' },
      { key: '3', label: 'Continue as guest' },
    ]);
    if (choice === '1' && (await login())) return;
    if (choice === '2' && (await signup())) return;
    if (choice === '3') return guestPlay();
  }
}
