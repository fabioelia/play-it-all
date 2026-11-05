// Listening ahead without the model: the container parsers that read the
// audio a player appends (on files ffmpeg makes, cut into random appends),
// encryption detection, the window planner, and words → mute segments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDemuxer, isInitSegment, parseMp4Init, sniff, webmCues, webmInitLength } from '../shared/media.js';
import { dropHallucinations, listeningSegments, mergeRanges, planWindow, subtractRanges, wordsToCues } from '../shared/listening.js';
import { buildPlan, decide } from '../shared/engine.js';
import { defaultProfile } from '../shared/ratings.js';
import { verifyDigest } from '../extension/src/listen/models.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'cleancut-media-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function make(name, args) {
  const out = join(dir, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', ...args, out]);
  return new Uint8Array(readFileSync(out));
}

/** Feed bytes in appends of random sizes (seeded), as a player might cut them. */
function demux(bytes, container, seed = 7) {
  const d = createDemuxer(container);
  let rnd = seed;
  const next = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const frames = [];
  let config = null;
  let encrypted = false;
  for (let o = 0; o < bytes.length;) {
    const n = Math.max(1, Math.floor(next() * 9000));
    const r = d.push(bytes.slice(o, o + n));
    o += n;
    if (r.config) config = r.config;
    if (r.encrypted) encrypted = true;
    frames.push(...r.frames);
  }
  return { config, frames, encrypted: encrypted || !!config?.encrypted };
}

function assertTimeline(frames, seconds, step) {
  assert.ok(frames.length > 0, 'frames');
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].time > frames[i - 1].time, `time goes forward at ${i}`);
  assert.ok(Math.abs(frames[0].time) < 0.1, `starts at ${frames[0].time}`);
  assert.ok(Math.abs(frames.at(-1).time - seconds) < 0.2, `ends near ${seconds}: ${frames.at(-1).time}`);
  const gap = (frames.at(-1).time - frames[0].time) / (frames.length - 1);
  assert.ok(Math.abs(gap - step) < 0.002, `frame step ${gap}`);
  for (const f of frames) assert.ok(f.data.byteLength > 0);
}

test('WebM Opus (YouTube-style): init segment, clusters across random appends, times from Cluster Timecode', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const webm = make('a.webm', ['-c:a', 'libopus', '-b:a', '64k', '-f', 'webm', '-dash', '1', '-cluster_time_limit', '2000']);
  assert.equal(sniff(webm), 'webm');
  assert.equal(isInitSegment(webm), true);
  const initLen = webmInitLength(webm);
  assert.ok(initLen > 0 && initLen < 2000, `init ${initLen}`);
  assert.equal(isInitSegment(webm.subarray(initLen)), false);
  const { config, frames, encrypted } = demux(webm, 'webm');
  assert.equal(config.codec, 'opus');
  assert.equal(config.sampleRate, 48000);
  assert.equal(String.fromCharCode(...config.description.subarray(0, 8)), 'OpusHead');
  assert.equal(encrypted, false);
  assertTimeline(frames, 5.98, 0.02);
  // The same stream, appended whole at once, gives the same frames.
  const whole = demux(webm, null, 1);
  assert.equal(whole.frames.length, frames.length);
});

test('progressive WebM: Cues give cluster positions by time', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const webm = make('p.webm', ['-c:a', 'libopus', '-b:a', '64k', '-f', 'webm', '-cluster_time_limit', '2000', '-cues_to_front', '1', '-reserve_index_space', '2048']);
  const cues = webmCues(webm);
  assert.ok(cues.length >= 2, JSON.stringify(cues));
  assert.equal(cues[0].time, 0);
  for (const c of cues) assert.equal(webm[c.offset], 0x1f, 'each cue points at a Cluster'); // 1F 43 B6 75
  // Reading from a cluster in the middle, after the init segment, gives that stretch.
  const d = createDemuxer('webm');
  d.push(webm.subarray(0, webmInitLength(webm)));
  const r = d.push(webm.subarray(cues[1].offset));
  assert.ok(Math.abs(r.frames[0].time - cues[1].time) < 0.03);
});

test('fragmented MP4 AAC (DASH / Vimeo-style): mdhd timescale, tfdt, trun sizes', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const mp4 = make('a.mp4', ['-c:a', 'aac', '-b:a', '96k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000', '-f', 'mp4']);
  assert.equal(sniff(mp4), 'mp4');
  assert.equal(isInitSegment(mp4), true);
  const init = parseMp4Init(mp4);
  assert.equal(init.codec, 'mp4a.40.2');
  assert.ok(init.timescale > 0);
  assert.ok(init.description.length >= 2);
  const { frames, encrypted } = demux(mp4, 'mp4');
  assert.equal(encrypted, false);
  assertTimeline(frames, 6, 1024 / 48000);
});

test('fragmented MP4 Opus: dOps becomes an OpusHead', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const mp4 = make('o.mp4', ['-c:a', 'libopus', '-b:a', '64k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000', '-f', 'mp4']);
  const { config, frames } = demux(mp4, 'mp4', 3);
  assert.equal(config.codec, 'opus');
  assert.equal(String.fromCharCode(...config.description.subarray(0, 8)), 'OpusHead');
  assertTimeline(frames, 5.98, 0.02);
});

test('encrypted audio is recognised: MP4 CENC (enca/sinf, senc), WebM ContentEncryption', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const key = '00112233445566778899aabbccddeeff';
  const mp4 = make('e.mp4', ['-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000',
    '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', key, '-encryption_kid', key, '-f', 'mp4']);
  const init = parseMp4Init(mp4);
  assert.equal(init.encrypted, true);
  assert.equal(init.codec, 'mp4a.40.2', 'the original format from frma');
  assert.equal(demux(mp4, 'mp4').encrypted, true);

  // WebM: a TrackEntry with ContentEncodings > ContentEncoding > ContentEncryption (as Widevine WebM has).
  const el = (id, body) => {
    const idBytes = [];
    for (let v = id; v; v = Math.floor(v / 256)) idBytes.unshift(v & 0xff);
    const size = body.length;
    return [...idBytes, 0x10 | ((size >> 24) & 0x0f), (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff, ...body]; // a 4-byte size
  };
  const str = (s) => [...Buffer.from(s)];
  const ebml = el(0x1a45dfa3, el(0x4282, str('webm')));
  const tracks = el(0x1654ae6b, el(0xae, [...el(0xd7, [1]), ...el(0x83, [2]), ...el(0x86, str('A_OPUS')),
    ...el(0x6d80, el(0x6240, el(0x5035, el(0x47e1, [5]))))]));
  const segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...tracks];
  const r = createDemuxer('webm').push(new Uint8Array([...ebml, ...segment]));
  assert.equal(r.config.codec, 'opus');
  assert.equal(r.config.encrypted, true);
});

test('garbage and unsupported codecs do not throw', () => {
  const d = createDemuxer(null);
  assert.deepEqual(d.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])).frames, []);
  const m = createDemuxer('mp4');
  assert.deepEqual(m.push(new Uint8Array(100).fill(0xff)).frames, []);
});

// ---- the planner ---------------------------------------------------------------------

test('ranges: merge and subtract', () => {
  assert.deepEqual(mergeRanges([[5, 6], [0, 2], [2.02, 3]]), [[0, 3], [5, 6]]);
  assert.deepEqual(subtractRanges([[0, 10]], [[2, 3], [5, 12]]), [[0, 2], [3, 5]]);
});

test('planWindow: ahead of the playhead, within the horizon, waits for enough audio, re-plans after a seek', () => {
  // 0–30 s buffered, nothing heard: the first 28 s.
  assert.deepEqual(planWindow({ audio: [[0, 30]], done: [], playhead: 0 }), { start: 0, end: 28, from: 0 });
  // 0–28 heard: the next window starts at 28, repeating a little of the last one.
  const w = planWindow({ audio: [[0, 45]], done: [[0, 28]], playhead: 3 });
  assert.equal(w.start, 28);
  assert.equal(w.end, 45);
  assert.ok(w.from < 28 && w.from > 27);
  // Only 3 s past what was heard, and the player is still buffering: wait.
  assert.equal(planWindow({ audio: [[0, 31]], done: [[0, 28]], playhead: 3 }), null);
  // …unless that is the end of the stream.
  assert.equal(planWindow({ audio: [[0, 31]], done: [[0, 28]], playhead: 3, complete: true }).end, 31);
  // Nothing beyond the horizon.
  assert.equal(planWindow({ audio: [[0, 300]], done: [[0, 95]], playhead: 4 }), null);
  // After a seek to 200 s, the window starts there, not at the old gap.
  const s = planWindow({ audio: [[0, 60], [198, 240]], done: [[0, 40]], playhead: 200 });
  assert.equal(s.start, 199.5);
  assert.equal(s.from, 199.5);
});

// ---- words → segments ------------------------------------------------------------------

const heard = [
  { text: 'What', start: 0.2, end: 0.4 }, { text: 'the', start: 0.4, end: 0.55 }, { text: 'fuck', start: 0.6, end: 0.95 },
  { text: 'is', start: 1.0, end: 1.1 }, { text: 'that?', start: 1.1, end: 1.5 },
  { text: 'Oh,', start: 3.0, end: 3.2 }, { text: 'hell.', start: 3.3, end: 3.6 },
];

test('wordsToCues: phrases split at pauses, times on the media clock, overlap dropped', () => {
  const cues = wordsToCues(heard, 100);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'What the fuck is that?');
  assert.equal(cues[0].start, 100.2);
  assert.equal(cues[1].words[1].start, 103.3);
  assert.equal(wordsToCues(heard, 100, { keepFrom: 102 }).length, 1);
});

test('listeningSegments: profanity muted at the measured word, mild words stay suggestions', () => {
  const segs = listeningSegments(wordsToCues(heard, 100));
  const strong = segs.find((s) => s.severity === 3);
  assert.equal(strong.source, 'listening');
  assert.match(strong.id, /^listening:language:/);
  assert.ok(Math.abs(strong.start - 100.48) < 0.01 && Math.abs(strong.end - 101.07) < 0.01, `${strong.start}–${strong.end}`);
  assert.ok(strong.confidence >= 0.8);
  const mild = segs.find((s) => s.severity === 1);
  assert.ok(mild.confidence < 0.6, 'mild: a suggestion at the default bar');
  // In the plan: G mutes the strong word only around the word itself, and suggests "hell".
  const plan = buildPlan(segs, { ...defaultProfile(), preset: 'G' });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.flagged.find((f) => f.severity === 1).decision, 'suggested');
  assert.equal(decide(100.7, plan.actions).mute, true);
  assert.equal(decide(101.5, plan.actions).mute, false);
  assert.equal(decide(100.0, plan.actions).mute, false);
});

test('a bleep the recogniser writes ("f***", "[bleep]") is still muted; a bracketed sound is a hint', () => {
  const segs = listeningSegments(wordsToCues([
    { text: 'You', start: 0, end: 0.2 }, { text: 'f***ing', start: 0.2, end: 0.6 }, { text: 'idiot', start: 0.6, end: 1 },
    { text: '[gunshot]', start: 5, end: 5.5 },
  ]));
  assert.ok(segs.some((s) => s.category === 'language' && s.severity === 3 && s.start < 0.2 && s.end > 0.6));
  const v = segs.find((s) => s.category === 'violence');
  assert.ok(v && v.confidence < 0.55, 'scene hints from listening carry less weight');
});

test('dropHallucinations: loops and stock silence words go', () => {
  const words = ['so', 'so', 'so', 'so', 'so', 'we', 'go'].map((text, i) => ({ text, start: i, end: i + 0.5 }));
  assert.deepEqual(dropHallucinations(words).map((w) => w.text), ['so', 'we', 'go']);
  assert.deepEqual(dropHallucinations([{ text: '[BLANK_AUDIO]', start: 0, end: 1 }]), []);
});

test('model files are checked against their pinned digests', async () => {
  const bytes = new TextEncoder().encode('hello\n');
  assert.equal(await verifyDigest(bytes, 'git:ce013625030ba8dba906f756967f9e9ca394464a'), true); // git hash-object of "hello\n"
  assert.equal(await verifyDigest(bytes, 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03'), true);
  assert.equal(await verifyDigest(bytes, 'sha256:00'), false);
});
