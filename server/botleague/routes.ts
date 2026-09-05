import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getBotRankings,
  getBotTournaments,
  getBotSeasonInfo,
  generateBotNews,
  getBotNewsContext,
} from '../db.ts';
import { maybeRefreshLlmNews, getLlmNews } from '../news.ts';
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
  const news = generateBotNews(); // deterministic, always-accurate — the fallback
  const history = getBotTournaments();
  const season = getBotSeasonInfo();
  // Feed the AI the raw league DATA (not the headlines) so it writes freely. Refresh
  // ONLY when a new tournament (or season) lands — the coarse key = latest tournament's
  // name + finish time + season number, which changes exactly on a completed tournament.
  const latest = history[0];
  maybeRefreshLlmNews(getBotNewsContext(), `${latest?.name ?? ''}|${latest?.finishedAt ?? ''}|${season.number}`);
  const data: BotLeagueData = {
    rankings: { 5: getBotRankings(5), 10: getBotRankings(10) },
    active: activeBotLeagues(userId),
    recent: recentBotLeagues(),
    history,
    season,
    // Deterministic, always-accurate facts. If a Claude key is configured, the cached
    // LLM rewrite (refreshed only when a tournament finishes) replaces them with
    // flavour; otherwise the facts themselves are served.
    news: getLlmNews() ?? news,
  };
  res.json(data);
});
