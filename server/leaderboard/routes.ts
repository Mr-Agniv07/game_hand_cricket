import { Router } from 'express';
import type { Request, Response } from 'express';
import { getLeaderboard } from '../db.ts';

export const leaderboardRouter = Router();

// Public: anyone (even guests) can view the global standings. The client does
// the per-category ranking from the full stats of every player who has played.
leaderboardRouter.get('/api/leaderboard', (_req: Request, res: Response) => {
  res.json(getLeaderboard());
});
