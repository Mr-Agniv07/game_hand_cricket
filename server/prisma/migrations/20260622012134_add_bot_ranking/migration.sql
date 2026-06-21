-- CreateTable
CREATE TABLE "BotRanking" (
    "id" SERIAL NOT NULL,
    "botName" TEXT NOT NULL,
    "format" INTEGER NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "played" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "ties" INTEGER NOT NULL DEFAULT 0,
    "trophies" INTEGER NOT NULL DEFAULT 0,
    "runsFor" INTEGER NOT NULL DEFAULT 0,
    "runsAgainst" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotRanking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotRanking_botName_format_key" ON "BotRanking"("botName", "format");
