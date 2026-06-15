import { Router } from 'express';
import type { Request, Response } from 'express';
import { getFriends, searchUsers, addFriend, removeFriend, getMatchHistory } from '../db.ts';
import { requireAuth } from '../auth/routes.ts';
import type { AuthRequest } from '../auth/routes.ts';
import { onlineUsers } from '../game/handlers.ts';

export const friendsRouter = Router();

friendsRouter.get('/api/friends', requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthRequest).userId;
  const friends = getFriends(userId);
  res.json(friends.map((f) => ({ ...f, online: onlineUsers.has(f.id) })));
});

friendsRouter.get('/api/users/search', requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthRequest).userId;
  const q = (typeof req.query.q === 'string' ? req.query.q : '').trim();
  if (q.length < 2) return res.json([]);
  const results = searchUsers(q, userId);
  const myFriendIds = new Set(getFriends(userId).map((f) => f.id));
  res.json(
    results.map((u) => ({ ...u, isFriend: myFriendIds.has(u.id), online: onlineUsers.has(u.id) }))
  );
});

friendsRouter.post('/api/friends/add', requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthRequest).userId;
  const { friendId } = req.body || {};
  if (!friendId) return res.status(400).json({ error: 'friendId required' });
  if (friendId === userId) return res.status(400).json({ error: 'Cannot add yourself' });
  const ok = addFriend(userId, friendId);
  if (!ok) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

friendsRouter.delete('/api/friends/:friendId', requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthRequest).userId;
  removeFriend(userId, req.params.friendId as string);
  res.json({ ok: true });
});

friendsRouter.get('/api/history', requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthRequest).userId;
  const history = getMatchHistory(userId);
  res.json([...history].reverse());
});
