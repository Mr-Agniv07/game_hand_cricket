import { Router } from 'express';
import type { Request, Response } from 'express';
import { getGlobalRecords, getAchievements } from '../db.ts';
import { requireAuth } from '../auth/routes.ts';
import type { AuthRequest } from '../auth/routes.ts';

export const recordsRouter = Router();

// Public: the global record book (fastest 50/100, highest/lowest total per overs).
// Guests can browse it; the client highlights records the viewer holds by id.
recordsRouter.get('/api/records', (_req: Request, res: Response) => {
  res.json(getGlobalRecords());
});

// The authenticated player's career honours (badges / hall of fame).
recordsRouter.get('/api/achievements', requireAuth, (req: Request, res: Response) => {
  res.json(getAchievements((req as AuthRequest).userId));
});
