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
  extractPrimeSubtitles,
  extractPrimeTitle,
  looksLikeSubtitle,
  netflixManifestInfo,
  netflixTextTracks,
} from '../../../shared/sources.js';

const MAX_QUEUED = 8; // unparsed bodies kept while nothing plays
const MAX_TITLES = 32; // track lists remembered (URLs only), oldest dropped

/**
 * @param {(type: string, payload: object) => void} emit
 *   receives 'netflix-metadata', 'prime-title', 'subtitles' and
 *   'needs-subtitles' (the playing title's English track came without links)
 * @param {{ pageFetch?: (url: string) => Promise<{ok:boolean,status:number,text?:string,error?:string}> }} [o]
 *   pageFetch: download through the page itself, if the content script is refused
 */
export function createNetworkInspector(emit, { pageFetch, log = () => {} } = {}) {
  const isNetflix = /(^|\.)netflix\.com$/.test(location.hostname);
  const seen = new Set(); // subtitle URLs already handed over
  const queued = []; // forwarded bodies not parsed yet
  const tracksFor = new Map(); // title id ('' = unknown) → subtitle tracks, best first
  const infoFor = new Map(); // title id → { available, dehydrated, via } from its last manifest
  let active = false; // a title is in the player: parse as responses arrive
  let wanted = null; // platform id of the title playing
  // What happened, for the popup's diagnostics line.
  const diag = { manifests: 0, decrypted: 0, download: null };

  function subtitles(url, text, extra) {
    if (seen.has(url) || !looksLikeSubtitle(text)) return false;
    seen.add(url);
    emit('subtitles', { url, text, ...extra });
    return true;
  }

  const downloading = new Set();
  async function fetchSubtitle(tracks, forId) {
    for (const track of tracks.slice(0, 3)) {
      const url = new URL(track.url, location.href).href;
      if (seen.has(url) || downloading.has(url)) return;
      downloading.add(url);
      const extra = { forId, sdh: track.sdh, language: track.language };
      const host = (() => { try { return new URL(url).hostname; } catch { return '?'; } })();
      log('download', { forId, format: track.format, host });
      try {
        let text = null;
        try {
          const res = await fetch(url, { credentials: 'omit' });
          if (res.ok) text = await res.text();
          else diag.download = `refused (HTTP ${res.status})`;
        } catch (e) {
          diag.download = `blocked (${e?.message || e})`;
        }
        if (text == null) log('download-failed', { forId, host, why: diag.download });
        if (text == null && pageFetch) {
          // Same request from the page, as the player makes it.
          const r = await pageFetch(url);
          log('page-download', { forId, ok: !!r?.ok, status: r?.status ?? null, error: r?.error || null });
          if (r?.ok) text = r.text;
          else diag.download = `refused (${r?.status ? `HTTP ${r.status}` : r?.error || 'no answer'}), also from the page`;
        }
        if (text != null) {
          log('downloaded', { forId, format: track.format, chars: text.length, looksLikeSubtitle: looksLikeSubtitle(text), head: text.slice(0, 40).replace(/\s+/g, ' ') });
          if (subtitles(url, text, extra)) {
            diag.download = `ok (${track.format || 'subtitles'}, ${Math.round(text.length / 1024)} KB)`;
            return;
          }
          diag.download = `not a subtitle file (${track.format || 'unknown format'})`;
        }
      } finally {
        downloading.delete(url);
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

  /** A Netflix manifest's subtitle summary (from the network or the decrypted copy). */
  function manifest({ movieId, tracks, available, dehydrated }, via) {
    log('manifest', { via, movieId, playing: wanted, english: available, withoutLinks: dehydrated, links: tracks?.length || 0 });
    diag.manifests++;
    if (via === 'decrypted') diag.decrypted++;
    const key = movieId || '';
    infoFor.set(key, { available, dehydrated, via });
    if (infoFor.size > MAX_TITLES) infoFor.delete(infoFor.keys().next().value);
    if (tracks?.length) remember(key, tracks);
    else if (dehydrated && wanted && key === wanted && !tracksFor.has(key)) emit('needs-subtitles', { forId: key });
  }

  function inspectJson(url, json) {
    log('response', { path: (() => { try { return new URL(url, location.href).pathname; } catch { return '?'; } })(), keys: Object.keys(json).slice(0, 20) });
    if (isNetflix) {
      const meta = extractNetflixMetadata(json);
      if (Object.keys(meta).length) emit('netflix-metadata', meta);
      if (netflixTextTracks(json)) manifest(netflixManifestInfo(json), 'network');
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
      // A burst while the page is busy: parse the oldest now rather than drop
      // it (it may be the title the viewer opens next).
      if (queued.length > MAX_QUEUED) parse(queued.shift());
      schedule();
    },
    /** Subtitle summary the page hook read from a decrypted Netflix manifest (already small). */
    tracks(info) {
      if (info && typeof info === 'object') manifest({ ...info, tracks: Array.isArray(info.tracks) ? info.tracks : [] }, info.via || 'decrypted');
    },
    /** For the popup: what is known about the playing title's subtitles. */
    diagnostics() {
      const info = (wanted && infoFor.get(wanted)) || null;
      return {
        ...diag,
        tracks: (wanted && tracksFor.get(wanted)?.length) || 0,
        available: info?.available ?? null,
        dehydrated: info?.dehydrated ?? null,
        via: info?.via || null,
      };
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
      const next = id ? String(id) : null;
      if (next === wanted) return; // called every second; tracks that arrive later are fetched by remember()
      wanted = next;
      diag.download = null;
      log('want', { id: wanted, known: [...tracksFor.keys()].slice(-12), withLinks: !!(wanted && tracksFor.get(wanted)) });
      const tracks = (wanted && tracksFor.get(wanted)) || tracksFor.get('');
      if (wanted && tracks) fetchSubtitle(tracks, tracksFor.has(wanted) ? wanted : null);
      else if (wanted && infoFor.get(wanted)?.dehydrated) emit('needs-subtitles', { forId: wanted });
    },
  };
}
