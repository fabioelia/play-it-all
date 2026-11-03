// Runs in the page's own JavaScript world at document_start, before the
// streaming player loads. Deliberately tiny: everything that can wait runs
// later in the content script (document_idle, see content/network.js).
//
// What has to be here, because it must exist before the player starts:
//  1. fetch / XMLHttpRequest wrappers that notice the few responses CleanCut
//     uses (episode metadata, the manifest listing subtitle tracks, subtitle
//     files). Requests whose URL cannot matter get no listener at all (that
//     includes every media segment); the rest are checked by headers, never
//     parsed here, and their raw body is passed on.
//  2. The Netflix seek bridge: assigning video.currentTime directly crashes
//     the Netflix player (error M7375), so seeks go through its own API.
//
// Messages are window.postMessage with { __cleancut: 'page' | 'content' }.

import { MAX_INSPECT_BYTES, classifyResponse, mayMatter } from '../../shared/sources.js';

(() => {
  if (window.__cleancutHooked) return;
  window.__cleancutHooked = true;

  const HOST = location.hostname;
  const origFetch = window.fetch.bind(window);

  // The content script loads later, so the last few findings are kept and
  // replayed when it says hello.
  const backlog = [];
  const post = (type, payload) => {
    if (type === 'response') {
      backlog.push({ type, payload });
      if (backlog.length > 6) backlog.shift();
    }
    window.postMessage({ __cleancut: 'page', type, payload }, location.origin);
  };
  const forward = (url, kind, body) => post('response', { url, kind, body });

  window.fetch = function (input, init) {
    const pending = origFetch(input, init);
    let url;
    try {
      url = typeof input === 'string' ? input : input?.url || String(input);
    } catch {
      return pending;
    }
    if (!mayMatter(url)) return pending; // nearly every request: untouched
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

  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (method, url, ...rest) {
    this.__ccUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };
  function onXhrLoad() {
    try {
      const url = this.__ccUrl || '';
      const rt = this.responseType;
      const binary = rt === 'arraybuffer';
      // URL and headers only: touching this.response here would materialise
      // every media segment.
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
  XHR.send = function (...args) {
    if (mayMatter(this.__ccUrl || '')) this.addEventListener('load', onXhrLoad);
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

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__cleancut !== 'content') return;
    const { type, seconds, reqId } = e.data;
    if (type === 'hello') {
      for (const m of backlog) window.postMessage({ __cleancut: 'page', ...m }, location.origin);
    } else if (type === 'seek') {
      const p = netflixPlayer();
      let ok = false;
      if (p && Number.isFinite(seconds)) {
        try {
          p.seek(Math.round(seconds * 1000));
          ok = true;
        } catch { /* fall through */ }
      }
      post('seek-result', { reqId, ok });
    }
  });
})();
