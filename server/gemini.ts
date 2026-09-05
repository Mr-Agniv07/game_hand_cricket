// Optional, FREE Gemini "commentary" layer for bot tournaments — completely separate
// from the Claude news. It adds three bits of flavour per tournament:
//   • a bold Pundit's take when the field is set (during the bidding window),
//   • a story-style Recap + Player-of-the-Tournament when it finishes.
// All grounded in real data (never fabricate results, never reveal bot personalities);
// if GEMINI_API_KEY is missing or a call fails, it silently adds nothing. Fires only a
// couple of times per tournament — well within Gemini's free tier.

import type { BotStory } from '@cric/types';

const MODEL = 'gemini-2.0-flash';
const endpoint = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

const stories = new Map<string, BotStory>();

/** The cached AI story for a tournament (pundit/recap/potm), or null. */
export function getBotStory(tournamentId: string): BotStory | null {
  return stories.get(tournamentId) ?? null;
}

/** Low-level Gemini call; returns the text, or null on no-key / error. */
async function callGemini(system: string, user: string, maxTokens: number): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(endpoint(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.9 },
      }),
    });
    if (!res.ok) {
      console.error(`[gemini] HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return text.trim() || null;
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
    const text = await callGemini(PUNDIT_SYSTEM, dataText, 120);
    if (text) stories.set(tournamentId, { ...stories.get(tournamentId), pundit: text });
  })();
}

/** Generate the recap + player-of-the-tournament when a league finishes (one-shot). */
export function genRecapPotm(tournamentId: string, dataText: string): void {
  if (!process.env.GEMINI_API_KEY || stories.get(tournamentId)?.recap) return;
  void (async () => {
    const text = await callGemini(RECAP_SYSTEM, dataText, 260);
    if (!text) return;
    const [recap, potm] = text.split(/^\s*###\s*$/m);
    stories.set(tournamentId, {
      ...stories.get(tournamentId),
      recap: (recap ?? text).trim(),
      potm: potm ? potm.trim() : null,
    });
  })();
}
