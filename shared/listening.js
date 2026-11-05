// Listening ahead: what to transcribe next, and how transcribed words become
// segments. Pure functions, shared by the speech worker (extension/src/listen)
// and the tests.
//
// The speech worker holds the audio the player has buffered, decoded to
// 16 kHz mono, as time ranges on the media clock. planWindow picks the next
// window to transcribe: the first stretch ahead of the playhead that has
// audio but no transcript yet, up to HORIZON seconds ahead, at most
// MAX_WINDOW long (Whisper's limit is 30 s). Words come back with their own
// times; wordsToCues groups them into phrases at pauses and listeningSegments
// runs the subtitle analyzer on them, with confidences that allow for
// mishearing.

import { analyzeCues } from './analyzer.js';

export const HORIZON = 90; // seconds ahead of the playhead worth transcribing
export const MAX_WINDOW = 28; // seconds per window (the model takes at most 30)
export const MIN_WINDOW = 6; // shorter windows wait for more audio, unless that is all there will be
export const OVERLAP = 0.6; // seconds of the previous window repeated, so a word cut at the boundary is heard whole

/**
 * How sure a mute from listening is. A recogniser mishears (a mild word most
 * of all: "hell" for "help"), so mild words stay suggestions at the default
 * 60% bar, and strong ones clear it.
 */
export const LISTEN_CONFIDENCE = (severity) => (severity >= 3 ? 0.85 : severity === 2 ? 0.75 : 0.5);
export const LISTEN_HINT_SCALE = 0.7;

/** Ranges [[start, end], …] sorted and merged (touching within `gap`). */
export function mergeRanges(ranges, gap = 0.05) {
  const out = [];
  for (const [s, e] of [...ranges].filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + gap) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** The parts of `ranges` not covered by `minus`. */
export function subtractRanges(ranges, minus) {
  let out = mergeRanges(ranges);
  for (const [ms, me] of mergeRanges(minus)) {
    const next = [];
    for (const [s, e] of out) {
      if (me <= s || ms >= e) next.push([s, e]);
      else {
        if (ms > s) next.push([s, ms]);
        if (me < e) next.push([me, e]);
      }
    }
    out = next;
  }
  return out.filter(([s, e]) => e - s > 0.05);
}

/**
 * The next window to transcribe, or null when there is nothing useful to do.
 * @param {object} o
 * @param {Array<[number,number]>} o.audio   decoded audio available, on the media clock
 * @param {Array<[number,number]>} o.done    already transcribed
 * @param {number} o.playhead
 * @param {boolean} [o.complete]             no more audio will arrive (end of stream)
 * @returns {{ start: number, end: number, from: number }|null}
 *   transcribe [from, end); words before `start` belong to the previous window
 */
export function planWindow({ audio, done, playhead, complete = false, horizon = HORIZON, max = MAX_WINDOW, min = MIN_WINDOW }) {
  const limit = playhead + horizon;
  const ahead = subtractRanges(audio.map(([s, e]) => [Math.max(s, playhead - 0.5), Math.min(e, limit)]), done);
  for (const [s, e] of ahead) {
    const avail = mergeRanges(audio).find(([a, b]) => a <= s + 0.01 && b >= s);
    const runsOn = avail && avail[1] > e + 0.01; // more audio right after (beyond the horizon or already transcribed)
    const len = Math.min(max, e - s);
    if (len < min && !runsOn && !complete && e < limit - 0.01) continue; // wait for the player to buffer more
    if (len < 0.3) continue;
    const prevDone = done.some(([, de]) => Math.abs(de - s) < 0.06);
    const from = prevDone ? Math.max(avail ? avail[0] : s, s - OVERLAP) : s;
    return { start: s, end: s + len, from };
  }
  return null;
}

/**
 * Words (times relative to the window, which began at `offset` on the media
 * clock) → cues: phrases split at pauses longer than `gap` or at `maxLen` s.
 * Words that start before `keepFrom` were already heard in the previous window.
 */
export function wordsToCues(words, offset = 0, { gap = 0.7, maxLen = 8, keepFrom = -Infinity } = {}) {
  const cues = [];
  let cur = null;
  for (const w of words) {
    const text = String(w.text || '').trim();
    if (!text || !Number.isFinite(w.start)) continue;
    const start = offset + w.start;
    const end = offset + Math.max(w.start, Number.isFinite(w.end) ? w.end : w.start + 0.3);
    if (start < keepFrom) continue;
    if (!cur || start - cur.end > gap || end - cur.start > maxLen) {
      cur = { start, end, text: '', words: [] };
      cues.push(cur);
    }
    cur.words.push({ text, start, end });
    cur.text = cur.text ? `${cur.text} ${text}` : text;
    cur.end = Math.max(cur.end, end);
  }
  return cues;
}

/** Segments from heard cues: profanity muted at the word, scene hints at reduced confidence. */
export function listeningSegments(cues, { languageMode = 'line' } = {}) {
  return analyzeCues(cues, {
    languageMode,
    source: 'listening',
    timedPad: 0.12,
    languageConfidence: LISTEN_CONFIDENCE,
    hintScale: LISTEN_HINT_SCALE,
  });
}

/**
 * Whisper sometimes "hears" stock phrases in silence or music, or repeats a
 * phrase until the window ends. Drop those words.
 */
export function dropHallucinations(words) {
  const out = [];
  for (const w of words) {
    const t = String(w.text || '').trim();
    if (!t) continue;
    if (/^\[?(blank_audio|music|silence|inaudible)\]?$/i.test(t.replace(/[.\s]/g, '_').replace(/_+/g, '_'))) continue;
    out.push(w);
  }
  // A run of the same 1–4 words repeated more than twice is a loop, not speech.
  for (let n = 1; n <= 4; n++) {
    for (let i = 0; i + 3 * n <= out.length; i++) {
      const key = (k) => out.slice(k, k + n).map((w) => w.text.toLowerCase().replace(/[^a-z']/g, '')).join(' ');
      const base = key(i);
      if (!base) continue;
      let reps = 1;
      while (i + (reps + 1) * n <= out.length && key(i + reps * n) === base) reps++;
      if (reps > 2) out.splice(i + n, (reps - 1) * n);
    }
  }
  return out;
}
