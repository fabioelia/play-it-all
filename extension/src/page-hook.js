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
  extractNetflixMetadata,
  extractNetflixTimedText,
  extractPrimeSubtitles,
  extractPrimeTitle,
  looksLikeSubtitle,
} from '../../shared/sources.js';

(() => {
  if (window.__cleancutHooked) return;
  window.__cleancutHooked = true;

  const MAX_BODY = 8 * 1024 * 1024;
  const origFetch = window.fetch.bind(window);
  const fetchedSubs = new Set();

  const post = (type, payload) => window.postMessage({ __cleancut: 'page', type, payload }, location.origin);

  const INTERESTING = /manifest|metadata|GetPlaybackResources|playback|timedtext|subtitle|caption|\.vtt|\.dfxp|\.ttml|\.xml|\?o=/i;

  function inspectText(url, text) {
    if (!text || text.length > MAX_BODY) return;
    if (looksLikeSubtitle(text)) {
      if (fetchedSubs.has(url)) return;
      fetchedSubs.add(url);
      post('subtitles', { url, text, forId: null, passive: true });
      return;
    }
    const first = text.trimStart()[0];
    if (first !== '{' && first !== '[') return;
    let json;
    try { json = JSON.parse(text); } catch { return; }
    inspectJson(url, json);
  }

  function inspectJson(url, json) {
    if (/netflix/.test(location.hostname)) {
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
        fetchedSubs.add(track.url);
        post('subtitles', { url: track.url, text, forId, sdh: track.sdh, language: track.language });
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
      const type = res.headers.get('content-type') || '';
      const len = Number(res.headers.get('content-length') || 0);
      if (len <= MAX_BODY && (INTERESTING.test(url) || /json|xml|vtt|ttml/.test(type)) && !/video|audio|octet/.test(type)) {
        res.clone().text().then((t) => inspectText(url, t)).catch(() => {});
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
  XHR.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        const url = this.__ccUrl || '';
        const rt = this.responseType;
        if (rt === '' || rt === 'text') {
          if (INTERESTING.test(url) || looksLikeSubtitle(this.responseText.slice(0, 300))) inspectText(url, this.responseText);
        } else if (rt === 'json') {
          if (this.response && INTERESTING.test(url)) inspectJson(url, this.response);
        } else if (rt === 'arraybuffer' && this.response && this.response.byteLength <= MAX_BODY) {
          // Video segments arrive here too: peek at a few bytes before decoding.
          const head = new TextDecoder().decode(new Uint8Array(this.response, 0, Math.min(300, this.response.byteLength)));
          if (looksLikeSubtitle(head) || (INTERESTING.test(url) && /^\s*[{[]/.test(head))) {
            inspectText(url, new TextDecoder().decode(this.response));
          }
        }
      } catch { /* ignore */ }
    });
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
    if (type === 'seek') {
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
