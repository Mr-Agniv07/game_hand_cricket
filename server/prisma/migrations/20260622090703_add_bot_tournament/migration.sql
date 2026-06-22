-- CreateTable
CREATE TABLE "BotTournament" (
    "id" SERIAL NOT NULL,
    "format" INTEGER NOT NULL,
    "champion" TEXT NOT NULL,
    "runnerUp" TEXT,
    "standings" JSONB NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotTournament_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotTournament_format_idx" ON "BotTournament"("format");
