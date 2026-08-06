// Admin utility: find a user by (fuzzy) username, or reset their password.
// Passwords are stored as one-way scrypt hashes, so a forgotten password can't be
// read — only reset. Run from the server dir so --env-file=.env supplies DATABASE_URL:
//   pnpm --filter server exec tsx --env-file=.env scripts/reset-password.ts find <term>
//   pnpm --filter server exec tsx --env-file=.env scripts/reset-password.ts reset <username> <newPassword>
import { PrismaClient } from '@prisma/client';
import { scryptSync, randomBytes } from 'crypto';

// Mirrors server/auth/auth.ts hashPassword: "<keyLen>:<salt>:<key>".
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, 32).toString('hex');
  return `32:${salt}:${key}`;
}

const prisma = new PrismaClient();
const [mode, a1, a2] = process.argv.slice(2);

if (mode === 'find') {
  const users = await prisma.user.findMany({
    where: { username: { contains: a1 ?? '', mode: 'insensitive' } },
    select: { username: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`Users matching "${a1}":`);
  for (const u of users) console.log(`  - ${u.username}  (created ${u.createdAt.toISOString().slice(0, 10)})`);
  if (users.length === 0) console.log('  (none)');
} else if (mode === 'reset') {
  if (!a1 || !a2) {
    console.log('Usage: reset <username> <newPassword>');
  } else {
    const user = await prisma.user.findFirst({ where: { username: { equals: a1, mode: 'insensitive' } } });
    if (!user) console.log(`No user found with username "${a1}".`);
    else {
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(a2) } });
      console.log(`✅ Password reset for "${user.username}". New temporary password: ${a2}`);
    }
  }
} else {
  console.log('Usage: find <term>  |  reset <username> <newPassword>');
}

await prisma.$disconnect();
