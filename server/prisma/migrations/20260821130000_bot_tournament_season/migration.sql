-- Tag each stored bot tournament with its season. All existing history predates
-- seasons, so it belongs to Season 1 (the default).
ALTER TABLE "BotTournament" ADD COLUMN "season" INTEGER NOT NULL DEFAULT 1;
