// Optional LLM "flavour" layer over the deterministic League News headlines.
//
// generateBotNews() in db.ts produces accurate, fact-derived headlines. This module
// takes those exact facts and, IF an ANTHROPIC_API_KEY is configured, asks the
// cheapest Claude model (Haiku) to rewrite each into a punchier line — WITHOUT
// changing any name or number. The result is cached and served to everyone.
//
// Cost control (the whole point): the API is called ONLY when the underlying facts
// actually change (a tournament finishes) — never on the 3s poll — plus a 2-minute
// floor and an in-flight guard. So a busy day costs a few cents at most; with no key
// (or on any error) the page silently uses the deterministic headlines.

import Anthropic from '@anthropic-ai/sdk';

// Cheapest model, chosen deliberately so the credit lasts effectively forever.
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 550;

const SYSTEM = `You are a witty, sharp sports journalist covering "Cric Flick", a hand-cricket league played by 16 named bots (formats: 5-over, 10-over, and a 16-bot Super League; each season resets the standings).

Below is the CURRENT, TRUE state of the league as raw data. Write 8-10 short, engaging news headlines from it — like a lively sports ticker. You have FULL creative freedom: pick the juiciest angles, add drama, colour and light punditry, and combine facts into a story if it reads better.

HARD RULES (non-negotiable):
- Every FACTUAL claim — bot names, numbers, scores, results, records, standings — must come straight from the data below. NEVER invent or change a name, number, or result. If it's not in the data, don't state it as fact.
- Opinion and flavour are welcome ("the pressure is mounting", "a stunning collapse", "can anyone stop them?") — but never dress up an invented fact as real.
- If the data is thin, write fewer items rather than padding with made-up ones.
- Never mention, guess, or hint at any bot's playing style or "personality" — only results and stats.
- Output ONLY the headlines: one per line, each starting with a fitting emoji, each under ~20 words. No numbering, no intro, no sign-off.`;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null; // no key → deterministic fallback
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}

let llmNews: string[] | null = null; // last successful rewrite (served to all viewers)
let lastChangeKey = ''; // the "new tournament/season" key the current rewrite was for
let inFlight = false; // a rewrite is currently running

/** The cached LLM-rewritten headlines, or null if none yet (caller falls back). */
export function getLlmNews(): string[] | null {
  return llmNews;
}

/**
 * Trigger a rewrite ONLY when `changeKey` differs from the last one — i.e. when a new
 * tournament (or season) has landed, NOT on every poll or intermediate match. Safe to
 * call on every request: it's a cheap no-op unless the key changed. So the API is hit
 * roughly once per completed tournament (plus once after a restart to rebuild the cache).
 */
export function maybeRefreshLlmNews(context: string, changeKey: string): void {
  const c = getClient();
  if (!c) return;
  if (changeKey === lastChangeKey || inFlight) return; // nothing newsworthy / already running
  lastChangeKey = changeKey; // claim synchronously so concurrent requests can't double-fire
  inFlight = true;
  void rewrite(c, context);
}

async function rewrite(c: Anthropic, context: string): Promise<void> {
  try {
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Here is the current league data. Write the news.\n\n${context}` }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length >= 2) llmNews = lines; // only accept a sane rewrite
    console.log(
      `[news] Haiku rewrite ok — in=${resp.usage.input_tokens} out=${resp.usage.output_tokens} lines=${lines.length}`
    );
  } catch (err) {
    // Leave llmNews as-is (deterministic fallback covers the gap). lastChangeKey stays
    // set to this attempt so a failure doesn't retry-loop; the next completed tournament
    // (or a server restart) tries again.
    console.error('[news] Haiku rewrite failed — using deterministic headlines:', (err as Error)?.message ?? err);
  } finally {
    inFlight = false;
  }
}
