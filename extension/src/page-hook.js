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
//
// Talking to the content script: nothing is broadcast with window.postMessage.
// Every window 'message' listener in the page (the site's own schedulers,
// other extensions' content scripts) would receive, and copy, each response
// body. Instead the content script asks for a private MessageChannel once
// (a 'cleancut:connect' DOM event); findings go only through that port, and
// the few found before it connects are kept (bounded) and handed over then.

import { MAX_INSPECT_BYTES, classifyResponse, extractNetflixTimedText, mayMatter } from '../../shared/sources.js';

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

  // ---- Netflix: subtitle tracks from the decrypted manifest -----------------
  // The manifest arrives encrypted, so reading it off the network finds
  // nothing. The player decrypts it and parses it with JSON.parse; the wrapper
  // looks at the shape of each result (a couple of property reads) and, for a
  // manifest, passes on just its English subtitle URLs (a few hundred bytes).
  // The value returned to the player is the very same object.
  if (/(^|\.)netflix\.com$/.test(HOST)) {
    const origParse = JSON.parse;
    JSON.parse = function parse(text, reviver) {
      const value = origParse.apply(JSON, arguments);
      try {
        if (value !== null && typeof value === 'object') {
          const m = value.result && typeof value.result === 'object' ? value.result : value;
          if (Array.isArray(m.timedtexttracks) && m.movieId != null) {
            const tracks = extractNetflixTimedText(m);
            if (tracks.length) send({ type: 'tracks', payload: { forId: String(m.movieId), tracks } });
          }
        }
      } catch { /* never break the page */ }
      return value;
    };
  }

  window.fetch = function fetch(input, init) {
    const pending = origFetch.call(window, input, init);
    let url;
    try {
      url = typeof input === 'string' ? input : input?.url || String(input);
    } catch {
      return pending;
    }
    if (!mayMatter(url, HOST)) return pending; // nearly every request: untouched
    pending.then((res) => {
      try {
        const kind = classifyResponse(url, HOST, {
          contentType: res.headers.get('content-type') || '',
          length: Number(res.headers.get('content-length') || 0),
        });
        // 'peek' (unlabelled binary) is never cloned from fetch: it costs more than it finds.
        if (kind === 'json' || kind === 'subtitle') res.clone().text().then((t) => forward(url, kind, t), () => {});
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
  XHR.open = function open(method, url, ...rest) {
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
      if (rt === 'json') return forward(url, kind, this.response);
      if (rt === '' || rt === 'text') return forward(url, kind, this.responseText);
      if (binary && kind !== 'peek' && this.response && this.response.byteLength <= MAX_INSPECT_BYTES) {
        forward(url, kind, new TextDecoder().decode(this.response));
      }
    } catch { /* ignore */ }
  }
  XHR.send = function send(...args) {
    if (watched.has(this)) this.addEventListener('load', onXhrLoad, { once: true });
    return origSend.apply(this, args);
  };

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

  function onContentMessage(e) {
    const { type, seconds, reqId } = e.data || {};
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
  });
})();
