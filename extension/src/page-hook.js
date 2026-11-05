// Runs in the page's own JavaScript world at document_start, before the
// streaming player loads. Deliberately tiny: everything that can wait runs
// later in the content script (document_idle, see content/network.js).
//
// What has to be here, because it must exist before the player starts:
//  1. fetch / XMLHttpRequest wrappers that notice the few responses CleanCut
//     uses (episode metadata, the manifest listing subtitle tracks, subtitle
//     files). Requests whose URL cannot matter are passed straight through:
//     no listener, no clone, nothing stored on the request object (that
//     includes every media segment and every API call but those few).
//  2. On Netflix, the subtitle track list. Netflix encrypts its manifest
//     responses (MSL), so it is only readable once the player has decrypted
//     and JSON.parse'd it; see the JSON.parse wrapper below.
//  3. The Netflix seek bridge: assigning video.currentTime directly crashes
//     the Netflix player (error M7375), so seeks go through its own API.
//  4. On YouTube (and Vimeo embeds), the player data the page carries inline
//     for its first video, read once when the document has been parsed.
//  5. Listening ahead, only on a site where the viewer turned it on: a copy of
//     what the player appends to its audio SourceBuffers, for the speech
//     model (see the section below). Off, nothing of it is installed.
//
// Talking to the content script: nothing is broadcast with window.postMessage.
// Every window 'message' listener in the page (the site's own schedulers,
// other extensions' content scripts) would receive, and copy, each response
// body. Instead the content script asks for a private MessageChannel once
// (a 'cleancut:connect' DOM event); findings go only through that port, and
// the few found before it connects are kept (bounded) and handed over then.

import { MAX_INSPECT_BYTES, classifyResponse, manifestHasText, mayMatter, netflixManifestInfo, vimeoConfigInfo, youtubePlayerInfo } from '../../shared/sources.js';
import { isInitSegment } from '../../shared/media.js';

(() => {
  if (window.__cleancutHooked) return;
  Object.defineProperty(window, '__cleancutHooked', { value: true });

  const HOST = location.hostname;
  const origFetch = window.fetch;

  let port = null;
  const backlog = []; // findings made before the content script connected
  const MAX_BACKLOG = 12;
  const send = (msg) => {
    if (port) return port.postMessage(msg);
    backlog.push(msg);
    if (backlog.length > MAX_BACKLOG) {
      // Drop the oldest response body first; track lists are tiny and rare.
      const i = backlog.findIndex((m) => m.type === 'response');
      backlog.splice(i < 0 ? 0 : i, 1);
    }
  };
  const forward = (url, kind, body) => send({ type: 'response', payload: { url, kind, body } });
  // HLS/DASH manifests are passed on only when they list subtitle renditions:
  // a live stream's media playlists are fetched every few seconds.
  const worthForwarding = (kind, body) => kind !== 'manifest' || manifestHasText(body);

  // ---- debug log (off unless the viewer turned it on in the popup) ----------
  // Records what the player does, as shapes and counts only: field names of
  // parsed responses, hosts and paths of requests (never query strings,
  // cookies or bodies). The flag is read from the page's localStorage, which
  // the content script sets, so it is known before the player starts.
  let DEBUG = false;
  try {
    DEBUG = window.localStorage.getItem('cleancut:debug') === '1';
  } catch { /* storage blocked */ }
  const debugBacklog = [];
  const dbg = (entry) => {
    if (!DEBUG) return;
    const msg = { type: 'debug', payload: { t: Math.round(performance.now()), ...entry } };
    if (port) return port.postMessage(msg);
    if (debugBacklog.length < 400) debugBacklog.push(msg);
  };
  const strip = (u) => {
    try {
      const x = new URL(String(u), location.href);
      return `${x.protocol === 'wss:' || x.protocol === 'ws:' ? x.protocol : ''}${x.hostname}${x.pathname}`;
    } catch {
      return String(u).split('?')[0].slice(0, 200);
    }
  };
  const net = new Map(); // "via method host/path" → { n, bytes, types, statuses }
  function netNote(via, method, url, status, type, bytes, extra) {
    if (!DEBUG) return;
    const key = `${via} ${method || 'GET'} ${strip(url).replace(/\d{3,}/g, '#')}`;
    const e = net.get(key) || { n: 0, bytes: 0, types: new Set(), statuses: new Set() };
    e.n++;
    e.bytes += bytes || 0;
    if (type) e.types.add(type);
    if (status != null) e.statuses.add(status);
    net.set(key, e);
    if (extra) dbg({ ev: 'net-text', via, url: strip(url), status, type, bytes, ...extra });
  }
  const TEXTY = /ttml|vtt|dfxp|(application|text)\/xml|text\/plain/i;
  const INTEREST = /texttrack|audio_?tracks|video_?tracks|manifest|movieid|viewableid|timedtext|subtitle|downloadable/i;
  let shapes = 0;
  function shapeOf(v) {
    const r = v.result !== null && typeof v.result === 'object' && !Array.isArray(v.result) ? v.result : null;
    const top = Object.keys(v);
    const inner = r ? Object.keys(r) : [];
    if (!top.some((k) => INTEREST.test(k)) && !inner.some((k) => INTEREST.test(k))) return null;
    const m = r || v;
    const arrays = {};
    for (const k of Object.keys(m)) {
      if (!/tracks$/i.test(k) || !Array.isArray(m[k])) continue;
      const a = m[k];
      arrays[k] = { n: a.length, first: a[0] && typeof a[0] === 'object' ? Object.keys(a[0]).slice(0, 40) : typeof a[0] };
      if (/text/i.test(k)) {
        arrays[k].tracks = a.slice(0, 40).map((t) => {
          if (!t || typeof t !== 'object') return String(t);
          const d = t.ttDownloadables || t.downloadables || {};
          const links = Object.values(d).reduce((n, x) => n + ((x && Array.isArray(x.urls) && x.urls.length) || (x && x.downloadUrls ? Object.keys(x.downloadUrls).length : 0)), 0);
          return `${t.language}|${t.trackType || ''}|${t.rawTrackType || ''}|hydrated:${t.hydrated}|none:${!!t.isNoneTrack}|${Object.keys(d).join('+')}|links:${links}`;
        });
      }
    }
    return { top: top.slice(0, 30), result: inner.slice(0, 60), movieId: m.movieId ?? m.viewableId ?? null, version: m.manifestVersion ?? v.version ?? null, arrays };
  }

  // ---- listening ahead: the audio the player buffers ------------------------
  // Only where the viewer turned listening on for this site: the content
  // script keeps 'cleancut:listen' in the site's localStorage, and it is read
  // here, before the player starts, like the debug flag. Off (the default),
  // nothing below runs and no prototype is touched.
  //
  // On: MediaSource.addSourceBuffer notes which SourceBuffers carry audio (by
  // MIME type), and appendBuffer hands a copy of what the player appends to
  // those to the content script (transferred, not cloned), with the
  // SourceBuffer's timestampOffset. Video SourceBuffers are never touched
  // beyond one WeakMap lookup. No parsing here: one look at the first bytes
  // says whether a chunk is an initialization segment (kept if the content
  // script has not connected yet). If the viewer switches listening off while
  // the page is open, each append costs one boolean check.
  let LISTEN = false;
  try {
    LISTEN = window.localStorage.getItem('cleancut:listen') === '1';
  } catch { /* storage blocked */ }
  const audioTap = LISTEN && typeof MediaSource === 'function' && typeof SourceBuffer === 'function' ? tapAudio() : null;

  function tapAudio() {
    let on = true;
    const tracked = new WeakMap(); // SourceBuffer → track id
    const sourceIds = new WeakMap(); // MediaSource → id
    let seq = 0;
    // Before the content script connects (it loads at document_idle, the player
    // starts earlier): track announcements, init segments and up to 6 MB of media.
    const early = [];
    let earlyBytes = 0;
    const post = (msg, transfer) => {
      if (port) return port.postMessage(msg, transfer || []);
      early.push(msg);
      earlyBytes += msg.payload.bytes?.byteLength || 0;
      while (earlyBytes > 6 * 1024 * 1024) {
        const i = early.findIndex((m) => m.type === 'audio' && !m.payload.init);
        if (i < 0) break;
        earlyBytes -= early[i].payload.bytes.byteLength;
        early.splice(i, 1);
      }
    };
    const sourceId = (ms) => {
      let id = sourceIds.get(ms);
      if (!id) sourceIds.set(ms, (id = ++seq));
      return id;
    };
    const wrap = (proto, name, make) => {
      const orig = proto[name];
      if (typeof orig !== 'function') return;
      // An object-literal method keeps the original's name (fn.name) for sites that look.
      proto[name] = { [name]: make(orig) }[name];
    };

    wrap(MediaSource.prototype, 'addSourceBuffer', (orig) => function (type) {
      const sb = orig.apply(this, arguments);
      if (on) {
        try {
          if (/^\s*audio\//i.test(String(type))) {
            const id = ++seq;
            tracked.set(sb, id);
            post({ type: 'audio-track', payload: { id, source: sourceId(this), mime: String(type) } });
          }
        } catch { /* never break the player */ }
      }
      return sb;
    });
    const copy = (sb, data) => {
      const id = tracked.get(sb);
      if (!id) return;
      const view = data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (!view?.byteLength) return;
      const bytes = view.slice().buffer; // a copy: players reuse their buffers
      post({ type: 'audio', payload: { id, bytes, offset: sb.timestampOffset, init: isInitSegment(view) } }, [bytes]);
    };
    for (const name of ['appendBuffer', 'appendBufferAsync']) {
      wrap(SourceBuffer.prototype, name, (orig) => function (data) {
        if (on) {
          try {
            copy(this, data);
          } catch { /* never break the player */ }
        }
        return orig.apply(this, arguments);
      });
    }
    wrap(SourceBuffer.prototype, 'changeType', (orig) => function (type) {
      if (on && tracked.has(this)) post({ type: 'audio-type', payload: { id: tracked.get(this), mime: String(type) } });
      return orig.apply(this, arguments);
    });
    wrap(SourceBuffer.prototype, 'abort', (orig) => function () {
      if (on && tracked.has(this)) post({ type: 'audio-abort', payload: { id: tracked.get(this) } });
      return orig.apply(this, arguments);
    });
    // Which <video> plays which MediaSource: the object URL made for it.
    wrap(URL, 'createObjectURL', (orig) => function (obj) {
      const url = orig.apply(this, arguments);
      if (on) {
        try {
          if (obj instanceof MediaSource) post({ type: 'audio-source', payload: { source: sourceId(obj), url } });
        } catch { /* never break the page */ }
      }
      return url;
    });
    return {
      set(v) {
        on = !!v;
        if (!on) early.length = 0;
      },
      flush() {
        for (const msg of early.splice(0)) port.postMessage(msg, msg.payload.bytes ? [msg.payload.bytes] : []);
        earlyBytes = 0;
      },
    };
  }

  // ---- Netflix: subtitle tracks from the decrypted manifest -----------------
  // The player fetches manifests over MSL (encrypted, often over a WebSocket),
  // so they are unreadable on the network. It decrypts them and parses the
  // text with JSON.parse; the wrapper looks at the shape of each result (a few
  // property reads) and, for a manifest (v1 `timedtexttracks` or v2+
  // `textTracks`), passes on just its English subtitle URLs. The value
  // returned to the player is the very same object.
  if (/(^|\.)netflix\.com$/.test(HOST)) {
    const origParse = JSON.parse;
    JSON.parse = function parse(text, reviver) {
      const value = origParse.apply(JSON, arguments);
      try {
        if (DEBUG && value !== null && typeof value === 'object' && shapes < 80) {
          const shape = shapeOf(value);
          if (shape) {
            shapes++;
            dbg({ ev: 'parse', bytes: typeof text === 'string' ? text.length : null, ...shape });
          }
        }
        if (value !== null && typeof value === 'object') {
          const m = value.result !== null && typeof value.result === 'object' ? value.result : value;
          if (m.movieId != null && (Array.isArray(m.timedtexttracks) || Array.isArray(m.textTracks))) {
            const info = netflixManifestInfo(m);
            send({ type: 'tracks', payload: { ...info, via: 'decrypted' } });
          }
        }
      } catch { /* never break the page */ }
      return value;
    };
  }

  // ---- YouTube and Vimeo: the player data the page itself carries ------------
  // The first video of a page load is described inline (not fetched):
  // ytInitialPlayerResponse on YouTube, window.playerConfig in a Vimeo embed.
  // Read once, when the document has been parsed. In-app navigations on
  // YouTube hand the new player response to the 'yt-navigate-finish' event
  // (and fetch it from /youtubei/v1/player, which mayMatter lets through).
  // Only the video id, its title and its English caption track URLs are sent.
  const playerData = (extract, data, via) => {
    try {
      const info = data && extract(data);
      if (!info) return;
      dbg({ ev: 'player-data', via, id: info.movieId, tracks: info.tracks.length });
      send({ type: 'tracks', payload: { ...info, via } });
    } catch { /* never break the page */ }
  };
  if (/(^|\.)youtube(-nocookie)?\.com$/.test(HOST)) {
    document.addEventListener('DOMContentLoaded', () => playerData(youtubePlayerInfo, window.ytInitialPlayerResponse, 'page'), { once: true });
    document.addEventListener('yt-navigate-finish', (e) => playerData(youtubePlayerInfo, e?.detail?.response?.playerResponse, 'navigate'));
  } else if (HOST === 'player.vimeo.com') {
    document.addEventListener('DOMContentLoaded', () => playerData(vimeoConfigInfo, window.playerConfig, 'page'), { once: true });
  }

  window.fetch = function fetch(input, init) {
    const pending = origFetch.call(window, input, init);
    let url;
    try {
      url = typeof input === 'string' ? input : input?.url || String(input);
    } catch {
      return pending;
    }
    if (DEBUG) {
      const method = init?.method || input?.method || 'GET';
      pending.then((res) => {
        const type = res.headers.get('content-type') || '';
        const bytes = Number(res.headers.get('content-length') || 0);
        netNote('fetch', method, url, res.status, type, bytes, TEXTY.test(type) ? { candidate: true } : null);
      }, (e) => netNote('fetch', method, url, 'failed', '', 0, { error: String(e?.message || e).slice(0, 120) }));
    }
    if (!mayMatter(url, HOST)) return pending; // nearly every request: untouched
    pending.then((res) => {
      try {
        const kind = classifyResponse(url, HOST, {
          contentType: res.headers.get('content-type') || '',
          length: Number(res.headers.get('content-length') || 0),
        });
        // 'peek' (unlabelled binary) is never cloned from fetch: it costs more than it finds.
        if (kind === 'json' || kind === 'subtitle' || kind === 'manifest') {
          res.clone().text().then((t) => worthForwarding(kind, t) && forward(url, kind, t), () => {});
        }
      } catch { /* never break the player */ }
    }, () => {});
    return pending; // the player gets the very same promise
  };

  // Only requests that may matter are remembered (in a WeakMap, so the
  // player's XHR objects stay unmodified and are collected as usual).
  const watched = new WeakMap();
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  const debugXhr = new WeakMap();
  function onDebugXhr() {
    try {
      const d = debugXhr.get(this);
      const type = this.getResponseHeader('content-type') || '';
      const rt = this.responseType;
      let bytes = Number(this.getResponseHeader('content-length') || 0);
      let extra = null;
      if (TEXTY.test(type) || ((rt === '' || rt === 'text') && /nflxvideo|nflxso|oca\./.test(d.url))) {
        const text = rt === '' || rt === 'text' ? this.responseText : '';
        bytes = bytes || text.length;
        extra = { candidate: true, responseType: rt, head: text.slice(0, 60).replace(/\s+/g, ' ') };
      }
      netNote('xhr', d.method, d.url, this.status, type || `(none, ${rt || 'text'})`, bytes, extra);
    } catch { /* ignore */ }
  }
  XHR.open = function open(method, url, ...rest) {
    if (DEBUG) debugXhr.set(this, { method, url: String(url) });
    const u = String(url);
    if (mayMatter(u, HOST)) watched.set(this, u);
    else if (watched.has(this)) watched.delete(this); // an XHR object reused for another URL
    return origOpen.call(this, method, url, ...rest);
  };
  function onXhrLoad() {
    try {
      const url = watched.get(this) || '';
      const rt = this.responseType;
      const binary = rt === 'arraybuffer';
      // URL and headers only: touching this.response here would materialise the body.
      const kind = classifyResponse(url, HOST, {
        contentType: this.getResponseHeader('content-type') || '',
        length: Number(this.getResponseHeader('content-length') || 0),
        binary,
      });
      if (!kind) return;
      if (rt === 'json') return kind !== 'manifest' && forward(url, kind, this.response);
      if (rt === '' || rt === 'text') return worthForwarding(kind, this.responseText) && forward(url, kind, this.responseText);
      if (binary && kind !== 'peek' && this.response && this.response.byteLength <= MAX_INSPECT_BYTES) {
        const text = new TextDecoder().decode(this.response);
        if (worthForwarding(kind, text)) forward(url, kind, text);
      }
    } catch { /* ignore */ }
  }
  XHR.send = function send(...args) {
    if (DEBUG && debugXhr.has(this)) this.addEventListener('loadend', onDebugXhr, { once: true });
    if (watched.has(this)) this.addEventListener('load', onXhrLoad, { once: true });
    return origSend.apply(this, args);
  };

  if (DEBUG && typeof window.WebSocket === 'function') {
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target, args) {
        dbg({ ev: 'websocket', url: strip(args[0]) });
        return Reflect.construct(target, args);
      },
    });
  }
  dbg({ ev: 'hook', path: location.pathname, debug: true });

  // ---- Netflix seek bridge -------------------------------------------------
  function netflixPlayer() {
    try {
      const vp = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
      const ids = vp?.getAllPlayerSessionIds?.() || [];
      const id = ids.find((s) => s.startsWith('watch')) || ids[0];
      return id ? vp.getVideoPlayerBySessionId(id) : null;
    } catch {
      return null;
    }
  }

  // Fallback download from the page itself: same origin and network stack as
  // the player's own subtitle requests, for a CDN that refuses the content script.
  function pageFetch(url, reqId) {
    origFetch.call(window, url)
      .then(async (res) => ({ ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' }))
      .catch((e) => ({ ok: false, status: 0, error: String(e?.message || e) }))
      .then((r) => port?.postMessage({ type: 'fetch-result', payload: { reqId, ...r } }));
  }

  function onContentMessage(e) {
    const { type, seconds, reqId, url } = e.data || {};
    if (type === 'fetch' && typeof url === 'string') return pageFetch(url, reqId);
    if (type === 'listen') return audioTap?.set(e.data.on);
    if (type === 'debug-dump') {
      const summary = [...net].map(([k, e]) => ({ request: k, n: e.n, kb: Math.round(e.bytes / 1024), types: [...e.types].slice(0, 4), statuses: [...e.statuses].slice(0, 4) }))
        .sort((a, b) => b.n - a.n).slice(0, 150);
      return port?.postMessage({ type: 'debug-dump', payload: { reqId, debug: DEBUG, network: summary, parseShapes: shapes } });
    }
    if (type !== 'seek') return;
    const p = netflixPlayer();
    let ok = false;
    if (p && Number.isFinite(seconds)) {
      try {
        p.seek(Math.round(seconds * 1000));
        ok = true;
      } catch { /* fall through */ }
    }
    port?.postMessage({ type: 'seek-result', payload: { reqId, ok } });
  }

  // The content script (isolated world) asks for a channel; the port travels
  // in one small window message, the only one CleanCut ever posts.
  document.addEventListener('cleancut:connect', () => {
    const channel = new MessageChannel();
    port?.close();
    port = channel.port1;
    port.onmessage = onContentMessage;
    window.postMessage({ __cleancut: 'port' }, location.origin, [channel.port2]);
    for (const msg of backlog.splice(0)) port.postMessage(msg);
    for (const msg of debugBacklog.splice(0)) port.postMessage(msg);
    if (audioTap) {
      port.postMessage({ type: 'listen-armed', payload: {} });
      audioTap.flush();
    }
  });
})();
