import { Router } from 'express';
import type { Request, Response } from 'express';
import { STORE_ITEMS, unlockItem } from '../db.ts';
import { requireAuth } from '../auth/routes.ts';
import type { AuthRequest } from '../auth/routes.ts';

export const economyRouter = Router();

// Public: the store catalogue (item ids, labels, prices) so the client can render it.
economyRouter.get('/api/store', (_req: Request, res: Response) => {
  res.json({ items: STORE_ITEMS });
});

// Buy an unlock with coins. Returns the new balance + unlock list on success.
economyRouter.post('/api/unlock', requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthRequest).userId;
  const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : '';
  const result = unlockItem(userId, itemId);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});
