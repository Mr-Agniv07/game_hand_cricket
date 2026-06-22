import { Router } from 'express';
import type { Request, Response } from 'express';
import { getBotRankings, getBotTournaments } from '../db.ts';
import { activeBotLeagues, recentBotLeagues } from '../tournament/handlers.ts';
import { verifyTokenGetUserId } from '../auth/auth.ts';
import type { BotLeagueData } from '@cric/types';

export const botLeagueRouter = Router();

// Public: anyone (even guests) can view bot rankings, watch ongoing bot leagues,
// and browse past tournaments. If a valid auth token is sent, `active` also
// includes the viewer's bid per league. `recent` is just-finished leagues and
// `history` the durable record of completed tournaments with their winners.
botLeagueRouter.get('/api/bot-league', (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const userId = token ? verifyTokenGetUserId(token) : null;
  const data: BotLeagueData = {
    rankings: { 5: getBotRankings(5), 10: getBotRankings(10) },
    active: activeBotLeagues(userId),
    recent: recentBotLeagues(),
    history: getBotTournaments(),
  };
  res.json(data);
});
