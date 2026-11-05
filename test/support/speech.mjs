// Speech with known words, for the listening tests: a script is read out by
// a small local TTS model (Kokoro-82M, ONNX, Apache-2.0, run in Node with
// kokoro-js) and laid out on a timeline.
//
// A line is written like 'What the *fuck* is going on?'. The starred word is
// synthesised as its own clip and placed between the rest of the line, so its
// exact start and end are known (from the clip's samples, silence trimmed);
// that is the ground truth the tests compare CleanCut's mute against.
//
// Output (cached under CLEANCUT_CACHE/speech/<hash>): speech.wav (48 kHz mono)
// and speech.json { duration, lines: [{ at, text }], words: [{ word, start, end }] }.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CACHE, ensureRepoFiles } from './hf.mjs';

const KOKORO = {
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
  files: [
    ['config.json', 44, ''],
    ['tokenizer.json', 3497, ''],
    ['tokenizer_config.json', 113, ''],
    ['onnx/model_quantized.onnx', 92361116, 'sha256:fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478'],
  ],
};
const TTS_RATE = 24000;
export const RATE = 48000;

let tts = null;
async function loadTts(log) {
  if (tts) return tts;
  const dir = await ensureRepoFiles(KOKORO.repo, KOKORO.revision, KOKORO.files, { log });
  const { env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  const { KokoroTTS } = await import('kokoro-js');
  tts = await KokoroTTS.from_pretrained(dir, { dtype: 'q8', device: 'cpu' });
  return tts;
}

/** Leading and trailing silence off (a threshold well under speech level). */
function trim(samples) {
  const thr = 0.01;
  let a = 0;
  let b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < thr) a++;
  while (b > a && Math.abs(samples[b]) < thr) b--;
  const pad = Math.round(TTS_RATE * 0.01);
  return samples.subarray(Math.max(0, a - pad), Math.min(samples.length, b + pad));
}

/** 24 kHz → 48 kHz by linear interpolation (TTS output is band-limited well below 12 kHz). */
function upsample(x) {
  const y = new Float32Array(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    y[2 * i] = x[i];
    y[2 * i + 1] = i + 1 < x.length ? (x[i] + x[i + 1]) / 2 : x[i];
  }
  return y;
}

function wav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

/**
 * @param {Array<[number, string]>} script  [seconds, line] in order
 * @param {{ duration: number, voice?: string, log?: Function }} o
 * @returns {Promise<{ dir: string, wav: string, duration: number, lines: object[], words: object[] }>}
 */
export async function renderSpeech(script, { duration, voice = 'af_heart', log = console.log }) {
  const key = createHash('sha256').update(JSON.stringify({ script, duration, voice, v: 2 })).digest('hex').slice(0, 16);
  const dir = join(CACHE, 'speech', key);
  const meta = join(dir, 'speech.json');
  if (existsSync(meta)) return { dir, wav: join(dir, 'speech.wav'), ...JSON.parse(readFileSync(meta, 'utf8')) };
  mkdirSync(dir, { recursive: true });
  log('  synthesising test speech with Kokoro-82M (once) …');
  const engine = await loadTts(log);
  const out = new Float32Array(Math.ceil(duration * RATE));
  const words = [];
  const lines = [];
  for (const [at, line] of script) {
    // 'What the *fuck* is going on?' → ['What the', '*fuck*', 'is going on?']
    const parts = line.split(/(\*[^*]+\*)/).map((s) => s.trim()).filter(Boolean);
    let pos = Math.round(at * RATE);
    for (const part of parts) {
      const starred = /^\*(.+)\*$/.exec(part);
      const text = starred ? starred[1] : part;
      const audio = await engine.generate(text, { voice });
      const clip = upsample(trim(audio.audio));
      if (pos + clip.length > out.length) throw new Error(`speech runs past ${duration}s at "${line}"`);
      out.set(clip, pos);
      if (starred) words.push({ word: text, start: +(pos / RATE).toFixed(3), end: +((pos + clip.length) / RATE).toFixed(3) });
      pos += clip.length + Math.round(0.06 * RATE);
    }
    lines.push({ at, end: +(pos / RATE).toFixed(3), text: line.replace(/\*/g, '') });
  }
  writeFileSync(join(dir, 'speech.wav'), wav(out, RATE));
  const info = { duration, lines, words };
  writeFileSync(meta, JSON.stringify(info, null, 1));
  return { dir, wav: join(dir, 'speech.wav'), ...info };
}
