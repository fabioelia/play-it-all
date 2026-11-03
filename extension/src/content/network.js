// Everything the page hook does not have to do early: parse the responses it
// forwarded, learn what episode is playing and where its subtitle track is,
// and download that track. Runs in the content script (document_idle).
//
// Players fetch manifests for far more titles than the one being watched:
// Netflix prefetches them for titles on the browse page (billboard, previews,
// Continue Watching) and for the next episode. So while no title is playing,
// bodies are only parsed in idle time, just their track lists are kept, and a
// subtitle track is downloaded only for the title in the player.

import {
  extractNetflixMetadata,
  extractNetflixTimedText,
  extractPrimeSubtitles,
  extractPrimeTitle,
  looksLikeSubtitle,
} from '../../../shared/sources.js';

const MAX_QUEUED = 8; // unparsed bodies kept while nothing plays
const MAX_TITLES = 32; // track lists remembered (URLs only), oldest dropped

/**
 * @param {(type: string, payload: object) => void} emit
 *   receives 'netflix-metadata', 'prime-title' and 'subtitles' messages
 */
export function createNetworkInspector(emit) {
  const isNetflix = /(^|\.)netflix\.com$/.test(location.hostname);
  const seen = new Set(); // subtitle URLs already handed over
  const queued = []; // forwarded bodies not parsed yet
  const tracksFor = new Map(); // title id ('' = unknown) → subtitle tracks, best first
  let active = false; // a title is in the player: parse as responses arrive
  let wanted = null; // platform id of the title playing

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

  function remember(forId, tracks) {
    const key = forId || '';
    tracksFor.delete(key);
    tracksFor.set(key, tracks);
    if (tracksFor.size > MAX_TITLES) tracksFor.delete(tracksFor.keys().next().value);
    // Only the title being watched is downloaded; a track for an unknown id
    // can only belong to it.
    if (wanted && (key === wanted || key === '')) fetchSubtitle(tracks, forId || null);
  }

  function inspectJson(url, json) {
    if (isNetflix) {
      const meta = extractNetflixMetadata(json);
      if (Object.keys(meta).length) emit('netflix-metadata', meta);
      const tracks = extractNetflixTimedText(json);
      if (tracks.length) remember(String(json?.result?.movieId ?? json?.movieId ?? ''), tracks);
    } else {
      const title = extractPrimeTitle(json);
      if (title) emit('prime-title', title);
      const tracks = extractPrimeSubtitles(json);
      if (tracks.length) remember(title?.asin || new URL(url, location.href).searchParams.get('asin') || '', tracks);
    }
  }

  function parse({ url, kind, body }) {
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
  }

  // While browsing, bodies are parsed one at a time when the page is idle and
  // only their track lists (a few URLs) are kept; the bodies are dropped.
  let idleScheduled = false;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 0, didTimeout: true }), 500));
  function drain(deadline) {
    idleScheduled = false;
    do {
      const next = queued.shift();
      if (!next) return;
      parse(next);
    } while (deadline.timeRemaining() > 5);
    if (queued.length) schedule();
  }
  function schedule() {
    if (idleScheduled || !queued.length) return;
    idleScheduled = true;
    idle(drain, { timeout: 10_000 });
  }

  return {
    /** A response forwarded by the page hook: { url, kind: 'json'|'subtitle', body }. */
    handle(response) {
      if (active) return parse(response);
      queued.push(response);
      if (queued.length > MAX_QUEUED) queued.shift();
      schedule();
    },
    /** A player is on the page: parse what was queued, and from now on as it arrives. */
    activate() {
      if (active) return;
      active = true;
      for (const r of queued.splice(0)) parse(r);
    },
    /** The player went away (single-page navigation back to browsing). */
    deactivate() {
      active = false;
      wanted = null;
    },
    /** This title is playing: download its subtitle track once it is known. */
    want(id) {
      this.activate();
      wanted = id ? String(id) : null;
      const tracks = (wanted && tracksFor.get(wanted)) || tracksFor.get('');
      if (wanted && tracks) fetchSubtitle(tracks, tracksFor.has(wanted) ? wanted : null);
    },
  };
}
