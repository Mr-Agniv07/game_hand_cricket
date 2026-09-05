// Optional, FREE Gemini "commentary" layer for bot tournaments — completely separate
// from the Claude news. It adds three bits of flavour per tournament:
//   • a bold Pundit's take when the field is set (during the bidding window),
//   • a story-style Recap + Player-of-the-Tournament when it finishes.
// All grounded in real data (never fabricate results, never reveal bot personalities);
// if GEMINI_API_KEY is missing or a call fails, it silently adds nothing. Fires only a
// couple of times per tournament — well within Gemini's free tier.

import type { BotStory } from '@cric/types';

// gemini-2.5-flash: the model proven to work cleanly here — no 404, no 400, honours
// thinkingConfig (so no truncation) and returns full sentences. The lite variants got
// either retired (2.5-flash-lite → 404) or rejected the request (flash-lite-latest →
// 400). Rate limits are handled by the serial throttle below (the 429 was a per-minute
// burst, not the model), so 2.5-flash + throttle is the stable choice. If it's ever
// retired, the 404 logging will flag it.
const MODEL = 'gemini-2.5-flash';
const endpoint = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

const stories = new Map<string, BotStory>();
// Per-tournament match previews, keyed by matchIndex. Pre-generated a match ahead so
// they're ready before the (fast) bot matches play.
const previews = new Map<string, Map<number, string>>();

/** The cached AI story for a tournament (pundit/recap/potm), or null. */
export function getBotStory(tournamentId: string): BotStory | null {
  return stories.get(tournamentId) ?? null;
}

/** The cached hype line for a specific match, or null (empty = still generating). */
export function getMatchPreview(tournamentId: string, matchIndex: number): string | null {
  return previews.get(tournamentId)?.get(matchIndex) || null;
}

const PREVIEW_SYSTEM = `You are a punchy cricket pundit for "Cric Flick", a hand-cricket league of named bots. Write ONE short hype line (under 20 words) for the upcoming match, driven by WHAT'S HAPPENING IN THIS TOURNAMENT — current standings/form, momentum, and what's at stake — using the all-time head-to-head only as extra spice. Ground every fact in the data; never invent anything, never mention any bot's playing style. Output only the line — no preamble, no quotes.`;

/** Pre-generate the hype line for one match (one-shot per tournament+match). */
export function genMatchPreview(tournamentId: string, matchIndex: number, dataText: string): void {
  if (!process.env.GEMINI_API_KEY) return;
  let m = previews.get(tournamentId);
  if (m?.has(matchIndex)) return; // already generated or in flight
  if (!m) {
    m = new Map();
    previews.set(tournamentId, m);
  }
  m.set(matchIndex, ''); // reserve (empty) so concurrent calls don't double-fire
  void (async () => {
    const text = await callGemini(PREVIEW_SYSTEM, dataText, 200);
    if (text) m.set(matchIndex, text);
    else m.delete(matchIndex); // failed — allow a later retry
  })();
}

// Serialize all Gemini calls with a minimum gap, so a burst (e.g. a knockout round
// locking = several previews at once) can't exceed the free-tier per-minute limit.
const MIN_GAP_MS = 5000; // ~12 requests/min, safely under the free-tier cap
let lastCallAt = 0;
let gate: Promise<unknown> = Promise.resolve();

/** Low-level Gemini call (throttled); returns the text, or null on no-key / error. */
async function callGemini(system: string, user: string, maxTokens: number): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const run = gate.then(async (): Promise<string | null> => {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return doCall(key, system, user, maxTokens);
  });
  gate = run.catch(() => {}); // keep the queue alive if one call rejects
  return run;
}

async function doCall(key: string, system: string, user: string, maxTokens: number): Promise<string | null> {
  try {
    const res = await fetch(endpoint(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.9,
          // Disable "thinking" — this is a short writing task, and on Gemini 3.x flash
          // thinking is on by default and would eat the whole token budget, leaving no
          // output text (a silent empty response).
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!res.ok) {
      console.error(`[gemini] HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const cand = data.candidates?.[0];
    const text = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    // Only accept a fully-completed response. Anything else (MAX_TOKENS truncation,
    // SAFETY block, …) is dropped rather than shown as a half-finished sentence.
    if (cand?.finishReason && cand.finishReason !== 'STOP') {
      console.error(`[gemini] dropped (finishReason=${cand.finishReason}) — incomplete response`);
      return null;
    }
    if (!text.trim()) {
      console.error(`[gemini] empty response: ${JSON.stringify(data).slice(0, 300)}`);
      return null;
    }
    return text.trim();
  } catch (err) {
    console.error('[gemini] request failed:', (err as Error)?.message ?? err);
    return null;
  }
}

const PUNDIT_SYSTEM = `You are a bold, entertaining cricket pundit for "Cric Flick", a hand-cricket league of named bots. A new tournament's field is set. Give ONE spicy prediction or storyline (1-2 sentences, under 40 words): pick a favourite or an angle and commit to a bold take. Ground every fact (names, numbers, form) in the data given — never invent results. Never mention any bot's playing style or personality. Output only the take, no preamble, no quotes.`;

const RECAP_SYSTEM = `You are a sports writer for "Cric Flick", a hand-cricket league of named bots. A tournament just finished. Using ONLY the data given (never invent names/numbers/results; never mention playing styles), write TWO parts separated by a line containing only "###":
PART 1 — a punchy 2-3 sentence recap of the tournament (drama welcome).
PART 2 — a one-sentence "Player of the Tournament" shout-out naming the standout bot and why.
Output only those two parts and the ### separator, no preamble.`;

/** Generate the pundit's take for a league whose field is now known (one-shot). */
export function genPundit(tournamentId: string, dataText: string): void {
  if (!process.env.GEMINI_API_KEY || stories.get(tournamentId)?.pundit) return;
  void (async () => {
    const text = await callGemini(PUNDIT_SYSTEM, dataText, 200);
    if (text) stories.set(tournamentId, { ...stories.get(tournamentId), pundit: text });
  })();
}

/** Generate the recap + player-of-the-tournament when a league finishes (one-shot). */
export function genRecapPotm(tournamentId: string, dataText: string): void {
  if (!process.env.GEMINI_API_KEY || stories.get(tournamentId)?.recap) return;
  void (async () => {
    const text = await callGemini(RECAP_SYSTEM, dataText, 512);
    if (!text) return;
    const [recap, potm] = text.split(/^\s*###\s*$/m);
    stories.set(tournamentId, {
      ...stories.get(tournamentId),
      recap: (recap ?? text).trim(),
      potm: potm ? potm.trim() : null,
    });
  })();
}
