// Speech recognition on this computer: transformers.js over onnxruntime-web
// (WebAssembly, SIMD, a capped number of threads), in a dedicated worker.
//
// The model's files are read only from CleanCut's own Cache Storage (see
// store.js, which downloads and verifies them on the viewer's opt-in). While
// recognising, nothing is fetched: a request for any file that is not in the
// cache gets a 404, so a missing optional file can never turn into a download,
// and audio is never sent anywhere.
import { env, pipeline } from '@huggingface/transformers';
import { MODEL_CACHE, MODEL_HOST } from './models.js';

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
  return {
    threads: used,
    async transcribe(audio) {
      const out = await asr(audio, model.words ? { return_timestamps: 'word' } : {});
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
