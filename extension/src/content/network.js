// Everything the page hook does not have to do early: parse the responses it
// forwarded, learn what episode is playing and where its subtitle track is,
// and download that track. Runs in the content script (document_idle).
//
// Players fetch manifests for far more titles than the one being watched:
// Netflix prefetches them for titles on the browse page (billboard, previews,
// Continue Watching) and for the next episode. So while no title is playing,
// bodies are only parsed in idle time, just their track lists are kept, and a
// subtitle track is downloaded only for the title in the player.
//
// Responses that do not name their title (HLS/DASH manifests, most players'
// subtitle files) belong to the title in the address bar when they arrive
// (shared/platforms.js watchId); on a browse page, with no title in the
// address, they are autoplay previews and are dropped.

import {
  crunchyrollPlayTracks,
  extractNetflixMetadata,
  extractPrimeSubtitles,
  extractPrimeTitle,
  hlsSegments,
  huluPlaylistTracks,
  isEnglish,
  looksLikeSubtitle,
  manifestSubtitleTracks,
  netflixManifestInfo,
  netflixTextTracks,
  plexMetadataInfo,
  tubiContentInfo,
  vimeoConfigInfo,
  youtubePlayerInfo,
  youtubeSubtitleLanguage,
} from '../../../shared/sources.js';
import { joinVttSegments } from '../../../shared/subtitles.js';
import { platformForHost, watchIdFromUrl } from '../../../shared/platforms.js';

const MAX_QUEUED = 8; // unparsed bodies kept while nothing plays
const MAX_TITLES = 32; // track lists remembered (URLs only), oldest dropped
const MAX_SEGMENTS = 900; // an HLS subtitle rendition longer than this is not downloaded
const SEGMENT_FETCHES = 3; // segments downloaded at once
// Where responses are matched to titles as before this file learned other
// sites: by the ids in the responses themselves (Netflix, Prime, the demo).
const UNKEYED = new Set(['netflix', 'prime', 'web']);

/**
 * @param {(type: string, payload: object) => void} emit
 *   receives 'netflix-metadata', 'prime-title', 'video-meta' ({ id, meta }),
 *   'subtitles' and 'needs-subtitles' (the playing title's English track came
 *   without links, or its download came back empty: the viewer should turn
 *   captions on once so the player's own request can be read)
 * @param {{ pageFetch?: (url: string) => Promise<{ok:boolean,status:number,text?:string,error?:string}> }} [o]
 *   pageFetch: download through the page itself, if the content script is refused
 */
export function createNetworkInspector(emit, { pageFetch, log = () => {} } = {}) {
  const platform = platformForHost(location.hostname)?.id || 'web';
  const isNetflix = platform === 'netflix';
  const seen = new Set(); // subtitle URLs already handed over
  const queued = []; // forwarded bodies not parsed yet
  const tracksFor = new Map(); // title id ('' = unknown) → subtitle tracks, best first
  const infoFor = new Map(); // title id → { available, dehydrated, via } from its last manifest
  let active = false; // a title is in the player: parse as responses arrive
  let wanted = null; // platform id of the title playing
  // What happened, for the popup's diagnostics line.
  const diag = { manifests: 0, decrypted: 0, download: null };

  /** The title in the address bar right now (null on browse pages). */
  const pageKey = () => watchIdFromUrl(location.href);

  function subtitles(url, text, extra) {
    if (seen.has(url) || !looksLikeSubtitle(text)) return false;
    seen.add(url);
    emit('subtitles', { url, text, ...extra });
    return true;
  }

  /** GET a text file: from the content script first, then through the page. */
  async function getText(url, forId) {
    const host = (() => { try { return new URL(url).hostname; } catch { return '?'; } })();
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
    return text;
  }

  /** An HLS subtitle rendition: its media playlist, then every WebVTT segment, joined. */
  async function getHlsSubtitles(url, forId) {
    const playlist = await getText(url, forId);
    const segments = hlsSegments(playlist, url);
    log('hls-subtitles', { forId, segments: segments.length });
    if (!segments.length) return null;
    if (segments.length > MAX_SEGMENTS) {
      diag.download = `too many subtitle segments (${segments.length})`;
      return null;
    }
    const parts = new Array(segments.length);
    let next = 0;
    const worker = async () => {
      while (next < segments.length) {
        const i = next++;
        parts[i] = await getText(segments[i], forId);
      }
    };
    await Promise.all(Array.from({ length: SEGMENT_FETCHES }, worker));
    return joinVttSegments(parts);
  }

  const downloading = new Set();
  async function fetchSubtitle(tracks, forId) {
    let got = false;
    for (const track of tracks.slice(0, 3)) {
      const url = new URL(track.url, location.href).href;
      if (seen.has(url) || downloading.has(url)) return;
      downloading.add(url);
      const extra = { forId, sdh: track.sdh, language: track.language };
      log('download', { forId, format: track.format, host: (() => { try { return new URL(url).hostname; } catch { return '?'; } })() });
      try {
        const text = track.format === 'hls' ? await getHlsSubtitles(url, forId) : await getText(url, forId);
        if (text != null) {
          log('downloaded', { forId, format: track.format, chars: text.length, looksLikeSubtitle: looksLikeSubtitle(text), head: text.slice(0, 40).replace(/\s+/g, ' ') });
          if (subtitles(url, text, extra)) {
            diag.download = `ok (${track.format || 'subtitles'}, ${Math.round(text.length / 1024)} KB)`;
            got = true;
            return;
          }
          diag.download = text ? `not a subtitle file (${track.format || 'unknown format'})` : 'empty';
        }
      } finally {
        downloading.delete(url);
      }
    }
    // YouTube can refuse caption downloads that lack a token only its player
    // has; the player's own request, once captions are on, is read instead.
    if (!got && forId && tracks.some((t) => t.ask)) emit('needs-subtitles', { forId });
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

  /** A track list for one title (a Netflix manifest, or player data on other sites). */
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

  /** Player data that names its title: { movieId, meta, tracks, available, dehydrated }. */
  function titled(info, via) {
    if (!info?.movieId) return;
    if (info.meta) emit('video-meta', { id: String(info.movieId), meta: info.meta });
    manifest({ ...info, movieId: String(info.movieId) }, via);
  }

  /** Tracks from a response that does not say which title it is for: the one in the address when it arrived. */
  function forPage(tracks, via, key) {
    log('page-tracks', { via, key, links: tracks.length });
    if (key && tracks.length) remember(key, tracks);
  }

  function inspectJson(url, json, pageAt) {
    log('response', { path: (() => { try { return new URL(url, location.href).pathname; } catch { return '?'; } })(), keys: Object.keys(json).slice(0, 20) });
    switch (platform) {
      case 'netflix': {
        const meta = extractNetflixMetadata(json);
        if (Object.keys(meta).length) emit('netflix-metadata', meta);
        if (netflixTextTracks(json)) manifest(netflixManifestInfo(json), 'network');
        return;
      }
      case 'youtube':
        return titled(youtubePlayerInfo(json), 'network');
      case 'vimeo':
        return titled(vimeoConfigInfo(json), 'network');
      case 'tubi': {
        const info = tubiContentInfo(json);
        if (info && !info.movieId) info.movieId = pageAt;
        return titled(info, 'network');
      }
      case 'hulu':
        return forPage(huluPlaylistTracks(json), 'playlist', pageAt);
      case 'crunchyroll':
        return forPage(crunchyrollPlayTracks(json), 'play', pageAt);
      case 'plex': {
        // Library browsing fetches metadata for many items: only the one in the address counts.
        const info = plexMetadataInfo(json, new URL(url, location.href).href);
        const key = pageAt;
        if (!info || !key || (key !== info.ratingKey && !key.endsWith(`:${info.ratingKey}`))) return;
        emit('video-meta', { id: key, meta: info.meta });
        if (info.tracks.length) remember(key, info.tracks);
        return;
      }
      default: {
        // Prime Video, and the local demo page (which imitates Prime).
        const title = extractPrimeTitle(json);
        if (title) emit('prime-title', title);
        const tracks = extractPrimeSubtitles(json);
        if (tracks.length) remember(title?.asin || new URL(url, location.href).searchParams.get('asin') || '', tracks);
      }
    }
  }

  /** Which title a caption file the player downloaded belongs to (null: not English). */
  function passiveOwner(url, pageAt) {
    if (platform === 'youtube') {
      const v = /[?&]v=([\w-]{11})/.exec(url)?.[1] || null;
      return isEnglish(youtubeSubtitleLanguage(url)) ? { forId: v || pageAt } : null;
    }
    // Netflix, Prime and other pages: as before, the title playing.
    return { forId: UNKEYED.has(platform) ? null : pageAt };
  }

  function parse({ url, kind, body, pageAt = pageKey() }) {
    try {
      if (kind === 'subtitle') {
        const owner = passiveOwner(url, pageAt);
        const text = typeof body === 'string' ? body : body && typeof body === 'object' ? JSON.stringify(body) : null;
        if (owner && text) subtitles(url, text, { forId: owner.forId, passive: true });
        return;
      }
      if (kind === 'manifest') {
        if (typeof body === 'string') forPage(manifestSubtitleTracks(body, new URL(url, location.href).href), 'manifest', pageAt);
        return;
      }
      const json = typeof body === 'string' ? JSON.parse(body) : body;
      if (json && typeof json === 'object') inspectJson(url, json, pageAt);
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
    /** A response forwarded by the page hook: { url, kind: 'json'|'subtitle'|'manifest', body }. */
    handle(response) {
      if (!response || typeof response !== 'object') return;
      if (!UNKEYED.has(platform)) {
        // Remember which title was in the address when it arrived. A manifest
        // or caption file arriving on a browse page belongs to an autoplay
        // preview: never kept.
        response.pageAt = pageKey();
        if (!response.pageAt && (response.kind === 'manifest' || (response.kind === 'subtitle' && platform !== 'youtube'))) return;
      }
      if (active) return parse(response);
      queued.push(response);
      // A burst while the page is busy: parse the oldest now rather than drop
      // it (it may be the title the viewer opens next).
      if (queued.length > MAX_QUEUED) parse(queued.shift());
      schedule();
    },
    /** Track list the page hook read from player data (Netflix's decrypted manifest, YouTube, Vimeo); already small. */
    tracks(info) {
      if (!info || typeof info !== 'object') return;
      const tracks = Array.isArray(info.tracks) ? info.tracks : [];
      if (info.meta && info.movieId) emit('video-meta', { id: String(info.movieId), meta: info.meta });
      manifest({ ...info, tracks }, info.via || 'decrypted');
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
