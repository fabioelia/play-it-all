// The speech model on this computer: download it (once, on the viewer's
// opt-in), check every file against its pinned digest, keep it in the
// extension's Cache Storage, say whether it is there, delete it.
//
// Works in the offscreen document's worker, the options page and the popup
// (all on the extension's own origin, so they see the same cache).
import { MODEL_CACHE, fileUrl, modelBytes, verifyDigest } from './models.js';

const TYPES = { json: 'application/json', onnx: 'application/octet-stream' };

/** { ready, bytes } — how much of the model is cached. */
export async function modelStatus(model) {
  let bytes = 0;
  let ready = true;
  try {
    // caches.open would create the bucket: asking must leave no trace.
    if (!(await caches.has(MODEL_CACHE))) return { ready: false, bytes: 0, total: modelBytes(model) };
    const cache = await caches.open(MODEL_CACHE);
    for (const [path, size] of model.files) {
      const hit = await cache.match(fileUrl(model, path));
      if (hit && Number(hit.headers.get('content-length')) === size) bytes += size;
      else ready = false;
    }
  } catch {
    ready = false;
  }
  return { ready, bytes, total: modelBytes(model) };
}

/**
 * Download what is missing. Each file is read into memory, checked (size and
 * digest) and only then cached, so a broken or tampered download never lands.
 * @param {object} model
 * @param {{ host?: string, onProgress?: (fraction: number) => void, signal?: AbortSignal }} [o]
 *   host: where to download from (the default is Hugging Face; tests serve a local copy)
 */
export async function downloadModel(model, { host, onProgress = () => {}, signal } = {}) {
  const cache = await caches.open(MODEL_CACHE);
  const total = modelBytes(model);
  let done = 0;
  const report = () => onProgress(Math.min(1, done / total));
  for (const [path, size, digest] of model.files) {
    const key = fileUrl(model, path);
    const hit = await cache.match(key);
    if (hit && Number(hit.headers.get('content-length')) === size) {
      done += size;
      report();
      continue;
    }
    const res = await fetch(fileUrl(model, path, host), { credentials: 'omit', cache: 'no-store', signal });
    if (!res.ok || !res.body) throw new Error(`could not download ${path} (HTTP ${res.status})`);
    const buf = new Uint8Array(size);
    let at = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      if (at + value.byteLength > size) throw new Error(`${path} is larger than expected`);
      buf.set(value, at);
      at += value.byteLength;
      done += value.byteLength;
      report();
    }
    if (at !== size) throw new Error(`${path} is incomplete (${at} of ${size} bytes)`);
    if (!(await verifyDigest(buf, digest))) throw new Error(`${path} did not match its checksum`);
    const type = TYPES[path.split('.').pop()] || 'application/octet-stream';
    await cache.put(key, new Response(buf, { headers: { 'content-type': type, 'content-length': String(size) } }));
  }
  onProgress(1);
  return modelStatus(model);
}

/** Remove every downloaded model. */
export async function deleteModels() {
  try {
    return await caches.delete(MODEL_CACHE);
  } catch {
    return false;
  }
}
