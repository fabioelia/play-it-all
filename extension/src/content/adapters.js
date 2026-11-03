// Platform adapters: how to find the video, identify what is playing, read
// content time and seek on each site. DOM selectors for streaming sites drift;
// each adapter prefers data captured from the player's own API responses
// (via page-hook) and falls back to the DOM.

import { canonicalKey, parseEpisodeLabel } from '../../../shared/identity.js';
import { parseClock } from '../../../shared/subtitles.js';

/**
 * The main video, chosen without reading layout: by whether it has media
 * loaded and by its own resolution (videoWidth × videoHeight are properties of
 * the stream, not the page, so reading them never forces a reflow).
 */
function largestVideo(root = document) {
  let best = null;
  let bestScore = -1;
  for (const v of root.querySelectorAll('video')) {
    if (!(v.currentSrc || v.src || v.srcObject)) continue;
    const score = (v.readyState > 0 ? 1e9 : 0) + v.videoWidth * v.videoHeight;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

const text = (sel, root = document) => root.querySelector(sel)?.textContent?.trim() || '';

// ---- Netflix --------------------------------------------------------------

export function netflixAdapter(bridge) {
  const metadata = {}; // videoId → meta, from the /metadata response

  return {
    platform: 'netflix',
    fillsViewport: true, // the watch page player always fills the window
    captionSelector: '.player-timedtext',
    onPageMessage(type, payload) {
      if (type === 'netflix-metadata') Object.assign(metadata, payload);
    },
    // Only the watch page plays episodes; browse-page trailers are not ours.
    findVideo: () => (location.pathname.startsWith('/watch/') ? document.querySelector('.watch-video video') || largestVideo() : null),
    identify() {
      const m = /\/watch\/(\d+)/.exec(location.pathname);
      if (!m) return null;
      const id = m[1];
      let meta = metadata[id] ? { ...metadata[id] } : null;
      if (!meta) {
        // DOM fallback: <div data-uia="video-title"><h4>Show</h4><span>S1:E1</span><span>Name</span></div>
        const el = document.querySelector('[data-uia="video-title"]');
        if (el) {
          const series = text('h4', el);
          const spans = [...el.querySelectorAll('span')].map((s) => s.textContent.trim());
          const ep = parseEpisodeLabel(spans.join(' '));
          meta = ep ? { series, season: ep.season, episode: ep.episode, name: spans[1] || ep.rest } : { name: series || el.textContent.trim() };
        }
      }
      return { platform: 'netflix', platformId: id, meta: meta || {}, canonicalKey: meta ? canonicalKey(meta) : null };
    },
    currentTime: (video) => video.currentTime,
    // Never assign currentTime on Netflix — go through the player API.
    seek: (video, seconds) => bridge.seek(seconds),
  };
}

// ---- Prime Video ------------------------------------------------------------

export function primeAdapter() {
  let title = null; // from GetPlaybackResources catalog metadata
  // Prime's media element time can drift from the displayed programme time
  // (stream start offsets, ad breaks). Calibrate against the on-screen time
  // indicator whenever it is visible.
  let offset = 0;
  const samples = [];

  function calibrate(video) {
    const label = text('.atvwebplayersdk-timeindicator-text');
    const m = /^([\d:]+)\s*\//.exec(label);
    if (!m || video.paused) return;
    const shown = parseClock(m[1]);
    if (!Number.isFinite(shown)) return;
    samples.push(video.currentTime - shown);
    if (samples.length > 7) samples.shift();
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // The label has 1 s resolution: only move the offset on a real change.
    if (samples.length >= 3 && Math.abs(median - offset) > 1.5) offset = Math.round(median);
  }

  return {
    platform: 'prime',
    fillsViewport: true,
    captionSelector: '.atvwebplayersdk-captions-overlay',
    onPageMessage(type, payload) {
      if (type === 'prime-title') title = payload;
    },
    findVideo() {
      const root = document.querySelector('.webPlayerSDKContainer, .webPlayerUIContainer, #dv-web-player');
      return (root && largestVideo(root)) || largestVideo();
    },
    identify() {
      const video = this.findVideo();
      if (!video) return null;
      let meta = null;
      if (title) {
        meta = { series: title.series, season: title.season, episode: title.episode, name: title.name, type: title.type };
      } else {
        const series = text('.atvwebplayersdk-title-text');
        const sub = text('.atvwebplayersdk-subtitle-text');
        if (!series) return null;
        const ep = parseEpisodeLabel(sub);
        meta = ep ? { series, season: ep.season, episode: ep.episode, name: ep.rest } : { name: series };
      }
      const canonical = canonicalKey(meta);
      // Episode ASIN when known; otherwise the canonical key stands in.
      const platformId = title?.asin || (canonical ? `ck:${canonical}` : null);
      if (!platformId) return null;
      return { platform: 'prime', platformId, meta, canonicalKey: canonical };
    },
    currentTime(video) {
      calibrate(video);
      return video.currentTime - offset;
    },
    seek(video, seconds) {
      video.currentTime = seconds + offset;
      return Promise.resolve(true);
    },
  };
}

// ---- Any other site with a <video> (and the local demo) ---------------------

export function genericAdapter() {
  const metaTag = (n) => document.querySelector(`meta[name="cleancut:${n}"]`)?.content || '';
  return {
    platform: 'web',
    captionSelector: null,
    onPageMessage() {},
    findVideo: () => largestVideo(),
    identify() {
      const video = largestVideo();
      if (!video) return null;
      // Sites (or our demo) can declare identity explicitly.
      const declaredId = metaTag('id');
      const meta = {
        series: metaTag('series') || undefined,
        season: metaTag('season') ? Number(metaTag('season')) : undefined,
        episode: metaTag('episode') ? Number(metaTag('episode')) : undefined,
        name: metaTag('title') || document.title,
      };
      const src = video.currentSrc && !video.currentSrc.startsWith('blob:') ? new URL(video.currentSrc).pathname : '';
      const platformId = declaredId || `${location.host}${location.pathname}${src ? `#${src}` : ''}`;
      return { platform: 'web', platformId, meta, canonicalKey: canonicalKey(meta) };
    },
    currentTime: (video) => video.currentTime,
    seek(video, seconds) {
      video.currentTime = seconds;
      return Promise.resolve(true);
    },
    // Non-DRM sites can expose <track> cues directly — scan them ahead.
    readTextTracks(video) {
      const out = [];
      for (const track of video.textTracks || []) {
        const lang = track.language || '';
        if ((lang && !/^en\b/i.test(lang)) || !['subtitles', 'captions'].includes(track.kind)) continue;
        if (track.mode === 'disabled') track.mode = 'hidden'; // loads cues without showing them
        if (track.cues?.length) {
          out.push([...track.cues].map((c) => ({ start: c.startTime, end: c.endTime, text: c.text.replace(/<[^>]+>/g, '') })));
        }
      }
      return out[0] || null;
    },
  };
}

export function detectAdapter(bridge) {
  const h = location.hostname;
  if (/(^|\.)netflix\.com$/.test(h)) return netflixAdapter(bridge);
  if (/(^|\.)primevideo\.com$/.test(h) || /(^|\.)amazon\.[a-z.]+$/.test(h)) return primeAdapter();
  return genericAdapter();
}
