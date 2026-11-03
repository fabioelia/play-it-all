// Pure extractors for the JSON the streaming players already download.
// The page hook passes captured response bodies through these to learn
// (a) what episode is playing and (b) where its full subtitle track lives,
// so the analyzer can scan the whole episode ahead of playback.
//
// Response shapes are undocumented and change; every extractor is defensive
// and returns empty results rather than throwing.

const isObj = (v) => v && typeof v === 'object';

/** Rough language match: "en", "en-US", "en-GB" → true for "en". */
export function isLang(code, want = 'en') {
  return typeof code === 'string' && code.toLowerCase().split(/[-_]/)[0] === want;
}

// Netflix formats we can parse, best first. SDH tracks carry sound
// descriptions, which feed the scene hints.
const NETFLIX_FORMATS = ['dfxp-ls-sdh', 'imsc1.1', 'webvtt-lssdh-ios8', 'simplesdh', 'nflx-cmisc'];

/**
 * Netflix player manifest (/playapi/cadmium/manifest, licensedManifest).
 * Returns [{ url, language, sdh, format }] best first.
 */
export function extractNetflixTimedText(json, lang = 'en') {
  const root = json?.result ?? json;
  const tracks = Array.isArray(root?.timedtexttracks) ? root.timedtexttracks : [];
  const out = [];
  for (const track of tracks) {
    if (!isObj(track) || track.isNoneTrack || track.isForcedNarrative) continue;
    if (!isLang(track.language, lang)) continue;
    const sdh = /closed|sdh|cc/i.test(`${track.trackType} ${track.rawTrackType} ${track.languageDescription}`);
    const downloadables = track.ttDownloadables || {};
    for (const format of NETFLIX_FORMATS) {
      const d = downloadables[format];
      if (!d) continue;
      for (const url of downloadableUrls(d)) out.push({ url, language: track.language, sdh, format });
    }
  }
  return out.sort((a, b) => Number(b.sdh) - Number(a.sdh) || NETFLIX_FORMATS.indexOf(a.format) - NETFLIX_FORMATS.indexOf(b.format));
}

function downloadableUrls(d) {
  const urls = [];
  if (Array.isArray(d.urls)) for (const u of d.urls) urls.push(typeof u === 'string' ? u : u?.url);
  else if (isObj(d.urls)) urls.push(...Object.values(d.urls));
  if (isObj(d.downloadUrls)) urls.push(...Object.values(d.downloadUrls));
  return urls.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 2);
}

/**
 * Netflix /metadata?movieid= response → { [videoId]: { series, season, episode, name, runtime, type } }
 */
export function extractNetflixMetadata(json) {
  const video = json?.video;
  const out = {};
  if (!isObj(video)) return out;
  if (video.type === 'movie') {
    out[String(video.id)] = { type: 'movie', name: video.title, runtime: video.runtime, year: video.year };
    return out;
  }
  for (const season of video.seasons || []) {
    for (const ep of season.episodes || []) {
      const id = ep.id ?? ep.episodeId;
      if (id == null) continue;
      out[String(id)] = {
        type: 'episode',
        series: video.title,
        season: season.seq,
        episode: ep.seq,
        name: ep.title,
        runtime: ep.runtime,
      };
    }
  }
  return out;
}

/**
 * Prime Video GetPlaybackResources response → subtitle tracks best first.
 * [{ url, language, sdh, format }]
 */
export function extractPrimeSubtitles(json, lang = 'en') {
  const lists = [
    json?.subtitleUrls,
    json?.timedTextUrls?.result?.subtitleUrls,
    json?.playbackUrls?.timedTextUrls?.result?.subtitleUrls,
  ].filter(Array.isArray);
  const out = [];
  for (const list of lists) {
    for (const s of list) {
      if (!isObj(s) || typeof s.url !== 'string' || !isLang(s.languageCode, lang)) continue;
      if (/forced/i.test(`${s.type} ${s.subtype}`)) continue;
      out.push({ url: s.url, language: s.languageCode, sdh: /sdh|cc/i.test(`${s.type} ${s.subtype} ${s.displayName}`), format: s.format || 'ttml' });
    }
  }
  return out.sort((a, b) => Number(b.sdh) - Number(a.sdh));
}

/** Prime catalog metadata from the same response, when present. */
export function extractPrimeTitle(json) {
  const md = json?.catalogMetadata?.catalog ?? json?.catalogMetadataV2?.catalog;
  if (!isObj(md)) return null;
  const family = json?.catalogMetadata?.family?.tvAncestors ?? [];
  const show = family.find((a) => a?.catalog?.type === 'SHOW')?.catalog;
  const season = family.find((a) => a?.catalog?.type === 'SEASON')?.catalog;
  return {
    asin: md.id,
    type: md.type === 'EPISODE' ? 'episode' : 'movie',
    name: md.title,
    series: show?.title,
    season: season?.seasonNumber,
    episode: md.episodeNumber,
    runtime: md.runtimeSeconds,
  };
}

/** Cheap check on the first bytes of a response body. */
export function looksLikeSubtitle(head) {
  const s = String(head).replace(/^﻿/, '').trimStart().slice(0, 300);
  return s.startsWith('WEBVTT') || (/^<\?xml|^<tt[\s>]/.test(s) && /<tt[\s:>]/.test(s));
}

// ---- which network responses are worth reading ---------------------------------
//
// The page hook sees every request the player makes: media segments, API
// calls, logging. Reading or parsing those would double the page's own work,
// so this decides from the URL (plus cheap header facts) alone. Called on every
// request: keep it to a few regex tests.

export const MAX_INSPECT_BYTES = 4 * 1024 * 1024;
const SUBTITLE_PATH = /\.(vtt|dfxp|ttml2?|srt|xml)(\?|$)/i;
const SUBTITLE_TYPE = /\b(xml|vtt|ttml)\b/i;
const NETFLIX_JSON = /\/metadata(\?|\/|$)|manifest/i;
const PRIME_JSON = /GetPlaybackResources|playback[^/?]*\.json/i;

/**
 * @param {string} url
 * @param {string} host        location.hostname of the page
 * @param {{ contentType?: string, length?: number, binary?: boolean }} facts
 *   length 0 = unknown; binary = an XHR arraybuffer response
 * @returns {'json'|'subtitle'|'peek'|null}
 *   json      player data we extract titles / subtitle URLs from
 *   subtitle  a caption file
 *   peek      binary that might be a caption file: check its first bytes only
 */
export function classifyResponse(url, host, { contentType = '', length = 0, binary = false } = {}) {
  if (length > MAX_INSPECT_BYTES) return null;
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const netflix = /(^|\.)netflix\.com$/.test(host);
  if (netflix ? NETFLIX_JSON.test(path) : PRIME_JSON.test(path)) return 'json';
  if (/video|audio|octet|image|font|javascript|css|html|json/i.test(contentType)) return null;
  if (SUBTITLE_PATH.test(path) || SUBTITLE_TYPE.test(contentType)) return 'subtitle';
  // Netflix serves media and caption files from the same CDN URLs (?o=...).
  // Media is labelled (octet-stream, handled above); only unlabelled binary is
  // worth a look at its first bytes.
  if (netflix && binary && !contentType && /[?&]o=/.test(path)) return 'peek';
  return null;
}

// Requests whose responses could matter, judged from the URL alone so the
// page hook can ignore everything else without attaching a listener. Media
// segments are deliberately excluded: Netflix subtitle files are found
// through the manifest, never by inspecting media traffic.
const CANDIDATE_URL = /\/metadata(\?|\/|$)|manifest|GetPlaybackResources|playback[^/?]*\.json|\.(vtt|dfxp|ttml2?|srt|xml)(\?|$)|subtitle|caption|timedtext/i;
export function mayMatter(url) {
  return CANDIDATE_URL.test(String(url).replace(/^[a-z]+:\/\/[^/]+/i, ''));
}
