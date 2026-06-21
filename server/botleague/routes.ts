import { Router } from 'express';
import type { Request, Response } from 'express';
import { getBotRankings } from '../db.ts';
import { activeBotLeagues } from '../tournament/handlers.ts';
import type { BotLeagueData } from '@cric/types';

export const botLeagueRouter = Router();

// Public: anyone (even guests) can view bot rankings and watch ongoing bot
// leagues. Rankings are per format (5 / 10 overs); `active` lists any in-progress
// bot-league tournaments so the client can render a live, read-only view.
botLeagueRouter.get('/api/bot-league', (_req: Request, res: Response) => {
  const data: BotLeagueData = {
    rankings: { 5: getBotRankings(5), 10: getBotRankings(10) },
    active: activeBotLeagues(),
  };
  res.json(data);
});
