// Adapters for the subscription and free streaming services other than
// Netflix, Prime Video and YouTube. They share one shape, so each service is a
// config: where its video is, how its player names the title, how it shows an
// ad, and whether assigning video.currentTime is a safe way to seek.
//
// None of these services can be played from the machine this was written on
// (accounts, DRM, region), so every config but Vimeo's is marked unverified
// with the sources it was built from. Everything is defensive: every selector
// is optional, and identify() always has the id from the address
// (shared/platforms.js), so tags made on a title stick to it even when the
// player's markup changes and only the display name is lost.
//
// Config fields (all optional except id):
//   video()        the playing <video>; default: the largest one with media
//   minDuration    ignore videos shorter than this (s): trailers and previews
//                  that autoplay on a title's own page
//   meta()         { series, season, episode, name, year } from the player's
//                  DOM; JSON-LD on the page and the document title are tried after
//   siteName       how the site signs document.title ("Hulu"), for that fallback
//   ad()           true while an ad plays: CleanCut does nothing then
//   seek           'currentTime' (assign it) or 'cover' (unsure the player
//                  tolerates it: mute and hide the picture instead, as when
//                  Netflix's seek API fails)
//   captions       selector of the player's caption container (hidden while muted)
//   fillsViewport  the player fills the window (default true)

import { canonicalKey, parseEpisodeLabel } from '../../../../shared/identity.js';
import { platformById } from '../../../../shared/platforms.js';
import { documentTitle, first, jsonLdMeta, largestVideo, shadow, text } from './dom.js';

const clean = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== '' && !Number.isNaN(v)));

/** "Show", "S2:E5 Name" → { series, season, episode, name }; or a film's name. */
export function episodeMeta(series, label) {
  const s = (series || '').trim();
  const ep = parseEpisodeLabel(label || '');
  if (s && ep) return { series: s, season: ep.season, episode: ep.episode, name: ep.rest.replace(/^[\s:·•\-–—]+/, '') || undefined };
  const m = /^(?:E(?:p(?:isode)?\.?)?\s*)(\d+)\s*[:\-–—]?\s*(.*)$/i.exec((label || '').trim()); // "E5 - Name" (season unknown)
  if (s && m) return { series: s, episode: Number(m[1]), name: m[2] || undefined };
  return s ? { name: s } : null;
}

/** "Show - S1 E2 - Name" or "Film" (a page title without the site's name) → meta. */
export function metaFromTitle(title) {
  const t = (title || '').trim();
  if (!t) return null;
  const m = /\bS(?:eason)?\s*\d+\s*[:,.]?\s*E(?:p(?:isode)?\.?)?\s*\d+/i.exec(t);
  if (m && m.index > 0) {
    const series = t.slice(0, m.index).replace(/[\s|:•·–—-]+$/, '');
    const meta = episodeMeta(series, t.slice(m.index));
    if (meta?.series) return meta;
  }
  return { name: t };
}

export function streamingAdapter(cfg) {
  const { id } = cfg;
  const watchId = platformById(id).watchId;
  const fromPlayer = new Map(); // title id → meta sent by network.js ('video-meta')
  const here = () => {
    try {
      return watchId(new URL(location.href));
    } catch {
      return null;
    }
  };
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  // identify() runs every second: once a title is fully known, its page is
  // not searched again (until the player's own data about it changes).
  let known = null;
  // isAdPlaying() runs on every 100 ms tick; ad markers are found by
  // document-wide queries, so the answer is reused for a quarter second.
  let adAt = -1e9;
  let ad = false;

  return {
    platform: id,
    fillsViewport: typeof cfg.fillsViewport === 'function' ? cfg.fillsViewport() : cfg.fillsViewport ?? true,
    captionSelector: cfg.captions || null,
    onPageMessage(type, payload) {
      if (type === 'video-meta' && payload?.id && payload.meta) {
        fromPlayer.set(String(payload.id), clean(payload.meta));
        if (known?.platformId === String(payload.id)) known = null;
        if (fromPlayer.size > 32) fromPlayer.delete(fromPlayer.keys().next().value);
      }
    },
    // Browse and detail pages have no title id in the address: their autoplay
    // previews are never taken for the title.
    findVideo() {
      if (!here()) return null;
      const v = (cfg.video ? safe(cfg.video) : null) || largestVideo();
      if (!v || !(v.currentSrc || v.src || v.srcObject)) return null;
      if (cfg.minDuration && !(v.duration >= cfg.minDuration)) return null; // also while unknown (NaN)
      return v;
    },
    identify() {
      const platformId = here();
      if (!platformId) return null;
      if (known?.platformId === platformId) return known;
      const meta = clean({
        ...(clean(cfg.meta ? safe(cfg.meta) : null)),
        ...(fromPlayer.get(platformId) || {}),
      });
      if (!meta.name && !meta.series) Object.assign(meta, clean(safe(() => jsonLdMeta(platformId))));
      if (!meta.name && !meta.series && cfg.siteName) Object.assign(meta, clean(metaFromTitle(documentTitle(cfg.siteName))));
      const ident = { platform: id, platformId, meta, canonicalKey: canonicalKey(meta) };
      known = ident.canonicalKey ? ident : null;
      return ident;
    },
    isAdPlaying: cfg.ad
      ? () => {
        const now = performance.now();
        if (now - adAt > 250) {
          adAt = now;
          ad = !!safe(cfg.ad);
        }
        return ad;
      }
      : undefined,
    currentTime: (video) => video.currentTime,
    seek:
      cfg.seek === 'currentTime'
        ? (video, seconds) => {
          video.currentTime = seconds;
          return Promise.resolve(true);
        }
        : () => Promise.resolve(false), // index.js then mutes and hides the scene instead
    // Players without DRM sometimes expose their captions as text tracks.
    readTextTracks: cfg.textTracks ? readEnglishTextTracks : undefined,
  };
}

/** Cues of the video's English subtitle or caption track, if the player exposes one. */
export function readEnglishTextTracks(video) {
  for (const track of video.textTracks || []) {
    const lang = track.language || '';
    if ((lang && !/^en\b/i.test(lang)) || !['subtitles', 'captions'].includes(track.kind)) continue;
    if (track.mode === 'disabled') track.mode = 'hidden'; // loads cues without showing them
    if (track.cues?.length) return [...track.cues].map((c) => ({ start: c.startTime, end: c.endTime, text: c.text.replace(/<[^>]+>/g, '') }));
  }
  return null;
}

// ---- the services ------------------------------------------------------------------------

export const SERVICES = {
  // unverified: built from the public site (play URLs /play/<id>, which
  // redirect to /browse/entity-<id> when signed out) and the open-source
  // Netflix-Prime-Auto-Skip and stream-ad-skipper extensions (disney-web-player
  // shadow DOM, title-bug, ad-badge-overlay; both skip ads by assigning
  // video.currentTime). Ads on the ad tier are stitched into the stream, so
  // after an ad break the stream clock runs ahead of the episode's.
  disney: {
    id: 'disney',
    video: () => shadow(['disney-web-player'], 'video') || document.querySelector('video#hivePlayer, video[id*="hivePlayer"]'),
    meta() {
      const bug = (sel) => shadow(['main-app-controls-overlay', 'title-bug'], sel)?.textContent?.trim() || text(sel);
      return episodeMeta(bug('.title-field'), bug('.subtitle-field'));
    },
    siteName: 'Disney\\+',
    ad: () => !!(shadow(['ad-badge-overlay'], '.ad-badge-overlay__content--time-display') || document.querySelector('.overlay_interstitials__content_time_display')),
    seek: 'currentTime',
    captions: '.dss-subtitle-renderer-cue-window, .hive-subtitle-renderer-cue-window',
  },
  // unverified: built from the public site (play.hbomax.com/video/watch/<video>/<edit>)
  // and Netflix-Prime-Auto-Skip (data-testid="player-ux-…" controls). Seeking
  // by currentTime is untested there: scenes are covered instead.
  max: {
    id: 'max',
    meta: () => episodeMeta(text('[data-testid="player-ux-asset-title"]') || text('[data-testid="player-ux-show-title"]'),
      `${text('[data-testid="player-ux-season-episode"]')} ${text('[data-testid="player-ux-asset-subtitle"]')}`.trim()),
    siteName: '(HBO )?Max',
    ad: () => !!document.querySelector('[data-testid="player-ux-ad-badge"], [data-testid*="ad-countdown"], [class*="AdBadge"]'),
    seek: 'cover',
    captions: '[data-testid="CueBoxContainer"], [class*="CaptionWindow"]',
  },
  // unverified: built from the public site (/watch/<uuid>) and the player's
  // published class names (PlayerMetadata__titleText / __subTitle); ads are
  // stitched in; seeking by currentTime is untested: scenes are covered instead.
  hulu: {
    id: 'hulu',
    meta: () => episodeMeta(text('.PlayerMetadata__titleText'), text('.PlayerMetadata__subTitle')),
    siteName: 'Hulu',
    ad: () => !!document.querySelector('.AdUnitView, .ad-container:not(:empty), [class*="AdBreak"]'),
    seek: 'cover',
    captions: '.ClosedCaption, .CaptionBox',
  },
  // unverified: built from the public site (/us/episode|movie/<slug>/umc.cmc.<id>).
  // A title's page autoplays its trailer: videos under 5 minutes are not taken
  // for the title. No ads. Seeking untested: scenes are covered instead.
  appletv: {
    id: 'appletv',
    video: () => shadow(['apple-tv-plus-player'], 'video') || shadow(['amp-video-player-internal'], 'video') || largestVideo(),
    minDuration: 300,
    siteName: 'Apple TV\\+?',
    seek: 'cover',
  },
  // unverified: built from the public site (/shows|movies/video/<id>/) and
  // Netflix-Prime-Auto-Skip (ad-info-manager countdown; it skips ads by
  // assigning video.currentTime). Ads are stitched in.
  paramount: {
    id: 'paramount',
    siteName: 'Paramount\\+?|Paramount Plus',
    ad: () => !!document.querySelector('div.ad-info-manager-circular-loader-copy, div.ad-click-overlay, .ad-ui-container:not(:empty)'),
    seek: 'currentTime',
  },
  // unverified: built from the public site (/watch/asset/…, player at
  // /watch/playback/vod/<content id>/<variant>). Ads are stitched in; seeking
  // untested: scenes are covered instead.
  peacock: {
    id: 'peacock',
    meta: () => episodeMeta(text('.playback-header__title, [data-testid="playback-title"]'), text('.playback-header__subtitle, [data-testid="playback-subtitle"]')),
    siteName: 'Peacock',
    ad: () => !!document.querySelector('.ad-countdown, [data-testid="ad-countdown"], .playback-ad-overlay'),
    seek: 'cover',
  },
  // unverified: built from the public site (/watch/<id>/<slug>), the page's
  // JSON-LD, and Netflix-Prime-Auto-Skip (data-testid player controls; it
  // rewinds with the player's own buttons rather than currentTime, so scenes
  // are covered instead). The free tier's ads run in the same player.
  crunchyroll: {
    id: 'crunchyroll',
    meta: () => episodeMeta(text('.show-title-link h4, [data-t="show-title-link"]'), text('.erc-current-media-info h1, h1.title')),
    siteName: 'Crunchyroll',
    ad: () => !!document.querySelector('[data-testid="ad-countdown"], [data-testid="vilos-ad-countdown"], .erc-ad-break, [class*="ad-overlay"]'),
    seek: 'cover',
  },
  // unverified: built from the public site (/movies/<id>/<slug>, JSON-LD, the
  // content API's subtitles list). Ads run in the same player; its hls.js
  // player seeks by currentTime.
  tubi: {
    id: 'tubi',
    minDuration: 300, // the title's page can preview it before the player opens
    siteName: 'Tubi',
    ad: () => !!document.querySelector('[data-test-id="ad-countdown"], [class*="AdCountdown"], [class*="adCountdown"], [class*="ad-overlay"]'),
    seek: 'currentTime',
  },
  // unverified: built from the public site (/on-demand/movies|series/…).
  // Ads are stitched into the stream.
  pluto: {
    id: 'pluto',
    minDuration: 300,
    siteName: 'Pluto TV',
    ad: () => !!document.querySelector('[class*="adBreak"], [class*="AdBreak"], [data-testid="ad-indicator"]'),
    seek: 'currentTime',
  },
  // unverified: built from the public site (/details/<id>/<slug>, player at
  // /watch/<id>). Seeking untested: scenes are covered instead.
  roku: {
    id: 'roku',
    siteName: 'The Roku Channel',
    ad: () => !!document.querySelector('[data-testid="ad-countdown"], [class*="AdCountdown"], [class*="adCountdown"]'),
    seek: 'cover',
  },
  // unverified: built from Plex Web's routes (#!/server/<id>/details?key=…)
  // and its library metadata API. Seeking a transcoded stream is the
  // player's job: scenes are covered instead.
  plex: {
    id: 'plex',
    meta: () => episodeMeta(text('[class*="PlayerControlsMetadata-container"] a[href*="grandparent"], [data-testid="metadataTitleLink"]'),
      text('[class*="PlayerControlsMetadata-container"] [class*="MetadataPosterTitle-singleLineTitle"]')),
    siteName: 'Plex',
    seek: 'cover',
    textTracks: true,
  },
  // verified live on the player.vimeo.com embed (test/live/vimeo.mjs):
  // identify, the English track from window.playerConfig, scan-ahead, overlay.
  // Skipping was not: Vimeo serves H.264, which the test browser cannot decode.
  // vimeo.com's own pages put a "Verify to continue" check in front of the
  // test browser, so the in-page player there is unverified.
  vimeo: {
    id: 'vimeo',
    video: () => document.querySelector('.vp-video video, .vp-video-wrapper video') || largestVideo(),
    meta: () => ({ name: text('.vp-title-header a, .vp-title a, h1') || undefined }),
    siteName: 'Vimeo',
    seek: 'currentTime',
    captions: '.vp-captions',
    fillsViewport: () => location.hostname === 'player.vimeo.com', // an embed fills its frame
  },
};
