import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: process.stdin, output: process.stdout });

export async function ask(question: string): Promise<string> {
  return (await rl.question(question)).trim();
}

/** Prompts for a positive integer, falling back to `fallback` on blank/invalid input. */
export async function askCount(question: string, fallback: number): Promise<number> {
  const n = parseInt(await ask(question), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface MenuOption {
  key: string;
  label: string;
}

export async function menu(title: string, options: MenuOption[]): Promise<string> {
  console.log(`\n${title}`);
  for (const opt of options) console.log(`  ${opt.key}) ${opt.label}`);
  for (;;) {
    const choice = (await ask('> ')).toLowerCase();
    if (options.some((o) => o.key.toLowerCase() === choice)) return choice;
    console.log('Invalid choice, try again.');
  }
}

export function closePrompt(): void {
  rl.close();
}
