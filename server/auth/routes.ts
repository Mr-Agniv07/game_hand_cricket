import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  findByUsername,
  findById,
  createUser,
  getPlayerProfile,
  getAchievements,
  getEconomy,
} from '../db.ts';
import { hashPassword, verifyPassword, createToken, verifyTokenGetUserId } from './auth.ts';

export const authRouter = Router();

authRouter.post('/api/signup', (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });
  if (username.length < 2 || username.length > 20)
    return res.status(400).json({ error: 'Username must be 2–20 characters.' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  const user = createUser(username.trim(), hashPassword(password));
  if (!user) return res.status(409).json({ error: 'Username already taken.' });
  const token = createToken(user.id);
  res.json({ id: user.id, username: user.username, token, stats: user.stats, ...getEconomy(user.id) });
});

authRouter.post('/api/login', (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });
  const user = findByUsername(username.trim());
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
  if (!verifyPassword(password, user.passwordHash))
    return res.status(401).json({ error: 'Invalid username or password.' });
  const token = createToken(user.id);
  res.json({ id: user.id, username: user.username, token, stats: user.stats, ...getEconomy(user.id) });
});

export interface AuthRequest extends Request {
  userId: string;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const userId = verifyTokenGetUserId(token);
  if (!userId) return res.status(401).json({ error: 'Invalid token' });
  (req as AuthRequest).userId = userId;
  next();
}

// Returns the authenticated user's profile and stats (used by the client on load/refresh).
authRouter.get('/api/me', requireAuth, (req: Request, res: Response) => {
  const user = findById((req as AuthRequest).userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({
    id: user.id,
    username: user.username,
    stats: user.stats,
    achievements: getAchievements(user.id),
    createdAt: user.createdAt,
    isAdmin: !!process.env.ADMIN_USERNAME && user.username === process.env.ADMIN_USERNAME,
    ...getEconomy(user.id),
  });
});

// Returns a player's move-tendency model for autoplay.
authRouter.get('/api/ml/:userId', requireAuth, (req: Request, res: Response) => {
  res.json(getPlayerProfile(String(req.params.userId)));
});
