// Runs in the page's own JavaScript world (manifest "world": "MAIN") at
// document_start, before the streaming player loads.
//
// Jobs:
//  1. Watch the player's own network responses for (a) episode metadata and
//     (b) subtitle track URLs, then fetch the full English (SDH preferred)
//     track so the content script can analyze the whole episode ahead of
//     playback. Nothing is sent anywhere; results go to the content script.
//  2. Seek bridge for Netflix: assigning video.currentTime directly crashes
//     the Netflix player (error M7375), so seeks go through its own API.
//
// Messages are window.postMessage with { __cleancut: 'page' | 'content' }.

import {
  MAX_INSPECT_BYTES,
  classifyResponse,
  extractNetflixMetadata,
  extractNetflixTimedText,
  extractPrimeSubtitles,
  extractPrimeTitle,
  looksLikeSubtitle,
} from '../../shared/sources.js';

(() => {
  if (window.__cleancutHooked) return;
  window.__cleancutHooked = true;

  const HOST = location.hostname;
  const IS_NETFLIX = /(^|\.)netflix\.com$/.test(HOST);
  const origFetch = window.fetch.bind(window);
  const fetchedSubs = new Set();

  // The content script loads later (document_idle) than this hook
  // (document_start), so findings are kept and replayed when it says hello.
  // Only the latest of each kind is kept: subtitle files are large.
  const backlog = new Map();
  const post = (type, payload, key = type) => {
    if (type !== 'seek-result') {
      backlog.delete(key);
      backlog.set(key, { type, payload });
      if (backlog.size > 6) backlog.delete(backlog.keys().next().value);
    }
    window.postMessage({ __cleancut: 'page', type, payload }, location.origin);
  };

  // Parsing waits until the player has finished handling the response, so it
  // never lengthens the player's own task.
  const later = (fn) => setTimeout(() => {
    try { fn(); } catch { /* never break the page */ }
  }, 0);

  function postSubtitles(url, text, extra) {
    if (fetchedSubs.has(url)) return;
    fetchedSubs.add(url);
    post('subtitles', { url, text, ...extra }, `subtitles:${extra.forId ?? ''}`);
  }

  function inspectText(url, text, kind) {
    if (!text) return;
    if (kind === 'subtitle' || kind === 'peek') {
      if (looksLikeSubtitle(text)) postSubtitles(url, text, { forId: null, passive: true });
      return;
    }
    let json;
    try { json = JSON.parse(text); } catch { return; }
    inspectJson(url, json);
  }

  function inspectJson(url, json) {
    if (IS_NETFLIX) {
      const meta = extractNetflixMetadata(json);
      if (Object.keys(meta).length) post('netflix-metadata', meta);
      const tracks = extractNetflixTimedText(json);
      if (tracks.length) {
        const forId = String(json?.result?.movieId ?? json?.movieId ?? '') || null;
        fetchSubtitle(tracks, forId);
      }
    } else {
      const title = extractPrimeTitle(json);
      if (title) post('prime-title', title);
      const tracks = extractPrimeSubtitles(json);
      if (tracks.length) {
        const asin = title?.asin || new URL(url, location.href).searchParams.get('asin');
        fetchSubtitle(tracks, asin || null);
      }
    }
  }

  async function fetchSubtitle(tracks, forId) {
    for (const track of tracks.slice(0, 3)) {
      if (fetchedSubs.has(track.url)) return;
      try {
        const res = await origFetch(track.url, { credentials: 'omit' });
        if (!res.ok) continue;
        const text = await res.text();
        if (!looksLikeSubtitle(text)) continue;
        postSubtitles(track.url, text, { forId, sdh: track.sdh, language: track.language });
        return;
      } catch {
        // CDN refused or format we cannot read; try the next track.
      }
    }
  }

  // ---- fetch ---------------------------------------------------------------
  window.fetch = async function (input, init) {
    const res = await origFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      const kind = classifyResponse(url, HOST, {
        contentType: res.headers.get('content-type') || '',
        length: Number(res.headers.get('content-length') || 0),
      });
      // 'peek' never applies to fetch: cloning a media stream to look at it
      // would cost more than it could find.
      if (kind === 'json' || kind === 'subtitle') {
        res.clone().text().then((t) => later(() => inspectText(url, t, kind)), () => {});
      }
    } catch { /* never break the player */ }
    return res;
  };

  // ---- XMLHttpRequest ------------------------------------------------------
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
      // Decide from the URL and headers only. Touching this.response here would
      // materialise every media segment as an ArrayBuffer.
      const kind = classifyResponse(url, HOST, {
        contentType: this.getResponseHeader('content-type') || '',
        length: Number(this.getResponseHeader('content-length') || 0),
        binary,
      });
      if (!kind) return;
      if (binary && this.response?.byteLength > MAX_INSPECT_BYTES) return;
      if (rt === 'json') {
        const json = this.response;
        if (json) later(() => inspectJson(url, json));
      } else if (rt === '' || rt === 'text') {
        const text = this.responseText;
        later(() => inspectText(url, text, kind));
      } else if (binary && this.response) {
        const buf = this.response;
        if (kind === 'peek') {
          // Media segments land here too: look at a few bytes, decode only captions.
          const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(300, buf.byteLength)));
          if (!looksLikeSubtitle(head)) return;
        }
        later(() => inspectText(url, new TextDecoder().decode(buf), kind));
      }
    } catch { /* ignore */ }
  }
  XHR.send = function (...args) {
    this.addEventListener('load', onXhrLoad);
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
      for (const m of backlog.values()) window.postMessage({ __cleancut: 'page', ...m }, location.origin);
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

  post('hook-ready', {});
})();
