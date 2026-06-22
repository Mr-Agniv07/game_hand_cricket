import { Router } from 'express';
import type { Request, Response } from 'express';
import { getBotRankings, getBotTournaments } from '../db.ts';
import { activeBotLeagues, recentBotLeagues } from '../tournament/handlers.ts';
import type { BotLeagueData } from '@cric/types';

export const botLeagueRouter = Router();

// Public: anyone (even guests) can view bot rankings, watch ongoing bot leagues,
// and browse past tournaments. Rankings are per format (5 / 10 overs); `active`
// lists in-progress leagues (live view), `recent` the just-finished ones, and
// `history` the durable record of completed tournaments with their winners.
botLeagueRouter.get('/api/bot-league', (_req: Request, res: Response) => {
  const data: BotLeagueData = {
    rankings: { 5: getBotRankings(5), 10: getBotRankings(10) },
    active: activeBotLeagues(),
    recent: recentBotLeagues(),
    history: getBotTournaments(),
  };
  res.json(data);
});
