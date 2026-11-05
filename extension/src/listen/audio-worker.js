// The audio worker (offscreen document): from the bytes a player appended to
// its audio SourceBuffers to 16 kHz mono PCM on the media clock, for the
// speech worker. Kept apart from the speech worker on purpose: recognition
// keeps that thread busy for seconds at a time, and decoding must not wait
// behind it (WebCodecs delivers decoded audio as tasks on this thread).
//
// Per tab ("session"): the audio tracks the page hook reported, each with a
// demuxer (shared/media.js) and a WebCodecs AudioDecoder; decoded audio is
// held at its own rate (audio.js PcmStore) and, every 200 ms, what is new is
// sent on as 16 kHz blocks over the port to the speech worker. Encrypted or
// undecodable audio is reported to the tab and dropped. A plain <video src>
// WebM is read here too (progressive.js).
//
// Messages in (from offscreen.js): { type: 'port' } with the speech worker's port;
//   { sid, type: 'open' | 'close' | 'track' | 'type' | 'abort' | 'append' | 'clock' | 'progressive' }
// Out, to the speech worker: { sid, type: 'pcm', source, start, samples } | { sid, type: 'complete', source }
// Out, to the tab (via offscreen.js): { sid, type: 'status', state: 'encrypted' | 'unsupported' | 'error', detail? }

import { createDemuxer, containerOf } from '../../../shared/media.js';
import { mergeRanges, subtractRanges } from '../../../shared/listening.js';
import { PcmStore } from './audio.js';
import { progressiveReader } from './progressive.js';

const FLUSH_MS = 200;
let speech = null; // MessagePort to the speech worker
const sessions = new Map();

function session(sid) {
  let s = sessions.get(sid);
  if (!s) {
    s = { sid, tracks: new Map(), sources: new Map(), playhead: 0, paused: true, clockAt: 0, encrypted: false, said: null, progressive: null };
    sessions.set(sid, s);
  }
  return s;
}
const sourceOf = (s, id) => {
  let src = s.sources.get(id);
  if (!src) s.sources.set(id, (src = { id, pcm: new PcmStore(), sent: [] }));
  return src;
};
function tell(s, state, detail = null) {
  if (s.said === state + detail) return;
  s.said = state + detail;
  postMessage({ sid: s.sid, type: 'status', state, detail });
}

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
    tell(s, 'unsupported', 'this browser can’t decode audio here (no WebCodecs)');
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
      if (track.decoder === decoder) track.decoder = null; // reopened on the next append
    },
  });
  const desc = { codec: cfg.codec, sampleRate: cfg.sampleRate, numberOfChannels: cfg.channels || 1 };
  if (cfg.description?.length) desc.description = cfg.description;
  try {
    decoder.configure(desc);
  } catch {
    tell(s, 'unsupported', `can’t decode ${cfg.codec} audio`);
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
    track.lastTime = null;
    if (r.config.encrypted) {
      s.encrypted = true;
      return tell(s, 'encrypted');
    }
    if (!r.config.codec) return tell(s, 'unsupported', `can’t decode ${r.config.unsupported || 'this'} audio`);
  }
  if (r.encrypted) {
    s.encrypted = true;
    tell(s, 'encrypted');
  }
  if (s.encrypted || !track.config?.codec) return;
  for (const f of r.frames) {
    const t = f.time + offset;
    // A jump (the player appended another place, after a seek): Chrome's
    // AudioDecoder times its output from the first input it saw plus the
    // samples decoded since, so the new place gets a new decoder. The old one
    // finishes what it holds, on its own clock.
    if (track.decoder && track.lastTime != null) {
      const step = t - track.lastTime;
      if (step < -0.001 || step > Math.max(0.25, 4 * (track.lastStep || 0.02))) {
        const old = track.decoder;
        old.flush().catch(() => {}).finally(() => { try { old.close(); } catch { /* closed */ } });
        track.decoder = null;
      } else if (step > 0) track.lastStep = step;
    }
    track.lastTime = t;
    track.decoder ||= openDecoder(s, track);
    if (!track.decoder) return;
    try {
      track.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(t * 1e6), data: f.data }));
    } catch {
      track.decoder = null;
      return;
    }
  }
}

/** Send on what was decoded since last time, as 16 kHz blocks. */
function flush() {
  if (!speech) return;
  for (const s of sessions.values()) {
    for (const src of s.sources.values()) {
      const fresh = subtractRanges(src.pcm.ranges(), src.sent);
      for (const [a, b] of fresh) {
        if (b - a < 0.05) continue;
        const samples = src.pcm.read(a, b);
        speech.postMessage({ sid: s.sid, type: 'pcm', source: src.id, start: a, samples }, [samples.buffer]);
        src.sent = mergeRanges([...src.sent, [a, b]], 0.01);
      }
      // Sent and played: no longer needed here (keep a second for the resampler's context).
      const behind = s.playhead + (s.paused ? 0 : (performance.now() - s.clockAt) / 1000) - 10;
      const upTo = Math.min(behind, ...src.sent.map(([, b]) => b - 1));
      if (Number.isFinite(upTo) && upTo > 0) {
        src.pcm.dropBefore(upTo);
        src.sent = src.sent.filter(([, b]) => b > upTo - 60);
      }
    }
  }
}
setInterval(flush, FLUSH_MS);

self.onmessage = ({ data: m }) => {
  if (!m) return;
  if (m.type === 'port') {
    speech = m.port;
    return;
  }
  const s = session(m.sid);
  switch (m.type) {
    case 'close':
      for (const t of s.tracks.values()) try { t.decoder?.close(); } catch { /* closed */ }
      s.progressive?.stop();
      sessions.delete(m.sid);
      return;
    case 'track':
      s.tracks.set(m.id, { source: m.source, mime: m.mime, demuxer: createDemuxer(containerOf(m.mime)), decoder: null, config: null, lastTime: null });
      sourceOf(s, m.source);
      return;
    case 'type': { // SourceBuffer.changeType()
      const t = s.tracks.get(m.id);
      if (t) {
        t.mime = m.mime;
        t.demuxer = createDemuxer(containerOf(m.mime));
      }
      return;
    }
    case 'abort':
      s.tracks.get(m.id)?.demuxer.reset();
      return;
    case 'append': {
      const t = s.tracks.get(m.id);
      if (t) feed(s, t, m.bytes, Number(m.offset) || 0);
      return;
    }
    case 'clock':
      s.playhead = m.time;
      s.paused = !!m.paused;
      s.clockAt = performance.now();
      return;
    case 'progressive': { // a plain <video src>: read the file here
      s.progressive?.stop();
      const source = `file:${m.url}`;
      const id = `file-track:${m.url}`;
      sourceOf(s, source);
      s.tracks.set(id, { source, mime: '', demuxer: createDemuxer(null), decoder: null, config: null, lastTime: null });
      s.progressive = progressiveReader(m.url, {
        playhead: () => s.playhead + (s.paused ? 0 : (performance.now() - s.clockAt) / 1000),
        reach: () => {
          const r = mergeRanges(sourceOf(s, source).sent);
          const at = s.playhead;
          return (r.find(([a, b]) => a <= at + 1 && b >= at) || r.at(-1) || [0, -1])[1];
        },
        onBytes: (bytes) => feed(s, s.tracks.get(id), bytes, 0),
        onSeek: () => {
          const t = s.tracks.get(id);
          t.demuxer.reset();
          t.lastTime = null;
        },
        onEnd: () => speech?.postMessage({ sid: s.sid, type: 'complete', source }),
        onError: (why) => tell(s, 'unsupported', why),
      });
      speech?.postMessage({ sid: s.sid, type: 'select', source });
      return;
    }
    default:
  }
};
