// YouTube: www.youtube.com, m.youtube.com and embedded players
// (youtube.com/embed, youtube-nocookie.com/embed in iframes on other sites).
//
// unverified: built from the player data YouTube served to this project's
// test machine (the /youtubei/v1/player response of an embed, the inline
// ytInitialPlayerResponse of a watch page), YouTube's public page structure,
// and checked against a fixture of both (test/e2e/youtube.e2e.mjs).
// test/live/youtube.mjs runs the same checks on the real site; it has not
// passed live yet because YouTube refuses that machine ("Sign in to confirm
// you're not a bot", then Google's "unusual traffic" page).
//
//  - The video: the main player's (#movie_player video.html5-main-video), only
//    on a watch, embed or live page, or while the miniplayer keeps playing it.
//    Hover previews on the home page and Shorts (looping clips in a swipe feed,
//    never in the catalog) are left alone.
//  - Identity: the video id from the address; title and channel from the
//    player response (page-hook.js reads it inline, and from /youtubei/v1/player
//    and 'yt-navigate-finish' on in-app navigation), with the page as fallback.
//    Only films and shows YouTube sells or streams are matched to the catalog
//    by name; any other video only by its own id.
//  - Ads play in the same <video>: while #movie_player has .ad-showing or
//    .ad-interrupting CleanCut does nothing (isAdPlaying).
//  - Seeking: assigning currentTime is what YouTube's own keyboard shortcuts do.

import { canonicalKey } from '../../../../shared/identity.js';
import { platformById } from '../../../../shared/platforms.js';
import { first, text } from './dom.js';

const MAX_META = 64;
const WAIT_FOR_DATA_MS = 3000; // how long identify waits for the player's own data

export function youtubeAdapter() {
  const watchId = platformById('youtube').watchId;
  const metaById = new Map(); // video id → meta, filled in place as better data arrives
  const firstSeen = new Map();
  let lastId = null;
  const embed = location.pathname.startsWith('/embed/');

  const player = () => document.getElementById('movie_player');

  function metaFor(id) {
    let m = metaById.get(id);
    if (!m) {
      m = {};
      metaById.set(id, m);
      if (metaById.size > MAX_META) metaById.delete(metaById.keys().next().value);
    }
    return m;
  }

  /** The miniplayer keeps the video playing while the viewer browses (the address has no id then). */
  function minimized() {
    if (player()?.classList.contains('ytp-player-minimized')) return true;
    const app = document.querySelector('ytd-app');
    return !!app && (app.hasAttribute('miniplayer-is-active') || !!app.querySelector(':scope > ytd-miniplayer[active], ytd-miniplayer[active]'));
  }

  function currentId() {
    let id = null;
    try {
      id = watchId(new URL(location.href));
    } catch { /* about:blank */ }
    if (id) return id;
    return lastId && minimized() ? lastId : null;
  }

  /** Title and channel from the page, only when the page shows this very video. */
  function fromPage(id, meta) {
    if (embed) {
      const link = document.querySelector('.ytp-title-link');
      if (link && (link.getAttribute('href') || '').includes(id)) {
        meta.name = link.textContent.trim() || meta.name;
        meta.channel = text('.ytp-title-channel-name, .ytp-title-expanded-title') || meta.channel;
      }
      return;
    }
    const flexy = document.querySelector('ytd-watch-flexy');
    if (flexy && flexy.getAttribute('video-id') === id) {
      const name = text('ytd-watch-metadata h1') || text('#above-the-fold #title h1');
      if (name) meta.name = name;
      const channel = first(['ytd-watch-metadata ytd-channel-name a', '#owner ytd-channel-name a', '#upload-info ytd-channel-name a']);
      if (channel?.textContent.trim()) meta.channel = channel.textContent.trim();
    }
  }

  return {
    platform: 'youtube',
    // An embed's player fills its frame; on youtube.com the overlay follows
    // the video's box (default and theater layouts, fullscreen, miniplayer).
    fillsViewport: embed,
    captionSelector: '.ytp-caption-window-container, .caption-window',
    onPageMessage(type, payload) {
      if (type !== 'video-meta' || !payload?.id || !payload.meta) return;
      const m = metaFor(String(payload.id));
      for (const [k, v] of Object.entries(payload.meta)) if (v !== undefined && v !== null && v !== '') m[k] = v;
    },
    findVideo() {
      if (!currentId()) return null;
      const p = player();
      const v = p?.querySelector('video.html5-main-video') || p?.querySelector('video');
      return v && (v.currentSrc || v.src || v.srcObject) ? v : null;
    },
    identify() {
      const id = currentId();
      if (!id) return null;
      lastId = id;
      const meta = metaFor(id); // the same object is returned every time, so details that arrive later show up
      if (!meta.name) fromPage(id, meta);
      if (!meta.name) {
        // Give the player's own data a moment; then go with the id alone.
        const now = performance.now();
        if (!firstSeen.has(id)) firstSeen.set(id, now);
        if (now - firstSeen.get(id) < WAIT_FOR_DATA_MS) return null;
        const title = (document.title || '').replace(/\s*-\s*YouTube$/, '').trim();
        if (title && title !== 'YouTube') meta.name = title;
      }
      return { platform: 'youtube', platformId: id, meta, canonicalKey: meta.tvfilm ? canonicalKey(meta) : null };
    },
    /** Ads play in the same <video>: CleanCut never skips, mutes or hides during one. */
    isAdPlaying() {
      const p = player();
      return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
    },
    currentTime: (video) => video.currentTime,
    seek(video, seconds) {
      video.currentTime = seconds;
      return Promise.resolve(true);
    },
  };
}
