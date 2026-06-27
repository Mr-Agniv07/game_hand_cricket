-- Split bot head-to-head by format. Existing rows came from 5-over leagues, so
-- backfill them to format 5, then drop the default (format is always set explicitly).
ALTER TABLE "BotHeadToHead" ADD COLUMN "format" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "BotHeadToHead" ALTER COLUMN "format" DROP DEFAULT;

-- Replace the pair-only unique with a per-format composite unique.
DROP INDEX "BotHeadToHead_pair_key";
CREATE UNIQUE INDEX "BotHeadToHead_pair_format_key" ON "BotHeadToHead"("pair", "format");
