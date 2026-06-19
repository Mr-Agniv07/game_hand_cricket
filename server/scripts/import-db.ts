// One-time migration: copy the legacy file database (server/db.json) into
// Postgres. Idempotent — re-running upserts users and resets their match
// history / friendships, so it won't create duplicates.
//
// Run from the server package once DATABASE_URL points at your DB:
//   pnpm --filter server run import:db
//
// ML profiles are intentionally NOT imported: the adaptive bot now rebuilds its
// models from the ball-event log, which starts empty after migration (the bot
// simply re-learns from new games).

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const __dir = dirname(fileURLToPath(import.meta.url));
const DB_JSON = process.env.DB_JSON || join(__dir, '..', 'db.json');

interface LegacyStats {
  [k: string]: number | undefined;
}
interface LegacyUser {
  id: string;
  username: string;
  passwordHash: string;
  token?: string | null;
  createdAt?: string;
  stats?: LegacyStats;
  achievements?: LegacyStats;
  matchHistory?: Array<{
    opponent: string;
    result: string;
    myScore: number;
    oppScore: number;
    overs?: number;
    wickets?: number;
    date?: string;
  }>;
  friends?: string[];
}
interface LegacyRecord {
  value: number;
  holderName: string;
  holderId?: string | null;
  wickets?: number;
  date?: string;
}
interface LegacyDb {
  users?: LegacyUser[];
  records?: { byOvers?: Record<string, Record<string, LegacyRecord | null>> };
}

const RECORD_TYPES = ['fastest50', 'fastest100', 'highestTotal', 'lowestTotal'] as const;

async function main(): Promise<void> {
  if (!existsSync(DB_JSON)) {
    console.log(`No db.json at ${DB_JSON} — nothing to import.`);
    return;
  }
  const db = JSON.parse(readFileSync(DB_JSON, 'utf8')) as LegacyDb;
  const users = db.users ?? [];

  for (const u of users) {
    const s = u.stats ?? {};
    const a = u.achievements ?? {};
    const scalar = {
      username: u.username,
      passwordHash: u.passwordHash,
      token: u.token ?? null,
      createdAt: u.createdAt ? new Date(u.createdAt) : new Date(),
      gamesPlayed: s.gamesPlayed ?? 0,
      wins: s.wins ?? 0,
      losses: s.losses ?? 0,
      ties: s.ties ?? 0,
      runsScored: s.runsScored ?? 0,
      highScore: s.highScore ?? 0,
      wicketsTaken: s.wicketsTaken ?? 0,
      boundaries: s.boundaries ?? 0,
      ballsBowled: s.ballsBowled ?? 0,
      runsConceded: s.runsConceded ?? 0,
      tournamentsPlayed: a.tournamentsPlayed ?? 0,
      tournamentsWon: a.tournamentsWon ?? 0,
      orangeCaps: a.orangeCaps ?? 0,
      purpleCaps: a.purpleCaps ?? 0,
      mostSixesAwards: a.mostSixesAwards ?? 0,
      playerOfTournament: a.playerOfTournament ?? 0,
    };
    await prisma.user.upsert({
      where: { id: u.id },
      create: { id: u.id, ...scalar },
      update: scalar,
    });

    await prisma.matchHistory.deleteMany({ where: { userId: u.id } });
    const history = u.matchHistory ?? [];
    if (history.length) {
      await prisma.matchHistory.createMany({
        data: history.map((m) => ({
          userId: u.id,
          opponent: m.opponent,
          result: m.result,
          myScore: m.myScore,
          oppScore: m.oppScore,
          overs: m.overs ?? 1,
          wickets: m.wickets ?? 1,
          date: m.date ? new Date(m.date) : new Date(),
        })),
      });
    }
  }

  // Friendships after every user exists.
  for (const u of users) {
    await prisma.friendship.deleteMany({ where: { userId: u.id } });
    const edges = (u.friends ?? []).map((friendId) => ({ userId: u.id, friendId }));
    if (edges.length) await prisma.friendship.createMany({ data: edges, skipDuplicates: true });
  }

  // Global records (only present in newer db.json files).
  const byOvers = db.records?.byOvers ?? {};
  let recordCount = 0;
  for (const [oversKey, bucket] of Object.entries(byOvers)) {
    const overs = Number(oversKey);
    for (const type of RECORD_TYPES) {
      const rec = bucket?.[type];
      if (!rec) continue;
      const data = {
        value: rec.value,
        holderName: rec.holderName,
        holderId: rec.holderId ?? null,
        wickets: rec.wickets ?? overs,
        date: rec.date ? new Date(rec.date) : new Date(),
      };
      await prisma.globalRecord.upsert({
        where: { overs_type: { overs, type } },
        create: { overs, type, ...data },
        update: data,
      });
      recordCount++;
    }
  }

  console.log(`Imported ${users.length} users and ${recordCount} global records from ${DB_JSON}.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('Import failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
