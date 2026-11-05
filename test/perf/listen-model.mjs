// Which speech model should CleanCut listen with? Runs each candidate the way
// the extension does (transformers.js + onnxruntime-web, WebAssembly, in a
// worker, files from Cache Storage after a checked download) in headless
// Chromium, and reports:
//
//   size      download, MB
//   load      seconds from cached files to ready
//   RTF       real-time factor: compute seconds per second of audio, on ~28 s
//             windows (what the extension transcribes); 0.1 = 10x faster than real time
//   WER       word error rate on LibriSpeech utterances (CC BY 4.0), read speech
//   swears    profane words found by the analyzer in TTS speech, and how far the
//             word timestamps are from the truth (models without word times: n/a)
//
//   node test/perf/listen-model.mjs [model ...]          default: every model in the registry
//   THREADS=1,2,4 N=40 node test/perf/listen-model.mjs whisper-tiny.en
//
// Downloads (once, cached outside the repo): the models, 92 MB of TTS model,
// and N LibriSpeech utterances. WebGPU is not available in headless Chromium,
// so these are CPU (WASM SIMD) numbers.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

import { explainLaunchError, loadChromium, root } from '../support/browser.mjs';
import { CACHE, ensureLibriSpeech, ensureModel, repoDir } from '../support/hf.mjs';
import { renderSpeech } from '../support/speech.mjs';
import { MODELS, modelBytes } from '../../extension/src/listen/models.js';
import { wordsToCues, listeningSegments } from '../../shared/listening.js';

const chromium = loadChromium();
const N = Number(process.env.N || 30);
const THREADS = (process.env.THREADS || '1').split(',').map(Number);
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MODELS);
const PORT = 8790;

// ---- test audio ----------------------------------------------------------------
console.log('Preparing audio …');
const libri = await ensureLibriSpeech(N);
// ~28 s windows of consecutive utterances, like the extension's windows.
const windows = [];
{
  let cur = null;
  for (const u of libri) {
    if (!cur || cur.seconds + u.seconds > 28) windows.push((cur = { ids: [], text: [], seconds: 0 }));
    cur.ids.push(u.id);
    cur.text.push(u.text);
    cur.seconds += u.seconds;
  }
}
const SWEARS = [
  [0.5, 'I told you not to touch that, *shit*.'],
  [3.5, 'What the *fuck* were you thinking?'],
  [7, 'Get out of my *damn* car.'],
  [10, 'You are such an *asshole* sometimes.'],
  [13.5, 'Holy *shit*, look at the size of it.'],
  [17, 'That *bitch* took my parking space.'],
  [20.5, 'Shut the *fuck* up and drive.'],
  [24, 'Well, *hell*, that went badly.'],
];
const speech = await renderSpeech(SWEARS, { duration: 28 });
const pcmFor = new Map(libri.map((u) => [u.id, u.pcm]));

// ---- the page and its worker ----------------------------------------------------------
const bundle = await esbuild.build({
  stdin: {
    contents: `
      import { blockedRequests, loadRecognizer } from './extension/src/listen/recognizer.js';
      import { downloadModel } from './extension/src/listen/store.js';
      import { deleteModels } from './extension/src/listen/store.js';
      import { MODELS } from './extension/src/listen/models.js';
      let rec = null;
      self.onmessage = async ({ data }) => {
        try {
          if (data.type === 'load') {
            const model = MODELS[data.model];
            await downloadModel(model, { host: location.origin + '/hf/' });
            const t0 = performance.now();
            rec = await loadRecognizer(model, { wasmPaths: location.origin + '/ort/', threads: data.threads });
            const warm = new Float32Array(16000);
            await rec.transcribe(warm);
            postMessage({ ok: true, loadMs: performance.now() - t0, threads: rec.threads, isolated: self.crossOriginIsolated });
          } else if (data.type === 'run') {
            const audio = new Float32Array(await (await fetch(data.url)).arrayBuffer());
            const t0 = performance.now();
            const r = await rec.transcribe(audio);
            postMessage({ ok: true, ms: performance.now() - t0, blocked: blockedRequests.slice(), ...r });
          } else if (data.type === 'reset') {
            await deleteModels();
            postMessage({ ok: true });
          }
        } catch (e) {
          postMessage({ ok: false, error: String(e?.stack || e) });
        }
      };`,
    resolveDir: root,
    sourcefile: 'eval-worker.js',
  },
  bundle: true,
  format: 'esm',
  write: false,
  target: ['chrome120'],
  logLevel: 'warning',
  alias: {
    'onnxruntime-web': './node_modules/onnxruntime-web/dist/ort.wasm.min.mjs',
    'onnxruntime-common': './node_modules/onnxruntime-web/node_modules/onnxruntime-common/dist/esm/index.js',
  },
});
const workerJs = bundle.outputFiles[0].text;
const page = '<!doctype html><meta charset="utf-8"><title>listen eval</title><p>eval</p>';

const ortDir = join(root, 'node_modules/onnxruntime-web/dist');
const requests = [];
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const isolate = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
  const send = (type, body) => {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, ...isolate });
    res.end(body);
  };
  if (u.pathname === '/') return send('text/html', Buffer.from(page));
  if (u.pathname === '/eval-worker.js') return send('text/javascript', Buffer.from(workerJs));
  const pcm = /^\/pcm\/(w\d+|swears)\.f32$/.exec(u.pathname);
  if (pcm) {
    const a = pcm[1] === 'swears' ? swearAudio : windowAudio[Number(pcm[1].slice(1))];
    return send('application/octet-stream', Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  }
  if (u.pathname.startsWith('/ort/')) {
    const f = join(ortDir, u.pathname.slice(5).replace(/[^\w.-]/g, ''));
    if (existsSync(f)) return send(f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', readFileSync(f));
  }
  const hf = /^\/hf\/(.+?)\/resolve\/([0-9a-f]{40})\/(.+)$/.exec(u.pathname);
  if (hf) {
    requests.push(hf[3]);
    const f = join(repoDir(hf[1], hf[2]), hf[3]);
    if (!f.includes('..') && existsSync(f) && statSync(f).isFile()) return send('application/octet-stream', readFileSync(f));
  }
  res.writeHead(404, isolate);
  res.end();
}).listen(PORT, '127.0.0.1');

// ---- runs ------------------------------------------------------------------------
const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/'(?![a-z])|(?<![a-z])'/g, ' ').split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const r = words(ref);
  const h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { errors: d[r.length][h.length], n: r.length };
}
/** The recognised word that is this spoken word: same text, nearest in time. */
function heardAs(heard, truth) {
  const norm = (t) => t.toLowerCase().replace(/[^a-z]/g, '');
  const mid = (truth.start + truth.end) / 2;
  return heard.filter((x) => norm(x.text).includes(norm(truth.word)) && Math.abs((x.start + x.end) / 2 - mid) < 2)
    .sort((a, b) => Math.abs((a.start + a.end) / 2 - mid) - Math.abs((b.start + b.end) / 2 - mid))[0] || null;
}
const readPcm = (file) => {
  const b = readFileSync(file);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
};
const windowAudio = windows.map((w) => {
  const parts = w.ids.map((id) => readPcm(pcmFor.get(id)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
});
// The TTS clip, 48 kHz → 16 kHz (the speech is band-limited; averaging 3 samples is enough here).
const swearAudio = (() => {
  const b = readFileSync(speech.wav).subarray(44);
  const s = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  const out = new Float32Array(Math.floor(s.length / 3));
  for (let i = 0; i < out.length; i++) out[i] = (s[3 * i] + s[3 * i + 1] + s[3 * i + 2]) / 3 / 32768;
  return out;
})();

const results = [];
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true }).catch(explainLaunchError);
  for (const name of names) {
    const model = MODELS[name];
    if (!model) throw new Error(`unknown model ${name}`);
    await ensureModel(model);
    for (const threads of THREADS) {
      const p = await browser.newPage();
      await p.goto(`http://127.0.0.1:${PORT}/`);
      const call = (msg) => p.evaluate((m) => new Promise((resolve) => {
        window.__w ||= new Worker('/eval-worker.js', { type: 'module' });
        window.__w.onmessage = ({ data }) => resolve(data);
        window.__w.postMessage(m);
      }), msg);
      await call({ type: 'reset' });
      requests.length = 0;
      const load = await call({ type: 'load', model: name, threads });
      if (!load.ok) throw new Error(load.error);
      const fetched = [...new Set(requests)];
      let ms = 0;
      let seconds = 0;
      let errors = 0;
      let n = 0;
      for (const [i, w] of windows.entries()) {
        const r = await call({ type: 'run', url: `/pcm/w${i}.f32` });
        if (!r.ok) throw new Error(r.error);
        ms += r.ms;
        seconds += w.seconds;
        const e = wer(w.text.join(' '), r.text);
        errors += e.errors;
        n += e.n;
      }
      const s = await call({ type: 'run', url: '/pcm/swears.f32' });
      const found = [];
      const timeErr = [];
      const signed = { start: [], end: [] };
      let covered = 0;
      if (s.ok) {
        const segs = listeningSegments(wordsToCues(s.words.length ? s.words : [{ text: s.text, start: 0, end: speech.duration }], 0), { languageMode: 'word' });
        for (const truth of speech.words) {
          const hit = segs.find((g) => g.category === 'language' && g.start <= truth.end + 0.3 && g.end >= truth.start - 0.3);
          if (hit) {
            found.push(truth.word);
            // Fully muted, once the engine's own 0.25 s on each side is added?
            // Fully muted? The engine pads each cut by 0.25 s and starts it 0.15 s early (shared/engine.js).
            if (hit.start - 0.25 - 0.15 <= truth.start && hit.end + 0.25 >= truth.end) covered++;
            const w = heardAs(s.words || [], truth);
            if (w && model.words) {
              timeErr.push(Math.abs(w.start - truth.start), Math.abs(w.end - truth.end));
              signed.start.push(w.start - truth.start);
              signed.end.push(w.end - truth.end);
            }
          }
        }
        if (process.env.VERBOSE) console.log(speech.words.map((t) => ({ ...t, heard: heardAs(s.words || [], t) })));
      }
      const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
      results.push({
        name, threads: load.threads, isolated: load.isolated, mb: modelBytes(model) / 1e6, loadS: load.loadMs / 1000,
        rtf: ms / 1000 / seconds, wer: (100 * errors) / n, audioS: seconds,
        swears: `${found.length}/${speech.words.length}`, covered: `${covered}/${speech.words.length}`,
        timing: timeErr.length ? `${(1000 * mean(timeErr)).toFixed(0)} ms (start ${(1000 * mean(signed.start)).toFixed(0)}, end ${(1000 * mean(signed.end)).toFixed(0)})` : 'n/a',
        swearText: s.text, fetched, blocked: s.blocked,
      });
      const r = results.at(-1);
      console.log(`  ${name} ×${r.threads}: RTF ${r.rtf.toFixed(3)}, WER ${r.wer.toFixed(1)}%, swears ${r.swears}, fully muted ${r.covered}, timing ${r.timing}`);
      await p.close();
    }
  }
} finally {
  await browser?.close();
  server.close();
}

console.log(`\nSpeech models in headless Chromium, WebAssembly (SIMD), ${windows.length} LibriSpeech windows = ${results[0]?.audioS.toFixed(0)} s of audio; cache ${CACHE}\n`);
console.log('model'.padEnd(18), 'threads', '   MB', ' load s', '    RTF', '  WER %', '  swears', ' muted', '  word timing error, mean abs (signed)');
for (const r of results) {
  console.log(r.name.padEnd(18), String(r.threads).padStart(7), r.mb.toFixed(0).padStart(5), r.loadS.toFixed(1).padStart(7), r.rtf.toFixed(3).padStart(7), r.wer.toFixed(1).padStart(7), r.swears.padStart(8), r.covered.padStart(6), '  ' + r.timing);
}
for (const r of results) console.log(`  ${r.name}: heard "${r.swearText.slice(0, 160)}"`);
console.log(`  files downloaded: ${[...new Set(results.flatMap((r) => r.fetched))].join(', ')}`);
console.log(`  asked for but not cached (answered 404 in the worker, never fetched): ${[...new Set(results.flatMap((r) => r.blocked || []))].map((u) => u.split('/').pop()).join(', ') || 'none'}`);
