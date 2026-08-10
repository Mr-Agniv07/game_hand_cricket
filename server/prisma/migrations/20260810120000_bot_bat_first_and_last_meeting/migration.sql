-- Batting-first split for each bot (per format) → "win% batting first" insight.
ALTER TABLE "BotRanking" ADD COLUMN "batFirst" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "batFirstWins" INTEGER NOT NULL DEFAULT 0;

-- Most-recent meeting between a bot pair (per format) → "last meet" insight line.
ALTER TABLE "BotHeadToHead" ADD COLUMN "lastWinner" TEXT,
ADD COLUMN "lastMargin" INTEGER,
ADD COLUMN "lastByWickets" BOOLEAN;
