// Mirrors client/src/friends/FriendsPanel.tsx.
import type { Friend, SearchResult } from '@cric/types';
import { apiDelete, apiGet, apiPost } from '../api.ts';
import { ask, askCount, menu } from '../prompt.ts';
import { socket } from '../socket.ts';
import { state, waitWhilePhase } from '../state.ts';

async function listFriends(): Promise<void> {
  if (!state.user) return;
  try {
    const friends = await apiGet<Friend[]>('/api/friends', state.user.token);
    if (friends.length === 0) {
      console.log('No friends yet.');
      return;
    }
    console.log('\nFriends:');
    for (const f of friends) {
      console.log(`  ${f.username} ${f.online ? '🟢 online' : '⚪ offline'} — W${f.stats.wins}/L${f.stats.losses}/T${f.stats.ties}`);
    }
  } catch (err) {
    console.log(`Could not load friends: ${(err as Error).message}`);
  }
}

async function searchPlayers(): Promise<void> {
  if (!state.user) return;
  const q = await ask('Search username (min 2 chars): ');
  if (q.length < 2) {
    console.log('Enter at least 2 characters.');
    return;
  }
  try {
    const results = await apiGet<SearchResult[]>(
      `/api/users/search?q=${encodeURIComponent(q)}`,
      state.user.token
    );
    if (results.length === 0) {
      console.log('No matches.');
      return;
    }
    console.log('\nResults:');
    results.forEach((r, i) => {
      console.log(`  ${i + 1}) ${r.username} ${r.online ? '🟢' : '⚪'}${r.isFriend ? ' (friend)' : ''}`);
    });
    const ans = await ask('Add which #? (blank to skip): ');
    const idx = parseInt(ans, 10) - 1;
    const pick = results[idx];
    if (pick && !pick.isFriend) {
      await apiPost('/api/friends/add', { friendId: pick.id }, state.user.token);
      console.log(`Added ${pick.username} as a friend.`);
    }
  } catch (err) {
    console.log(`Search failed: ${(err as Error).message}`);
  }
}

async function removeFriend(): Promise<void> {
  if (!state.user) return;
  try {
    const friends = await apiGet<Friend[]>('/api/friends', state.user.token);
    if (friends.length === 0) {
      console.log('No friends to remove.');
      return;
    }
    friends.forEach((f, i) => console.log(`  ${i + 1}) ${f.username}`));
    const ans = await ask('Remove which #? (blank to cancel): ');
    const idx = parseInt(ans, 10) - 1;
    const pick = friends[idx];
    if (pick) {
      await apiDelete(`/api/friends/${pick.id}`, state.user.token);
      console.log(`Removed ${pick.username}.`);
    }
  } catch (err) {
    console.log(`Could not remove friend: ${(err as Error).message}`);
  }
}

async function sendChallenge(): Promise<void> {
  if (!state.user) return;
  try {
    const friends = await apiGet<Friend[]>('/api/friends', state.user.token);
    const online = friends.filter((f) => f.online);
    if (online.length === 0) {
      console.log('No friends online right now.');
      return;
    }
    online.forEach((f, i) => console.log(`  ${i + 1}) ${f.username}`));
    const ans = await ask('Challenge which #? (blank to cancel): ');
    const idx = parseInt(ans, 10) - 1;
    const pick = online[idx];
    if (!pick) return;
    const overs = await askCount('Overs (default 2): ', 2);
    const wickets = await askCount('Wickets (default 1): ', 1);
    socket.emit('send_challenge', { toUserId: pick.id, overs, wickets });
    console.log(`Waiting for ${pick.username} to respond…`);
    // Resolves either when the match starts (phase leaves 'lobby') or the
    // challenge falls through (declined/expired/error — printed by the global
    // listeners in state.ts, which also stay in 'lobby').
    await Promise.race([
      waitWhilePhase('lobby'),
      new Promise<void>((resolve) => {
        socket.once('challenge_declined', () => resolve());
        socket.once('challenge_expired', () => resolve());
        socket.once('challenge_error', () => resolve());
      }),
    ]);
  } catch (err) {
    console.log(`Could not send challenge: ${(err as Error).message}`);
  }
}

async function respondToChallenges(): Promise<void> {
  if (state.pendingChallenges.length === 0) {
    console.log('No pending challenges.');
    return;
  }
  while (state.pendingChallenges.length > 0) {
    const c = state.pendingChallenges[0]!;
    console.log(`\n${c.from.username} challenged you — ${c.overs} overs, ${c.wickets} wickets.`);
    const ans = (await ask('Accept? (y/n): ')).toLowerCase();
    const accept = ans.startsWith('y');
    socket.emit('respond_challenge', { challengeId: c.challengeId, accept });
    state.pendingChallenges = state.pendingChallenges.filter((p) => p.challengeId !== c.challengeId);
    if (accept) {
      await waitWhilePhase('lobby');
      return;
    }
  }
}

export async function friendsScreen(): Promise<void> {
  for (;;) {
    if (state.phase !== 'lobby') return; // a challenge took us into a match
    const choice = await menu('Friends', [
      { key: '1', label: 'List friends' },
      { key: '2', label: 'Search players' },
      { key: '3', label: 'Remove a friend' },
      { key: '4', label: 'Challenge a friend' },
      { key: '5', label: `Respond to challenges (${state.pendingChallenges.length})` },
      { key: 'b', label: 'Back to lobby' },
    ]);
    if (choice === 'b') return;
    if (choice === '1') await listFriends();
    else if (choice === '2') await searchPlayers();
    else if (choice === '3') await removeFriend();
    else if (choice === '4') await sendChallenge();
    else if (choice === '5') await respondToChallenges();
  }
}
