-- CreateTable
CREATE TABLE "BotHeadToHead" (
    "id" SERIAL NOT NULL,
    "pair" TEXT NOT NULL,
    "nameA" TEXT NOT NULL,
    "nameB" TEXT NOT NULL,
    "aWins" INTEGER NOT NULL DEFAULT 0,
    "bWins" INTEGER NOT NULL DEFAULT 0,
    "ties" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotHeadToHead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotHeadToHead_pair_key" ON "BotHeadToHead"("pair");
