import { Router } from 'express';
import type { Request, Response } from 'express';
import { findById, getAdminStats } from '../db.ts';
import { requireAuth, type AuthRequest } from '../auth/routes.ts';
import { onlineUsers, adminLiveMatches, queueWaitingCount } from '../game/handlers.ts';
import { adminTournaments } from '../tournament/handlers.ts';
import type { AdminData } from '@cric/types';

export const adminRouter = Router();

/** True if the authenticated user is the configured admin. */
function isAdmin(userId: string): boolean {
  const user = findById(userId);
  return !!process.env.ADMIN_USERNAME && user?.username === process.env.ADMIN_USERNAME;
}

// Admin-only dashboard: aggregate DB stats + every live match and active tournament.
adminRouter.get('/api/admin', requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthRequest).userId;
  if (!isAdmin(userId)) return res.status(403).json({ error: 'Forbidden' });

  const liveMatches = adminLiveMatches();
  const tournaments = adminTournaments();
  const data: AdminData = {
    stats: {
      ...getAdminStats(),
      online: onlineUsers.size,
      liveRooms: liveMatches.length,
      activeTournaments: tournaments.length,
      queueWaiting: queueWaitingCount(),
    },
    liveMatches,
    tournaments,
  };
  res.json(data);
});
