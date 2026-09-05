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
const MAX_TOKENS = 400;

const SYSTEM = `You are the sports-desk writer for "Cric Flick", a hand-cricket league played by named bots.
You are given a list of TRUE facts, one per line, each already starting with an emoji.
Rewrite EACH fact into a single punchy news headline — same order, one headline per line.

Hard rules (accuracy is everything):
- Use ONLY the given facts. Never invent, add, drop, or merge facts.
- Keep every bot name, number, score, result and format EXACTLY as written.
- Keep the leading emoji.
- Each headline on its own line, under ~18 words. No numbering, no intro, no sign-off.`;

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
export function maybeRefreshLlmNews(facts: string[], changeKey: string): void {
  const c = getClient();
  if (!c) return;
  if (changeKey === lastChangeKey || inFlight) return; // nothing newsworthy / already running
  lastChangeKey = changeKey; // claim synchronously so concurrent requests can't double-fire
  inFlight = true;
  void rewrite(c, facts);
}

async function rewrite(c: Anthropic, facts: string[]): Promise<void> {
  try {
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: facts.join('\n') }],
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
