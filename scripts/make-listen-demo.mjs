#!/usr/bin/env node
// Media for the listening demo (demo/listen.html): an episode with no
// captions, whose speech (by a local TTS model, see test/support/speech.mjs)
// has profanity at known times, served through MediaSource like YouTube.
//
//   audio.webm   Opus in WebM, 5 s clusters       (what YouTube serves Chrome)
//   audio.mp4    AAC in fragmented MP4, 5 s fragments (DASH, Vimeo)
//   audio-enc.mp4  the same, CENC-encrypted (ClearKey), for the refusal case
//   video.webm   VP9, keyframe and cluster every 5 s
//   speech.json  { duration, lines, words: [{ word, start, end }] } — the truth
//
//   node scripts/make-listen-demo.mjs [outDir]      (default: CLEANCUT_CACHE/listen-demo)
// Needs ffmpeg; downloads the TTS model once (92 MB).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CACHE } from '../test/support/hf.mjs';
import { mediaSegments } from '../shared/media.js';
import { renderSpeech } from '../test/support/speech.mjs';
import { encryptFragmentedMp4 } from './cenc.mjs';

export const SCRIPT = [
  [2, 'Welcome back to the listening demo.'],
  [5.5, 'This video has no captions at all.'],
  [9, 'CleanCut listens to the audio the player has already buffered.'],
  [14, 'All of it happens on this computer.'],
  [18, 'Here comes a word you should not hear.'],
  [23, 'What the *fuck* is going on here?'],
  [28, 'That was close.'],
  [32, 'Now some ordinary talk about the weather.'],
  [37, 'It will be sunny tomorrow, with a light breeze.'],
  [44, 'Oh *shit*, we missed the bus again.'],
  [50, 'Never mind, we can walk there.'],
  [56, 'Get your *damn* feet off the table.'],
  [62, 'Later on, things get a lot worse.'],
  [66, 'Shut the *fuck* up and listen to me.'],
  [72, 'And that is the end of the demo.'],
];
export const DURATION = 78;
// ClearKey key and key id for audio-enc.mp4 (a test key: it protects nothing).
export const CLEARKEY = { kid: '0123456789abcdef0123456789abcdef', key: 'fedcba9876543210fedcba9876543210' };

export async function makeListenDemo(out = join(CACHE, 'listen-demo'), { log = console.log } = {}) {
  const speech = await renderSpeech(SCRIPT, { duration: DURATION, log });
  const dir = join(out, `${speech.dir.split('/').pop()}-m2`); // one folder per script and media version
  const files = ['audio.webm', 'audio.mp4', 'audio-enc.mp4', 'video.webm', 'speech.json', 'index.json'];
  if (files.every((f) => existsSync(join(dir, f)))) return { ...speech, dir };
  mkdirSync(dir, { recursive: true });
  log('  encoding the listening demo (once) …');
  const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  const frag = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '5000000', '-f', 'mp4'];
  ff('-i', speech.wav, '-ac', '2', '-c:a', 'libopus', '-b:a', '128k', '-f', 'webm', '-dash', '1', '-cluster_time_limit', '5000', join(dir, 'audio.webm'));
  ff('-i', speech.wav, '-ac', '2', '-c:a', 'aac', '-b:a', '128k', ...frag, join(dir, 'audio.mp4'));
  writeFileSync(join(dir, 'audio-enc.mp4'), encryptFragmentedMp4(readFileSync(join(dir, 'audio.mp4')), CLEARKEY));
  ff('-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=24:duration=${DURATION}`, '-vf', "drawtext=text='%{pts\\:hms}':x=20:y=20:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.5",
    '-c:v', 'libvpx-vp9', '-b:v', '400k', '-deadline', 'realtime', '-cpu-used', '8', '-g', '120', '-keyint_min', '120',
    '-f', 'webm', '-dash', '1', '-cluster_time_limit', '5000', join(dir, 'video.webm'));
  copyFileSync(join(speech.dir, 'speech.json'), join(dir, 'speech.json'));
  // What the demo player appends: each file's init segment, then its segments by time.
  const tracks = {};
  for (const [file, mime] of Object.entries(MIMES)) {
    const b = new Uint8Array(readFileSync(join(dir, file)));
    const segments = mediaSegments(b);
    tracks[file] = { mime, init: segments[0].start, segments: segments.map(({ start, end, time }) => [start, end, +time.toFixed(3)]) };
  }
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ duration: DURATION, clearkey: CLEARKEY, tracks }));
  return { ...speech, dir };
}

/** A heavier picture for the benchmark (test/perf/listen-sim.mjs): 1280×720 VP9, added to the demo's index. */
export function ensureBenchVideo(dir, { log = console.log } = {}) {
  const file = join(dir, 'video-720.webm');
  const indexFile = join(dir, 'index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  if (existsSync(file) && index.tracks['video-720.webm']) return file;
  log('  encoding a 720p video for the benchmark (once) …');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${DURATION}`,
    '-c:v', 'libvpx-vp9', '-b:v', '2M', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-g', '150', '-keyint_min', '150',
    '-f', 'webm', '-dash', '1', '-cluster_time_limit', '5000', file]);
  const segments = mediaSegments(new Uint8Array(readFileSync(file)));
  index.tracks['video-720.webm'] = { mime: 'video/webm; codecs="vp9"', init: segments[0].start, segments: segments.map(({ start, end, time }) => [start, end, +time.toFixed(3)]) };
  writeFileSync(indexFile, JSON.stringify(index));
  return file;
}

const MIMES = {
  'audio.webm': 'audio/webm; codecs="opus"',
  'audio.mp4': 'audio/mp4; codecs="mp4a.40.2"',
  'audio-enc.mp4': 'audio/mp4; codecs="mp4a.40.2"',
  'video.webm': 'video/webm; codecs="vp9"',
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await makeListenDemo(process.argv[2] || undefined);
  console.log(`wrote ${r.dir}`);
  for (const w of r.words) console.log(`  "${w.word}" at ${w.start.toFixed(2)}–${w.end.toFixed(2)} s`);
}
