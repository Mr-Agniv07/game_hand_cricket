// Tiny Web Audio sound engine. Every effect is synthesized on the fly — there
// are no audio asset files to ship, so this adds zero weight to the bundle.
//
// Browsers suspend the AudioContext until a user gesture, so call initAudio()
// from the first click/keypress (App wires this up). Mute state is persisted in
// localStorage so it survives reloads.

const MUTE_KEY = 'cric_muted';

let ctx: AudioContext | null = null;
let muted = typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1';

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/** Resume the audio context after a user gesture (autoplay-policy requirement). */
export function initAudio(): void {
  const c = getCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export function isMuted(): boolean {
  return muted;
}

/** Flip mute, persist it, and return the new state. */
export function toggleMute(): boolean {
  muted = !muted;
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // ignore storage failures (private mode etc.) — in-memory state still works
  }
  return muted;
}

interface Tone {
  freq: number;
  dur: number;
  type?: OscillatorType;
  delay?: number;
  vol?: number;
  /** If set, glide the pitch from `freq` to this value over `dur`. */
  sweepTo?: number;
}

function playTones(tones: Tone[]): void {
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const now = c.currentTime;
  for (const t of tones) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    const start = now + (t.delay ?? 0);
    const vol = t.vol ?? 0.16;
    const end = start + t.dur;
    osc.type = t.type ?? 'sine';
    osc.frequency.setValueAtTime(t.freq, start);
    if (t.sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, t.sweepTo), end);
    // Quick attack, exponential decay — avoids clicks and sounds "plucked".
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(vol, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(end + 0.03);
  }
}

// ─── Named effects ─────────────────────────────────────────────────────────

export const sounds = {
  /** Generic UI tap. */
  tap: () => playTones([{ freq: 380, dur: 0.05, type: 'square', vol: 0.07 }]),
  /** Picking a number on the numpad. */
  pick: () => playTones([{ freq: 600, dur: 0.07, type: 'triangle', vol: 0.12 }]),
  /** A normal scoring shot (1–3 runs). */
  run: () =>
    playTones([
      { freq: 523, dur: 0.09, type: 'sine' },
      { freq: 784, dur: 0.11, delay: 0.07, type: 'sine' },
    ]),
  /** A boundary (4 or 6) — brighter, three-note flourish. */
  boundary: () =>
    playTones([
      { freq: 659, dur: 0.09, type: 'triangle' },
      { freq: 880, dur: 0.09, delay: 0.08, type: 'triangle' },
      { freq: 1175, dur: 0.14, delay: 0.16, type: 'triangle', vol: 0.18 },
    ]),
  /** Wicket — a downward "thud". */
  out: () => playTones([{ freq: 300, dur: 0.32, type: 'sawtooth', sweepTo: 70, vol: 0.22 }]),
  /** Coin toss flip — a quick rising whir. */
  toss: () => playTones([{ freq: 400, dur: 0.45, type: 'triangle', sweepTo: 900, vol: 0.12 }]),
  /** Innings break. */
  inningsEnd: () =>
    playTones([
      { freq: 440, dur: 0.12 },
      { freq: 587, dur: 0.16, delay: 0.1 },
    ]),
  /** Victory fanfare. */
  win: () =>
    playTones([
      { freq: 523, dur: 0.13, type: 'triangle' },
      { freq: 659, dur: 0.13, delay: 0.12, type: 'triangle' },
      { freq: 784, dur: 0.13, delay: 0.24, type: 'triangle' },
      { freq: 1047, dur: 0.3, delay: 0.36, type: 'triangle', vol: 0.2 },
    ]),
  /** Defeat — a descending sigh. */
  lose: () =>
    playTones([
      { freq: 440, dur: 0.18, type: 'sine' },
      { freq: 349, dur: 0.18, delay: 0.16, type: 'sine' },
      { freq: 262, dur: 0.34, delay: 0.32, type: 'sine', vol: 0.18 },
    ]),
  /** Tie — two equal, neutral notes. */
  tie: () =>
    playTones([
      { freq: 494, dur: 0.16 },
      { freq: 494, dur: 0.22, delay: 0.18 },
    ]),
};

export type SoundName = keyof typeof sounds;
