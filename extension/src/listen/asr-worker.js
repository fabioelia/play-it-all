// The speech worker (a module worker of the offscreen document): turns the
// audio a player has buffered into mute segments before it plays.
//
// For each tab ("session") it keeps the audio SourceBuffers the page hook
// reported, demuxes what the player appends (shared/media.js), decodes it with
// WebCodecs, holds it as mono PCM on the media clock (audio.js) and, while the
// video plays, transcribes the next window ahead of the playhead
// (shared/listening.js planWindow) with the speech model (recognizer.js).
// Words become segments with the subtitle analyzer; only the segments, never
// the words or the audio, go back to the tab.
//
// One model, one thread, one window at a time, for every tab: the most
// recently playing tab goes first. Paused tabs, and tabs whose video plays
// an ad, are left alone.
//
// Messages in (from offscreen.js):  { type: 'config', wasmPaths, model, threads }
//   { sid, type: 'open' | 'close' | 'reset' | 'track' | 'append' | 'abort' | 'type' | 'source' | 'select' | 'clock' | 'progressive' | 'settings', … }
// Messages out: { sid, type: 'segments', segments, heardTo, words } | { sid, type: 'status', state, detail? }

import { createDemuxer, containerOf } from '../../../shared/media.js';
import { dropHallucinations, listeningSegments, mergeRanges, planWindow, subtractRanges, wordsToCues } from '../../../shared/listening.js';
import { MODELS } from './models.js';
import { PcmStore, MODEL_RATE, quietCut, rms } from './audio.js';
import { loadRecognizer } from './recognizer.js';
import { progressiveReader } from './progressive.js';

const SILENCE = 0.004; // RMS below this (about −48 dBFS) is not worth transcribing
const KEEP_BEHIND = 20; // seconds of played audio kept (for a short seek back)
const MAX_PCM_BYTES = 96 * 1024 * 1024; // per session
const FIRST_WINDOW = 12; // seconds: right after a start or a seek, hear the next few seconds first

let config = null;
let recognizer = null;
let loading = null;
const sessions = new Map();

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
    s = {
      sid,
      tracks: new Map(), // track id → { source, mime, demuxer, decoder, config, pcm, offset }
      sources: new Map(), // source id → { url, heard: [[s, e]], words: [], pcm (via tracks) }
      selected: null, // source id the <video> plays (null: the most recently fed)
      lastFed: null,
      playhead: 0,
      paused: true,
      ad: false,
      clockAt: 0,
      encrypted: false,
      state: null,
      detail: null,
      progressive: null,
    };
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

// ---- decoding -----------------------------------------------------------------------

function mixDown(data) {
  const n = data.numberOfFrames;
  const ch = data.numberOfChannels;
  const out = new Float32Array(n);
  const tmp = ch > 1 ? new Float32Array(n) : out;
  for (let c = 0; c < ch; c++) {
    data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
    if (ch > 1) for (let i = 0; i < n; i++) out[i] += tmp[i] / ch;
  }
  return out;
}

function openDecoder(s, track) {
  const cfg = track.config;
  if (typeof AudioDecoder !== 'function') {
    status(s, 'unsupported', 'this browser cannot decode audio here (no WebCodecs)');
    return null;
  }
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        sourceOf(s, track.source).pcm.add(data.timestamp / 1e6, data.sampleRate, mixDown(data));
      } finally {
        data.close();
      }
    },
    error: () => {
      track.decoder = null; // reopened on the next append
    },
  });
  const desc = { codec: cfg.codec, sampleRate: cfg.sampleRate, numberOfChannels: cfg.channels || 1 };
  if (cfg.description?.length) desc.description = cfg.description;
  try {
    decoder.configure(desc);
  } catch (e) {
    status(s, 'unsupported', `can’t decode ${cfg.codec} audio`);
    return null;
  }
  return decoder;
}

function feed(s, track, bytes, offset) {
  const r = track.demuxer.push(new Uint8Array(bytes));
  if (r.config) {
    track.config = r.config;
    try { track.decoder?.close(); } catch { /* closed */ }
    track.decoder = null;
    if (r.config.encrypted) {
      s.encrypted = true;
      status(s, 'encrypted');
      return;
    }
    if (!r.config.codec) {
      status(s, 'unsupported', `can’t decode ${r.config.unsupported || 'this'} audio`);
      return;
    }
  }
  if (r.encrypted) {
    s.encrypted = true;
    status(s, 'encrypted');
  }
  if (s.encrypted || !track.config?.codec || !r.frames.length) return;
  track.decoder ||= openDecoder(s, track);
  if (!track.decoder) return;
  for (const f of r.frames) {
    try {
      track.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((f.time + offset) * 1e6), data: f.data }));
    } catch {
      track.decoder = null;
      break;
    }
  }
  s.lastFed = track.source;
  wake();
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

/** The session to work for next: playing, not in an ad, most recently heard from. */
function nextJob() {
  let best = null;
  for (const s of sessions.values()) {
    if (s.paused || s.ad || s.encrypted) continue;
    const src = activeSource(s);
    if (!src) continue;
    const playhead = s.playhead + (performance.now() - s.clockAt) / 1000; // it kept playing since the last clock
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
    if (!best || s.clockAt > best.s.clockAt) best = { s, src, plan, playhead };
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
      await new Promise((r) => setTimeout(r, 0)); // let appends and clocks in
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
    const lead = src.pcm.read(from - back, from);
    from = from - back + quietCut(lead, back, back);
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
  let heard = [[start, end]];
  if (level >= SILENCE) {
    status(s, 'listening', heardTo(src, s.playhead));
    const { words } = await rec.transcribe(audio);
    const kept = dropHallucinations(words)
      .map((w) => ({ text: w.text, start: from + w.start, end: from + w.end }))
      .filter((w) => w.start >= start - 0.05 && w.start < end);
    if (sessions.get(s.sid) !== s || !s.sources.has(src.id)) return; // closed or reset meanwhile
    src.words = [...src.words.filter((w) => w.start < start - 0.05 || w.start >= end), ...kept].sort((a, b) => a.start - b.start);
    heardWords = kept.length;
    heard = [[start, end], ...unheard(audio, from, start, end, kept).map((r) => ({ minus: r }))];
  }
  const minus = heard.filter((r) => r.minus).map((r) => r.minus);
  src.heard = mergeRanges([...src.heard, ...subtractRanges([heard[0]], minus)]);
  // For the debug log: what was done, never what was said.
  s.windows = [...(s.windows || []).slice(-11), { from: +from.toFixed(2), start: +start.toFixed(2), end: +end.toFixed(2), level: +level.toFixed(4), words: heardWords, ms: Math.round(performance.now() - t0) }];
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

function sendSegments(s, src) {
  const segments = listeningSegments(wordsToCues(src.words), { languageMode: s.languageMode });
  const key = JSON.stringify(segments.map((g) => [g.id, g.end, g.severity]));
  const until = heardTo(src, s.playhead);
  post(s.sid, { type: 'segments', source: src.id, segments, heardTo: until, words: src.words.length, windows: s.windows, audio: mergeRanges(src.pcm.ranges()).map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]), changed: key !== src.segmentsSent });
  src.segmentsSent = key;
  status(s, 'listening', until);
}

// ---- messages ----------------------------------------------------------------------------

self.onmessage = ({ data: m }) => {
  if (!m) return;
  if (m.type === 'config') {
    config = m;
    return;
  }
  const s = session(m.sid);
  switch (m.type) {
    case 'open':
      s.languageMode = m.languageMode;
      return;
    case 'close':
      for (const t of s.tracks.values()) try { t.decoder?.close(); } catch { /* closed */ }
      s.progressive?.stop();
      sessions.delete(m.sid);
      return;
    case 'reset': // a new title in the same tab: forget what was heard
      for (const src of s.sources.values()) {
        src.heard = [];
        src.words = [];
        src.segmentsSent = '';
      }
      s.encrypted = false;
      s.state = null;
      return;
    case 'track': {
      const container = containerOf(m.mime);
      s.tracks.set(m.id, { source: m.source, mime: m.mime, demuxer: createDemuxer(container), decoder: null, config: null });
      sourceOf(s, m.source);
      if (s.selected == null) s.lastFed = m.source;
      return;
    }
    case 'type': { // SourceBuffer.changeType()
      const t = s.tracks.get(m.id);
      if (t) {
        t.mime = m.mime;
        t.demuxer = createDemuxer(containerOf(m.mime));
      }
      return;
    }
    case 'abort': {
      const t = s.tracks.get(m.id);
      t?.demuxer.reset();
      return;
    }
    case 'append': {
      const t = s.tracks.get(m.id);
      if (t) feed(s, t, m.bytes, Number(m.offset) || 0);
      return;
    }
    case 'source': // which <video> source (blob URL) a MediaSource is
      sourceOf(s, m.source).url = m.url;
      return;
    case 'select':
      s.selected = m.source;
      wake();
      return;
    case 'clock':
      s.playhead = m.time;
      s.paused = !!m.paused;
      s.ad = !!m.ad;
      if (Number.isFinite(m.duration)) s.duration = m.duration;
      s.clockAt = performance.now();
      if (s.paused && s.state === 'listening') status(s, 'paused', s.detail);
      wake();
      return;
    case 'settings':
      s.languageMode = m.languageMode;
      for (const src of s.sources.values()) if (src.words.length) sendSegments(s, src);
      return;
    case 'progressive': // a plain <video src>: read the file ourselves
      s.progressive?.stop();
      s.selected = `file:${m.url}`;
      sourceOf(s, s.selected);
      s.progressive = progressiveReader(m.url, {
        playhead: () => s.playhead + (s.paused ? 0 : (performance.now() - s.clockAt) / 1000),
        reach: () => {
          const r = mergeRanges(sourceOf(s, s.selected).pcm.ranges());
          const at = s.playhead;
          return (r.find(([a, b]) => a <= at + 1 && b >= at) || r.at(-1) || [0, -1])[1];
        },
        onBytes: (bytes) => {
          const id = `file-track:${m.url}`;
          if (!s.tracks.has(id)) s.tracks.set(id, { source: s.selected, mime: m.mime || '', demuxer: createDemuxer(null), decoder: null, config: null });
          feed(s, s.tracks.get(id), bytes, 0);
        },
        onSeek: () => s.tracks.get(`file-track:${m.url}`)?.demuxer.reset(),
        onEnd: () => {
          sourceOf(s, s.selected).complete = true;
          wake();
        },
        onError: (e) => status(s, 'error', e),
      });
      return;
    default:
  }
};

// Memory: a session that buffers a whole film is trimmed to what is ahead.
setInterval(() => {
  for (const s of sessions.values()) {
    for (const src of s.sources.values()) {
      if (src.pcm.bytes() > MAX_PCM_BYTES) src.pcm.dropBefore(s.playhead - 2);
    }
  }
}, 10_000);
