-- ── Career (lifetime) totals on BotRanking ──
ALTER TABLE "BotRanking"
  ADD COLUMN "careerPlayed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "careerWins" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "careerLosses" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "careerTies" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "careerTrophies" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "careerRunsFor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "careerRunsAgainst" INTEGER NOT NULL DEFAULT 0;

-- Seed career totals from the stats accumulated so far (all of it belongs to Season 1).
UPDATE "BotRanking" SET
  "careerPlayed" = "played",
  "careerWins" = "wins",
  "careerLosses" = "losses",
  "careerTies" = "ties",
  "careerTrophies" = "trophies",
  "careerRunsFor" = "runsFor",
  "careerRunsAgainst" = "runsAgainst";

-- ── Seasons ──
CREATE TABLE "BotSeason" (
  "id" SERIAL NOT NULL,
  "number" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  "leagues5" INTEGER NOT NULL DEFAULT 0,
  "leagues10" INTEGER NOT NULL DEFAULT 0,
  "leaguesSuper" INTEGER NOT NULL DEFAULT 0,
  "champion" TEXT,
  "championTrophies" INTEGER,
  "standings" JSONB,
  CONSTRAINT "BotSeason_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BotSeason_number_key" ON "BotSeason"("number");

-- Open Season 1 (its league counters start now; the stats so far are its running total).
INSERT INTO "BotSeason" ("number") VALUES (1);
