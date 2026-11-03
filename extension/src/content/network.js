// Everything the page hook does not have to do early: parse the responses it
// forwarded, learn what episode is playing and where its subtitle track is,
// and download that track. Runs in the content script (document_idle), after
// the streaming player has initialised.

import {
  extractNetflixMetadata,
  extractNetflixTimedText,
  extractPrimeSubtitles,
  extractPrimeTitle,
  looksLikeSubtitle,
} from '../../../shared/sources.js';

/**
 * @param {(type: string, payload: object) => void} emit
 *   receives 'netflix-metadata', 'prime-title' and 'subtitles' messages
 */
export function createNetworkInspector(emit) {
  const isNetflix = /(^|\.)netflix\.com$/.test(location.hostname);
  const seen = new Set();

  function subtitles(url, text, extra) {
    if (seen.has(url) || !looksLikeSubtitle(text)) return false;
    seen.add(url);
    emit('subtitles', { url, text, ...extra });
    return true;
  }

  async function fetchSubtitle(tracks, forId) {
    for (const track of tracks.slice(0, 3)) {
      const url = new URL(track.url, location.href).href;
      if (seen.has(url)) return;
      try {
        const res = await fetch(url, { credentials: 'omit' });
        if (res.ok && subtitles(url, await res.text(), { forId, sdh: track.sdh, language: track.language })) return;
      } catch {
        // CDN refused or format we cannot read; try the next track.
      }
    }
  }

  function inspectJson(url, json) {
    if (isNetflix) {
      const meta = extractNetflixMetadata(json);
      if (Object.keys(meta).length) emit('netflix-metadata', meta);
      const tracks = extractNetflixTimedText(json);
      if (tracks.length) fetchSubtitle(tracks, String(json?.result?.movieId ?? json?.movieId ?? '') || null);
    } else {
      const title = extractPrimeTitle(json);
      if (title) emit('prime-title', title);
      const tracks = extractPrimeSubtitles(json);
      if (tracks.length) fetchSubtitle(tracks, title?.asin || new URL(url, location.href).searchParams.get('asin') || null);
    }
  }

  /** A response forwarded by the page hook: { url, kind: 'json'|'subtitle', body }. */
  return function handleResponse({ url, kind, body }) {
    try {
      if (kind === 'subtitle') {
        if (typeof body === 'string') subtitles(url, body, { forId: null, passive: true });
        return;
      }
      const json = typeof body === 'string' ? JSON.parse(body) : body;
      if (json && typeof json === 'object') inspectJson(url, json);
    } catch {
      // Not the JSON we expected; ignore.
    }
  };
}
