// Listening ahead, the content script's part: decide whether to listen on
// this page, keep the page hook's flag for it, and carry the audio the hook
// captured to the speech worker (offscreen document). Recognition never runs
// here, on the page's main thread.
//
// Costs on the page, when listening is on: per append (every few seconds),
// one base64 encoding of a ~100 KB chunk and one port message; the playhead,
// at most once a second, piggybacked on the existing playback tick. No timer
// of its own, no DOM, no layout. Off (the default): one storage read at load.
//
// When there is no listening:
//  - the service encrypts its audio (DRM: Netflix, Prime Video, Disney+ … or
//    any page whose video has MediaKeys / fires 'encrypted', or whose init
//    segment says so): "can't listen here", and the hook stops copying;
//  - the title has captions CleanCut scanned (they win), unless the viewer
//    asked to listen anyway;
//  - the speech model is not on this computer yet.

export const ENCRYPTED_PLATFORMS = new Set(['netflix', 'prime', 'disney', 'max', 'hulu', 'appletv', 'paramount', 'peacock']);
export const FLAG = 'cleancut:listen';
const MAX_QUEUE = 8 * 1024 * 1024; // bytes held while the speech worker starts

const toBase64 = typeof Uint8Array.prototype.toBase64 === 'function'
  ? (buf) => new Uint8Array(buf).toBase64()
  : (buf) => {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  };

/**
 * @param {object} o
 * @param {string} o.platform
 * @param {(msg: object) => Promise<any>} o.bg       message the background worker
 * @param {(msg: object) => void} o.toHook           message the page hook
 * @param {(segments: Array) => void} o.onSegments  heard segments changed
 * @param {() => void} o.onStatus                    the status line changed
 * @param {Function} [o.log]
 */
export function createListening({ platform, bg, toHook, onSegments, onStatus, log = () => {} }) {
  const host = location.hostname;
  let prefs = { on: false, sites: {}, always: false };
  let armed = false; // the hook is capturing (the flag was set when the page loaded)
  let video = null;
  let port = null;
  let connecting = null;
  let queue = [];
  let queueBytes = 0;
  let captions = false;
  let encrypted = ENCRYPTED_PLATFORMS.has(platform);
  let sources = new Map(); // MediaSource id → blob URL
  let selected = null;
  let lastClock = { t: -1, paused: null, ad: null };
  let segments = [];
  const st = { state: 'off', detail: null, heardTo: null, words: 0, bytes: 0, appends: 0 };

  const allowed = () => prefs.on && prefs.sites?.[host] !== false;
  const wanted = () => allowed() && !encrypted && !!video && (!captions || prefs.always);

  function set(state, detail = null) {
    if (st.state === state && st.detail === detail) return;
    st.state = state;
    st.detail = detail;
    onStatus();
  }

  function writeFlag() {
    try {
      // Read by the page hook at document_start of the next load.
      if (allowed() && !ENCRYPTED_PLATFORMS.has(platform)) localStorage.setItem(FLAG, '1');
      else localStorage.removeItem(FLAG);
    } catch { /* storage blocked */ }
  }

  function send(msg) {
    if (port) {
      try {
        port.postMessage(msg);
      } catch {
        port = null;
      }
      return;
    }
    if (msg.type === 'clock') return; // a fresh one is sent on connect
    queue.push(msg);
    queueBytes += msg.b64?.length || 0;
    while (queueBytes > MAX_QUEUE) {
      const i = queue.findIndex((m) => m.type === 'append' && !m.init);
      if (i < 0) break;
      queueBytes -= queue[i].b64.length;
      queue.splice(i, 1);
    }
  }

  async function connect() {
    if (port || connecting || !wanted()) return;
    connecting = (async () => {
      const r = await bg({ type: 'listenStart' });
      if (!r?.ok) {
        set(r?.reason === 'no-model' ? 'no-model' : r?.reason === 'unsupported' ? 'unsupported' : 'error', r?.error || null);
        return;
      }
      if (!wanted()) return;
      const p = chrome.runtime.connect({ name: 'cleancut-listen' });
      port = p;
      p.onMessage.addListener(onWorker);
      p.onDisconnect.addListener(() => {
        if (port === p) port = null;
        if (wanted()) set('error', 'the speech worker stopped');
      });
      p.postMessage({ type: 'open', languageMode: prefs.languageMode });
      for (const m of queue.splice(0)) p.postMessage(m);
      queueBytes = 0;
      if (selected != null) p.postMessage({ type: 'select', source: selected });
      if (isFile(video)) p.postMessage({ type: 'progressive', url: video.currentSrc });
      lastClock = { t: -1, paused: null, ad: null };
      if (video) clock(video.currentTime, video.paused, false);
      set(armed || isFile(video) ? 'waiting' : 'reload');
    })().catch((e) => set('error', String(e?.message || e))).finally(() => {
      connecting = null;
    });
  }

  function disconnect() {
    queue = [];
    queueBytes = 0;
    try {
      port?.disconnect();
    } catch { /* gone */ }
    port = null;
  }

  function onWorker(m) {
    if (!m) return;
    if (m.type === 'status') {
      if (m.state === 'encrypted') return markEncrypted();
      if (m.state === 'listening' || m.state === 'paused') st.heardTo = m.detail ?? st.heardTo;
      set(m.state, m.state === 'listening' || m.state === 'paused' ? null : m.detail || null);
      onStatus();
    } else if (m.type === 'segments') {
      if (selected != null && m.source !== selected && !String(m.source).startsWith('file:')) return;
      st.heardTo = m.heardTo;
      st.words = m.words;
      st.windows = m.windows;
      st.audio = m.audio;
      if (m.changed || segments.length !== m.segments.length) {
        segments = m.segments;
        onSegments(segments);
      }
      onStatus();
    }
  }

  function markEncrypted() {
    if (encrypted) return;
    encrypted = true;
    log('listen-encrypted');
    toHook({ type: 'listen', on: false }); // stop copying
    disconnect();
    segments = [];
    onSegments(segments);
    update();
  }

  /** A plain <video src> (no MediaSource): the worker reads the file itself. */
  const isFile = (v) => !!v && /^https?:/.test(v.currentSrc || '');

  /** Pick the MediaSource the <video> plays. */
  function select() {
    if (!video) return;
    const src = video.currentSrc || video.src || '';
    for (const [id, url] of sources) {
      if (url === src && selected !== id) {
        selected = id;
        send({ type: 'select', source: id });
      }
    }
  }

  function update() {
    writeFlag();
    if (!allowed()) {
      disconnect();
      if (armed) toHook({ type: 'listen', on: false });
      set(prefs.on ? 'site-off' : 'off');
      return;
    }
    if (encrypted) return set('encrypted');
    if (captions && !prefs.always) {
      disconnect();
      if (armed) toHook({ type: 'listen', on: false });
      return set('captions');
    }
    if (armed) toHook({ type: 'listen', on: true });
    if (!video) return set('waiting');
    if (!armed && !isFile(video)) {
      // The page loaded before listening was on here: the hook is not capturing.
      return set('reload');
    }
    connect();
  }

  function clock(t, paused, ad) {
    if (!port || !Number.isFinite(t)) return;
    const moved = Math.abs(t - lastClock.t);
    if (moved < 1 && paused === lastClock.paused && ad === lastClock.ad) return;
    lastClock = { t, paused, ad };
    send({ type: 'clock', time: t, paused, ad, duration: video?.duration });
    if (paused && st.state === 'listening') set('paused');
    else if (!paused && st.state === 'paused') set('listening');
  }

  const onEncryptedEvent = () => markEncrypted();

  return {
    /** Settings from chrome.storage.local 'listening' (and the profile's language mode). */
    setPrefs(p, languageMode) {
      const before = JSON.stringify(prefs);
      prefs = { on: false, sites: {}, always: false, ...(p || {}), languageMode };
      if (JSON.stringify(prefs) !== before) {
        if (port) send({ type: 'settings', languageMode });
        update();
      }
    },
    /** A message from the page hook. */
    fromHook(type, payload) {
      if (type === 'listen-armed') {
        armed = true;
        update();
        return;
      }
      if (!armed || encrypted || !allowed() || (captions && !prefs.always)) return;
      if (type === 'audio') {
        st.appends++;
        st.bytes += payload.bytes?.byteLength || 0;
        // Queued until the worker is connected (the first appends, with the init
        // segment, usually come before the content script has found the video).
        send({ type: 'append', id: payload.id, offset: payload.offset, init: payload.init, b64: toBase64(payload.bytes) });
        if (!port) connect();
      } else if (type === 'audio-track') {
        send({ type: 'track', id: payload.id, source: payload.source, mime: payload.mime });
      } else if (type === 'audio-source') {
        sources.set(payload.source, payload.url);
        if (sources.size > 16) sources.delete(sources.keys().next().value);
        send({ type: 'source', source: payload.source, url: payload.url });
        select();
      } else if (type === 'audio-type') {
        send({ type: 'type', id: payload.id, mime: payload.mime });
      } else if (type === 'audio-abort') {
        send({ type: 'abort', id: payload.id });
      }
    },
    attach(v) {
      video?.removeEventListener('encrypted', onEncryptedEvent);
      video = v;
      if (v) {
        v.addEventListener('encrypted', onEncryptedEvent);
        if (v.mediaKeys) return markEncrypted();
        select();
        if (port && isFile(v)) send({ type: 'progressive', url: v.currentSrc });
      }
      update();
    },
    /** From the playback tick (every 100 ms while playing) and video events; sends at most once a second. */
    clock,
    seek(t) {
      lastClock.t = -1;
      clock(t, video?.paused ?? true, false);
    },
    /** A new title in this tab: what was heard belongs to the old one. */
    titleChanged() {
      segments = [];
      st.heardTo = null;
      st.words = 0;
      send({ type: 'reset' });
      captions = false;
      if (video?.mediaKeys) markEncrypted();
      update();
    },
    /** Captions were scanned for this title (they win over listening). */
    setCaptions(has) {
      if (captions === has) return;
      captions = has;
      update();
    },
    /** Use heard segments in the plan? */
    active: () => allowed() && !encrypted && (!captions || prefs.always),
    /** Connected to the speech worker (only then is the playhead worth reading). */
    live: () => !!port,
    segments: () => segments,
    snapshot: () => ({ ...st, on: prefs.on, site: allowed(), always: !!prefs.always, armed, encrypted, captions, host }),
    stop() {
      disconnect();
      video?.removeEventListener('encrypted', onEncryptedEvent);
    },
  };
}
