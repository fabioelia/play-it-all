// The speech worker (a module worker of the offscreen document): turns the
// audio a player has buffered into mute segments before it plays.
//
// The audio worker (audio-worker.js) sends it 16 kHz mono PCM on the media
// clock, per tab ("session") and per MediaSource ("source"). While a video
// plays, this worker transcribes the next window ahead of the playhead
// (shared/listening.js planWindow) with the speech model (recognizer.js).
// Words become segments with the subtitle analyzer; only the segments, never
// the words or the audio, go back to the tab.
//
// One model, one thread, one window at a time, for every tab: the most
// recently playing tab goes first. Paused tabs, and tabs whose video plays
// an ad, are left alone.
//
// Messages in, from offscreen.js: { type: 'config', wasmPaths, model, threads } | { type: 'port' } (the audio worker)
//   { sid, type: 'open' | 'close' | 'reset' | 'select' | 'clock' | 'settings', … }
// From the audio worker: { sid, type: 'pcm', source, start, samples } | { sid, type: 'complete' | 'select', source }
// Out, to the tab: { sid, type: 'segments', … } | { sid, type: 'status', state, detail? } | { sid, type: 'diag', … }

import { dropHallucinations, listeningSegments, mergeRanges, planWindow, subtractRanges, wordsToCues } from '../../../shared/listening.js';
import { MODELS } from './models.js';
import { PcmStore, MODEL_RATE, quietCut, rms } from './audio.js';
import { loadRecognizer } from './recognizer.js';

const SILENCE = 0.004; // RMS below this (about −48 dBFS) is not worth transcribing
const KEEP_BEHIND = 20; // seconds of played audio kept (for a short seek back)
// Right after a start or a seek, a shorter first window gets the next seconds
// heard sooner. Not much shorter: each window costs about 2 s of encoder time
// whatever its length (Whisper pads to 30 s), and very short ones lose
// sentences (see unheard()).
const FIRST_WINDOW = 16;

let config = null;
let recognizer = null;
let loading = null;
const sessions = new Map();
let current = null; // the window being transcribed: { s, start, end, cancelled }

const post = (sid, msg) => postMessage({ sid, ...msg });
const status = (s, state, detail) => {
  if (s.state === state && s.detail === detail) return;
  s.state = state;
  s.detail = detail;
  post(s.sid, { type: 'status', state, detail });
};

function session(sid) {
  let s = sessions.get(sid);
  if (!s) {
    s = { sid, sources: new Map(), selected: null, lastFed: null, playhead: 0, paused: true, ad: false, clockAt: 0, state: null, detail: null, windows: [] };
    sessions.set(sid, s);
  }
  return s;
}

function sourceOf(s, id) {
  let src = s.sources.get(id);
  if (!src) {
    src = { id, heard: [], words: [], segmentsSent: '', complete: false, pcm: new PcmStore() };
    s.sources.set(id, src);
  }
  return src;
}

// ---- the speech model ----------------------------------------------------------------

async function ensureRecognizer(s) {
  if (recognizer) return recognizer;
  if (!loading) {
    const model = MODELS[config.model];
    loading = loadRecognizer(model, { wasmPaths: config.wasmPaths, threads: config.threads || 1 })
      .then((r) => (recognizer = r))
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  status(s, 'loading');
  return loading;
}

// ---- scheduling ------------------------------------------------------------------------

function activeSource(s) {
  const id = s.selected ?? s.lastFed;
  return id == null ? null : s.sources.get(id) || null;
}

const playheadOf = (s) => s.playhead + (s.paused ? 0 : (performance.now() - s.clockAt) / 1000); // it kept playing since the last clock

/** The session to work for next: playing, not in an ad, most recently heard from. */
function nextJob() {
  let best = null;
  for (const s of sessions.values()) {
    if (s.paused || s.ad) continue;
    const src = activeSource(s);
    if (!src) continue;
    const playhead = playheadOf(s);
    src.pcm.dropBefore(playhead - KEEP_BEHIND);
    const audio = mergeRanges(src.pcm.ranges());
    // The end of the stream: no more audio will come, so a short last window is worth hearing.
    const complete = src.complete || (Number.isFinite(s.duration) && audio.length > 0 && audio[audio.length - 1][1] >= s.duration - 0.3);
    const plan = planWindow({ audio, done: src.heard, playhead, complete });
    if (!plan) {
      if (recognizer) status(s, audio.length ? 'listening' : 'waiting', heardTo(src, playhead));
      continue;
    }
    // Right after a start or seek: a short first window gets the next seconds heard sooner.
    if (plan.start < playhead + 3 && plan.end - plan.start > FIRST_WINDOW && !src.heard.some(([a, b]) => a <= playhead && b > playhead)) plan.end = plan.start + FIRST_WINDOW;
    if (!best || s.clockAt > best.s.clockAt) best = { s, src, plan };
  }
  return best;
}

function heardTo(src, playhead) {
  const r = mergeRanges(src.heard, 0.7).find(([a, b]) => a <= playhead + 1 && b >= playhead);
  return r ? r[1] : null;
}

let running = false;
let again = false;
function wake() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  again = false;
  setTimeout(pump, 0);
}

async function pump() {
  try {
    for (;;) {
      const job = nextJob();
      if (!job) break;
      await runWindow(job);
      await new Promise((r) => setTimeout(r, 0)); // let audio and clocks in
    }
  } catch (e) {
    for (const s of sessions.values()) status(s, 'error', String(e?.message || e).slice(0, 200));
  } finally {
    running = false;
    if (again) wake();
  }
}

async function runWindow({ s, src, plan }) {
  const rec = await ensureRecognizer(s);
  let { start, end, from } = plan;
  // Begin at a quiet moment too: a window that starts in the middle of a word
  // mishears it. Look back up to 1.5 s (into audio that is there).
  const availFrom = mergeRanges(src.pcm.ranges()).find(([a, b]) => a <= from + 0.01 && b >= from)?.[0] ?? from;
  if (from - availFrom > 0.3) {
    const back = Math.min(1.5, from - availFrom);
    from = from - back + quietCut(src.pcm.read(from - back, from), back, back);
  }
  let audio = src.pcm.read(from, end);
  // End at a quiet moment, unless this window runs to the end of what is buffered.
  const bufferedEnd = mergeRanges(src.pcm.ranges()).find(([a, b]) => a <= end && b >= end)?.[1] ?? end;
  if (bufferedEnd > end + 0.5 && end - from > 6) {
    const cut = quietCut(audio, end - from);
    if (cut > (end - from) - 3) {
      end = from + cut;
      audio = audio.subarray(0, Math.round(cut * MODEL_RATE));
    }
  }
  const level = rms(audio);
  const t0 = performance.now();
  let heardWords = 0;
  let minus = [];
  if (level >= SILENCE) {
    status(s, 'listening', heardTo(src, s.playhead));
    // A seek away from this window (or the tab closing) stops it at the next
    // token: inference yields to this worker's messages between model calls
    // (recognizer.js), so the new place is heard after one more step.
    const job = (current = { s, start: from, end, cancelled: false });
    const { words } = await rec.transcribe(audio, { cancelled: () => job.cancelled });
    current = null;
    if (job.cancelled) {
      s.windows = [...s.windows.slice(-11), { from: +from.toFixed(2), start: +start.toFixed(2), end: +end.toFixed(2), cancelled: true, ms: Math.round(performance.now() - t0) }];
      return; // not heard: the planner comes back to it if it is still ahead
    }
    if (sessions.get(s.sid) !== s || s.sources.get(src.id) !== src) return; // closed or reset meanwhile
    const kept = dropHallucinations(words)
      .map((w) => ({ text: w.text, start: from + w.start, end: from + w.end }))
      .filter((w) => w.start >= start - 0.05 && w.start < end);
    src.words = [...src.words.filter((w) => w.start < start - 0.05 || w.start >= end), ...kept].sort((a, b) => a.start - b.start);
    heardWords = kept.length;
    minus = unheard(audio, from, start, end, kept);
  }
  src.heard = mergeRanges([...src.heard, ...subtractRanges([[start, end]], minus)]);
  // For the debug log: what was done, never what was said.
  s.windows = [...s.windows.slice(-11), { from: +from.toFixed(2), start: +start.toFixed(2), end: +end.toFixed(2), level: +level.toFixed(4), words: heardWords, ms: Math.round(performance.now() - t0) }];
  sendSegments(s, src);
}

/**
 * Stretches of a window that sound like speech but produced no words: after
 * the last word (Whisper sometimes ends a short window early, leaving its
 * last sentence out) and in long gaps between words. They are not marked as
 * heard, so the next window starts there. A window with no words at all is
 * heard (music, noise), so listening always moves on.
 */
function unheard(audio, from, start, end, words) {
  const out = [];
  if (!words.length) return out;
  const level = (a, b) => rms(audio, Math.max(0, Math.round((a - from) * MODEL_RATE)), Math.min(audio.length, Math.round((b - from) * MODEL_RATE)));
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i].end + 0.3;
    const b = words[i + 1].start - 0.3;
    if (b - a > 1.9 && level(a, b) >= 2 * SILENCE) out.push([a, b]);
  }
  const last = Math.max(start + 0.5, words[words.length - 1].end + 0.3);
  if (end - last > 1.5 && level(last, end) >= 2 * SILENCE) out.push([last, end]);
  return out;
}

const r2 = (ranges) => ranges.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]);

function sendSegments(s, src) {
  const segments = listeningSegments(wordsToCues(src.words), { languageMode: s.languageMode });
  const key = JSON.stringify(segments.map((g) => [g.id, g.end, g.severity]));
  const until = heardTo(src, s.playhead);
  post(s.sid, { type: 'segments', source: src.id, segments, heardTo: until, words: src.words.length, windows: s.windows, changed: key !== src.segmentsSent });
  src.segmentsSent = key;
  status(s, 'listening', until);
}

// ---- messages ----------------------------------------------------------------------------

function onAudio({ data: m }) {
  if (!m || !sessions.has(m.sid)) return;
  const s = sessions.get(m.sid);
  if (m.type === 'pcm') {
    sourceOf(s, m.source).pcm.add(m.start, MODEL_RATE, m.samples);
    s.lastFed = m.source;
    wake();
  } else if (m.type === 'complete') {
    sourceOf(s, m.source).complete = true;
    wake();
  } else if (m.type === 'select') {
    s.selected = m.source;
    wake();
  }
}

self.onmessage = ({ data: m }) => {
  if (!m) return;
  if (m.type === 'config') {
    config = m;
    return;
  }
  if (m.type === 'port') {
    m.port.onmessage = onAudio;
    return;
  }
  const s = session(m.sid);
  switch (m.type) {
    case 'open':
      s.languageMode = m.languageMode;
      return;
    case 'close':
      if (current?.s === s) current.cancelled = true;
      sessions.delete(m.sid);
      return;
    case 'reset': // a new title in the same tab: forget what was heard
      if (current?.s === s) current.cancelled = true;
      for (const src of s.sources.values()) {
        src.heard = [];
        src.words = [];
        src.segmentsSent = '';
      }
      s.state = null;
      return;
    case 'select':
      s.selected = m.source;
      wake();
      return;
    case 'clock': {
      const expected = playheadOf(s);
      const jumped = Math.abs(m.time - expected) > 3;
      s.playhead = m.time;
      s.paused = !!m.paused;
      s.ad = !!m.ad;
      if (Number.isFinite(m.duration)) s.duration = m.duration;
      s.clockAt = performance.now();
      // Sought away from the window being heard, to a place not heard yet:
      // stop that window and hear the new place first. (A window that covers
      // what plays next is the right one to finish.)
      if (jumped && current?.s === s) {
        const coversNext = current.start <= m.time + 3 && current.end > m.time + 1;
        const src = activeSource(s);
        const ready = src && mergeRanges(src.heard, 0.7).some(([a, b]) => a <= m.time + 0.5 && b >= m.time + 8);
        if (!coversNext && !ready) current.cancelled = true;
      }
      if (s.paused && s.state === 'listening') status(s, 'paused', s.detail);
      wake();
      return;
    }
    case 'settings':
      s.languageMode = m.languageMode;
      for (const src of s.sources.values()) if (src.words.length) sendSegments(s, src);
      return;
    default:
  }
};

// Where each session stands, for the debug log and the tests (times only).
setInterval(() => {
  for (const s of sessions.values()) {
    const src = activeSource(s);
    if (!src) continue;
    post(s.sid, { type: 'diag', audio: r2(mergeRanges(src.pcm.ranges())), heard: r2(mergeRanges(src.heard, 0.7)), busy: current?.s === s ? [+current.start.toFixed(2), +current.end.toFixed(2)] : null, playhead: +s.playhead.toFixed(2) });
  }
}, 2000);
