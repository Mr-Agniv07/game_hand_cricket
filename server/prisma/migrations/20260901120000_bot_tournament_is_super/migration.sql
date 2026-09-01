-- Flag Super Leagues explicitly so the server never has to read the full (large)
-- state JSON at boot just to identify them. Backfill from the stored state size (16).
ALTER TABLE "BotTournament" ADD COLUMN "isSuperLeague" BOOLEAN NOT NULL DEFAULT false;
UPDATE "BotTournament" SET "isSuperLeague" = true
  WHERE "state" IS NOT NULL AND ("state" ->> 'size') = '16';
