// Speech recognition on this computer: transformers.js over onnxruntime-web
// (WebAssembly, SIMD, a capped number of threads), in a dedicated worker.
//
// The model's files are read only from CleanCut's own Cache Storage (see
// store.js, which downloads and verifies them on the viewer's opt-in). While
// recognising, nothing is fetched: a request for any file that is not in the
// cache gets a 404, so a missing optional file can never turn into a download,
// and audio is never sent anywhere.
import { env, pipeline } from '@huggingface/transformers';
import { InferenceSession } from 'onnxruntime-web'; // the runtime's own class (it bundles its own onnxruntime-common)
import { MODEL_CACHE, MODEL_HOST } from './models.js';

// onnxruntime-web's single-threaded WebAssembly runs each model call
// synchronously, and transformers.js chains the decoder's calls with
// promises, so a whole window would run without this worker seeing a single
// message: no new audio, no playhead, no seek. Each call first gives the
// worker's queue one turn (a MessageChannel ping costs about 0.1 ms; a
// window makes ~100 calls), so a seek is noticed within one decoder step.
const tick = new MessageChannel();
const waiting = [];
tick.port1.onmessage = () => waiting.shift()?.();
const yieldTurn = () => new Promise((resolve) => {
  waiting.push(resolve);
  tick.port2.postMessage(0);
});
const run = InferenceSession.prototype.run;
InferenceSession.prototype.run = async function (...args) {
  await yieldTurn();
  return run.apply(this, args);
};

let configured = null;
/** Model-host addresses transformers.js asked for that were not downloaded (for diagnostics). */
export const blockedRequests = [];

function configure({ wasmPaths, threads }) {
  if (configured) return configured;
  env.allowLocalModels = false;
  env.allowRemoteModels = true; // "remote" is answered from the cache below
  env.remoteHost = MODEL_HOST;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  const cache = caches.open(MODEL_CACHE);
  env.customCache = {
    match: async (key) => (await cache).match(key),
    put: async () => {}, // only store.js writes, after checking the digest
  };
  const realFetch = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (url.startsWith(MODEL_HOST)) {
      if (blockedRequests.length < 20) blockedRequests.push(url);
      return Promise.resolve(new Response(null, { status: 404, statusText: 'not downloaded' }));
    }
    return realFetch(input, init);
  };
  const onnx = env.backends.onnx;
  onnx.wasm.wasmPaths = wasmPaths;
  onnx.wasm.numThreads = threads;
  onnx.wasm.proxy = false; // already off the page, in a worker
  onnx.logLevel = 'error';
  configured = { threads };
  return configured;
}

/**
 * Word times come from dynamic time warping over the decoder's
 * cross-attention, cropped to the real audio first (the rest is padding up
 * to Whisper's 30 s). The encoder halves the frame rate (100 mel frames a
 * second, 50 attention positions), so the crop must be num_frames / 2, as in
 * the Python implementation; transformers.js 3.8.1 (and 4.x) crops at
 * num_frames, which for a window under 30 s lets the warp run on into the
 * padding and puts the last words seconds late. Corrected on the instance.
 */
function fixWordTimestamps(model) {
  const extract = model?._extract_token_timestamps;
  if (typeof extract !== 'function') return;
  model._extract_token_timestamps = function (outputs, heads, numFrames, precision) {
    return extract.call(this, outputs, heads, numFrames == null ? numFrames : Math.ceil(numFrames / 2), precision);
  };
}

/** How many threads inference may use: few, so video decoding and the page keep their cores. */
export function threadBudget(cores = navigator.hardwareConcurrency || 2, isolated = self.crossOriginIsolated) {
  if (!isolated) return 1; // WebAssembly threads need SharedArrayBuffer
  return Math.max(1, Math.min(4, Math.floor(cores / 4)));
}

/**
 * @param {object} model         an entry of MODELS
 * @param {{ wasmPaths: string, threads?: number }} o
 * @returns {Promise<{ transcribe(audio: Float32Array): Promise<{ text: string, words: Array<{text:string,start:number,end:number}> }>, threads: number }>}
 *   audio is 16 kHz mono, at most 30 s; word times are seconds from its start
 */
export async function loadRecognizer(model, { wasmPaths, threads = threadBudget() }) {
  const { threads: used } = configure({ wasmPaths, threads });
  const asr = await pipeline('automatic-speech-recognition', model.repo, {
    revision: model.revision,
    dtype: model.dtype,
    device: 'wasm',
  });
  fixWordTimestamps(asr.model);
  // Stopping a window that is no longer wanted (the viewer sought elsewhere):
  // Whisper's generate() in transformers.js drops stopping criteria but keeps
  // logits processors, so one forces end-of-text, and decoding ends at the next token.
  const eos = [].concat(asr.model.generation_config?.eos_token_id ?? 50256)[0];
  const stopWhen = (cancelled) => [(ids, logits) => {
    if (cancelled()) {
      for (let i = 0; i < logits.dims[0]; i++) {
        const row = logits[i].data;
        row.fill(-Infinity);
        row[eos] = 0;
      }
    }
    return logits;
  }];
  return {
    threads: used,
    raw: (audio, o) => asr(audio, o),
    /** @param {{ cancelled?: () => boolean }} [o]  checked before each token; the result is then cut short */
    async transcribe(audio, { cancelled } = {}) {
      const opts = model.words ? { return_timestamps: 'word' } : {};
      if (cancelled) opts.logits_processor = stopWhen(cancelled);
      const out = await asr(audio, opts);
      const words = [];
      for (const c of out.chunks || []) {
        const [start, end] = c.timestamp || [];
        if (!Number.isFinite(start)) continue;
        words.push({ text: c.text.trim(), start, end: Number.isFinite(end) ? end : start + 0.3 });
      }
      return { text: (out.text || '').trim(), words };
    },
    dispose: () => asr.dispose?.(),
  };
}
