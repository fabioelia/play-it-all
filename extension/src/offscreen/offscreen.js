// The offscreen document (reason WORKERS): exists only while listening ahead
// is in use, and hosts the audio and speech workers, so decoding and
// recognition run in the extension's own process, never on the streaming page.
//
// Tabs connect with chrome.runtime.connect({ name: 'cleancut-listen' }); their
// content script forwards the audio the page hook captured (base64 strings:
// runtime messaging carries JSON only) and the playhead. Each connection is a
// session in the workers; its segments come back over the same port.
//
// It also downloads the model when the viewer opts in (background.js asks),
// and tells the background it can be closed once no tab has listened for a
// while.
import { DEFAULT_MODEL, MODELS } from '../listen/models.js';
import { downloadModel, modelStatus } from '../listen/store.js';

const IDLE_MS = 90_000;
const model = MODELS[DEFAULT_MODEL];

// Two workers: one decodes (audio-worker.js), one recognises (asr-worker.js),
// so decoding never waits behind recognition. The audio goes from one to the
// other directly, over their own channel.
const speech = new Worker('asr-worker.js', { type: 'module' });
const audio = new Worker('audio-worker.js');
speech.postMessage({ type: 'config', wasmPaths: chrome.runtime.getURL('ort/'), model: DEFAULT_MODEL, threads: 1 });
{
  const link = new MessageChannel();
  speech.postMessage({ type: 'port', port: link.port1 }, [link.port1]);
  audio.postMessage({ type: 'port', port: link.port2 }, [link.port2]);
}

const ports = new Map(); // session id → port
let seq = 0;
const toTab = ({ data }) => {
  try {
    ports.get(data.sid)?.postMessage(data);
  } catch { /* the tab went away */ }
};
speech.onmessage = toTab;
audio.onmessage = toTab;
const onWorkerError = (e) => {
  for (const p of ports.values()) p.postMessage({ type: 'status', state: 'error', detail: String(e.message || 'the speech worker stopped') });
};
speech.onerror = onWorkerError;
audio.onerror = onWorkerError;

// Which worker a tab's message is for.
const FOR_AUDIO = new Set(['track', 'type', 'abort', 'progressive']);
const FOR_BOTH = new Set(['open', 'close', 'clock']);

const fromBase64 = typeof Uint8Array.fromBase64 === 'function'
  ? (s) => Uint8Array.fromBase64(s)
  : (s) => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

// ---- idle: let the background close this document ----------------------------------
let idleTimer = 0;
let downloading = null;
function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!ports.size && !downloading) chrome.runtime.sendMessage({ type: 'listenIdle' }).catch(() => {});
  }, IDLE_MS);
}
armIdle();

// ---- tabs ------------------------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cleancut-listen' || port.sender?.id !== chrome.runtime.id || !port.sender?.tab) return;
  const sid = ++seq;
  ports.set(sid, port);
  clearTimeout(idleTimer);
  port.onMessage.addListener((m) => {
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    if (m.type === 'append') {
      if (typeof m.b64 !== 'string') return;
      const bytes = fromBase64(m.b64);
      audio.postMessage({ sid, type: 'append', id: m.id, offset: m.offset, bytes: bytes.buffer }, [bytes.buffer]);
      return;
    }
    const msg = { ...m, sid };
    if (FOR_AUDIO.has(m.type) || FOR_BOTH.has(m.type)) audio.postMessage(msg);
    if (!FOR_AUDIO.has(m.type)) speech.postMessage(msg);
  });
  port.onDisconnect.addListener(() => {
    ports.delete(sid);
    audio.postMessage({ sid, type: 'close' });
    speech.postMessage({ sid, type: 'close' });
    if (!ports.size) armIdle();
  });
  port.postMessage({ type: 'hello', sid });
});

// ---- the model download (background.js relays the popup's request) -----------------------
const progress = { state: 'idle', fraction: 0, error: null };

chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (m?.target !== 'offscreen' || sender.id !== chrome.runtime.id) return false;
  if (m.type === 'offscreen:status') {
    sendResponse({ ...progress, sessions: ports.size });
    return false;
  }
  if (m.type === 'offscreen:download') {
    if (!downloading) {
      Object.assign(progress, { state: 'downloading', fraction: 0, error: null });
      // A local copy of the files may be named for tests (background.js only passes localhost).
      downloading = downloadModel(model, { host: m.host || undefined, onProgress: (f) => (progress.fraction = f) })
        .then((st) => Object.assign(progress, { state: st.ready ? 'done' : 'error', fraction: 1, error: st.ready ? null : 'incomplete' }))
        .catch((e) => Object.assign(progress, { state: 'error', error: String(e?.message || e) }))
        .finally(() => {
          downloading = null;
          chrome.runtime.sendMessage({ type: 'listenDownloaded', ok: progress.state === 'done', error: progress.error }).catch(() => {});
          armIdle();
        });
    }
    sendResponse({ ...progress });
    return false;
  }
  if (m.type === 'offscreen:model') {
    modelStatus(model).then(sendResponse, () => sendResponse({ ready: false }));
    return true;
  }
  return false;
});
