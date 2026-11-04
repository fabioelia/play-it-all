// Pure extractors for the JSON the streaming players already download.
// The page hook passes captured response bodies through these to learn
// (a) what episode is playing and (b) where its full subtitle track lives,
// so the analyzer can scan the whole episode ahead of playback.
//
// Response shapes are undocumented and change; every extractor is defensive
// and returns empty results rather than throwing.

import { platformForHost } from './platforms.js';
import { detectFormat } from './subtitles.js';

const isObj = (v) => v && typeof v === 'object';

/** Rough language match: "en", "en-US", "en-GB" → true for "en". */
export function isLang(code, want = 'en') {
  return typeof code === 'string' && code.toLowerCase().split(/[-_]/)[0] === want;
}

// Netflix formats we can parse, best first. SDH tracks carry sound
// descriptions, which feed the scene hints.
// (nflx-cmisc is image subtitles: nothing to read.)
const NETFLIX_FORMATS = ['dfxp-ls-sdh', 'imsc1.1', 'webvtt-lssdh-ios8', 'simplesdh'];

/**
 * The track list of a Netflix manifest, in either of the shapes the player
 * accepts: v1 (`timedtexttracks`, `ttDownloadables`, `cdn_id`) or v2+
 * (`textTracks`, `downloadables`, `cdnId`). Accepts the manifest or the PBO
 * response wrapping it ({ result: manifest }). Null when it is not a manifest.
 */
export function netflixTextTracks(json) {
  if (!isObj(json)) return null;
  const root = isObj(json.result) ? json.result : json;
  const list = Array.isArray(root.timedtexttracks) ? root.timedtexttracks : Array.isArray(root.textTracks) ? root.textTracks : null;
  return list ? { movieId: root.movieId ?? root.viewableId ?? null, list } : null;
}

/**
 * Netflix player manifest (/playapi/cadmium/manifest, licensedManifest, or
 * the decrypted copy the player JSON.parses).
 * Returns [{ url, language, sdh, format }] best first.
 */
export function extractNetflixTimedText(json, lang = 'en') {
  return netflixManifestInfo(json, lang).tracks;
}

/**
 * What a Netflix manifest says about subtitles in `lang`:
 * { movieId, tracks: [{ url, language, sdh, format }] best first,
 *   available: tracks in that language, dehydrated: of those, how many came
 *   without download links (Netflix sends links only for the selected track;
 *   the rest arrive when the viewer picks one) }.
 */
export function netflixManifestInfo(json, lang = 'en') {
  const found = netflixTextTracks(json);
  const out = { movieId: found?.movieId != null ? String(found.movieId) : null, tracks: [], available: 0, dehydrated: 0 };
  for (const track of found?.list || []) {
    if (!isObj(track) || track.isNoneTrack || track.isForcedNarrative) continue;
    if (!isLang(track.language, lang)) continue;
    out.available++;
    const sdh = /closed|sdh|cc/i.test(`${track.trackType} ${track.rawTrackType} ${track.languageDescription}`);
    const downloadables = track.ttDownloadables || track.downloadables || {};
    let links = 0;
    for (const format of NETFLIX_FORMATS) {
      const d = downloadables[format];
      if (!d) continue;
      for (const url of downloadableUrls(d)) {
        out.tracks.push({ url, language: track.language, sdh, format });
        links++;
      }
    }
    if (!links) out.dehydrated++;
  }
  out.tracks.sort((a, b) => Number(b.sdh) - Number(a.sdh) || NETFLIX_FORMATS.indexOf(a.format) - NETFLIX_FORMATS.indexOf(b.format));
  return out;
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

/**
 * Cheap check on the first bytes of a response body: WebVTT, TTML/DFXP, SRT,
 * YouTube json3/srv3 or ASS, i.e. anything the background parser reads.
 */
export function looksLikeSubtitle(head) {
  const s = String(head ?? '').slice(0, 2000);
  const format = s.trim() ? detectFormat(s) : null;
  // Any XML document passes detectFormat's TTML test; an error page is not a <tt> document.
  return format === 'ttml' ? /<tt[\s:>]/.test(s) : format !== null;
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
 * @returns {'json'|'subtitle'|'manifest'|'peek'|null}
 *   json      player data we extract titles / subtitle URLs from
 *   subtitle  a caption file
 *   manifest  an HLS or DASH manifest (only its subtitle renditions are read)
 *   peek      binary that might be a caption file: check its first bytes only
 */
export function classifyResponse(url, host, { contentType = '', length = 0, binary = false } = {}) {
  if (length > MAX_INSPECT_BYTES) return null;
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const site = siteRule(host);
  if (site) {
    const kind = site(String(url), path);
    // A media segment is never read, whatever its URL looks like.
    if (!kind || /^(video|audio|image|font)\//i.test(contentType) || /html|javascript|css/i.test(contentType)) return null;
    return kind;
  }
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
// through the manifest, never by inspecting media traffic. On Netflix only
// the path is checked (its API and logging URLs carry long query strings)
// and only the two responses CleanCut reads: episode metadata and manifests.
const CANDIDATE_URL = /\/metadata(\?|\/|$)|manifest|GetPlaybackResources|playback[^/?]*\.json|\.(vtt|dfxp|ttml2?|srt|xml)(\?|$)|subtitle|caption|timedtext/i;
const NETFLIX_URL = /\/metadata(\/|$)|manifest/i;
export function mayMatter(url, host = '') {
  const full = String(url);
  const path = full.replace(/^[a-z]+:\/\/[^/]+/i, '');
  if (/(^|\.)netflix\.com$/.test(host)) return NETFLIX_URL.test(path.replace(/[?#].*/, ''));
  const site = siteRule(host);
  if (site) return site(full, path) !== null;
  return CANDIDATE_URL.test(path);
}

// ---- per-site request rules -------------------------------------------------------
//
// For each site with its own adapter (Netflix and Prime are handled above), the
// few requests whose responses can name the title or list its subtitles. A
// rule gets the full URL and its path (with query) and answers 'json',
// 'subtitle', 'manifest' or null. Everything else, every media segment
// included, gets null and is never touched by the page hook. Keep each rule to
// a couple of regex tests: they run on every request the page makes.
const pathOnly = (path) => path.replace(/[?#].*/, '');
const HLS_OR_DASH = /\.(m3u8|mpd)$/i;
const WHOLE_SUBTITLE_FILE = /\.(vtt|webvtt|srt|ttml2?|dfxp|ass|ssa|smi)$/i;
const manifestOnly = (re) => (url, path) => (re.test(pathOnly(path)) ? 'manifest' : null);

const SITE_RULES = {
  // The player response (on every in-app navigation and in embeds; the first
  // one of a page load is inline, see page-hook.js) and the caption file the
  // player downloads when the viewer turns captions on, if it is English.
  youtube(url, path) {
    if (/^\/youtubei\/v1\/player(?:\?|$)/.test(path)) return 'json';
    if (/^\/api\/timedtext\?/.test(path) && /[?&](?:tlang|lang)=en\b/.test(path)) return 'subtitle';
    return null;
  },
  // The player config lists its text tracks; each track is one whole file.
  vimeo(url, path) {
    if (/^\/video\/\d+\/config(?:\?|$)/.test(path)) return 'json';
    if (/^https:\/\/captions\.vimeo\.com\/captions\/\d+\.vtt/.test(url) || /^\/texttrack\/\d+\.vtt/.test(path)) return 'subtitle';
    return null;
  },
  // The content API lists the title's .srt files (served as octet-stream).
  tubi(url, path) {
    const p = pathOnly(path);
    if (/^\/(?:api\/v\d+\/content|oz\/videos\/\d+\/content)$/.test(p)) return 'json';
    if (/^https:\/\/s\.adrise\.tv\//.test(url) && /\.(srt|vtt)$/i.test(p)) return 'subtitle';
    return null;
  },
  // /v6/playlist lists WebVTT and TTML caption files per language.
  hulu(url, path) {
    const p = pathOnly(path);
    if (/^https:\/\/play\.hulu\.com\//.test(url) && /^\/v\d+\/playlist$/.test(p)) return 'json';
    if (WHOLE_SUBTITLE_FILE.test(p) && /caption|transcript|subtitle/i.test(p)) return 'subtitle';
    return null;
  },
  // The play service lists ASS subtitles and closed captions per language.
  crunchyroll(url, path) {
    const p = pathOnly(path);
    if (/^https:\/\/cr-play-service\.prd\.crunchyrollsvc\.com\//.test(url) && /\/play$/.test(p)) return 'json';
    if (/\.(ass|ssa|vtt)$/i.test(p)) return 'subtitle';
    return null;
  },
  // Library metadata names the episode and lists its subtitle streams; a
  // sidecar subtitle is /library/streams/<id> on the viewer's own server.
  plex(url, path) {
    const p = pathOnly(path);
    if (/^\/library\/metadata\/\d+$/.test(p)) return 'json';
    if (/^\/library\/streams\/\d+$/.test(p)) return 'subtitle';
    if (/\/transcode\/universal\/start\.(m3u8|mpd)$/.test(p)) return 'manifest';
    if (/^https:\/\/[^/]*vod\.provider\.plex\.tv\//.test(url) && HLS_OR_DASH.test(p)) return 'manifest';
    return null;
  },
  // On demand only: live channels reload their playlists every few seconds.
  pluto: manifestOnly(/\/stitch\/hls\/episode\/.*\.m3u8$/i),
  // These list subtitles in their HLS or DASH manifests (segmented WebVTT or
  // sidecar files); the segments themselves are never read passively.
  disney: manifestOnly(HLS_OR_DASH),
  max: manifestOnly(HLS_OR_DASH),
  appletv: manifestOnly(/\.m3u8$/i),
  paramount: manifestOnly(HLS_OR_DASH),
  peacock: manifestOnly(HLS_OR_DASH),
  roku: manifestOnly(HLS_OR_DASH),
};

// A page's host never changes: look its rule up once.
let ruleHost = null;
let ruleFn = null;
function siteRule(host) {
  if (host !== ruleHost) {
    ruleHost = host;
    ruleFn = SITE_RULES[platformForHost(host)?.id] || null;
  }
  return ruleFn;
}

/**
 * Whether a manifest body is worth passing on: an HLS master playlist or a
 * DASH MPD that lists text renditions. Media playlists (which live streams
 * reload every few seconds) and manifests without text are dropped in the page hook.
 */
export function manifestHasText(text) {
  if (typeof text !== 'string') return false;
  if (text.includes('#EXTM3U')) return text.includes('TYPE=SUBTITLES');
  return /<MPD[\s>]/.test(text) && /contentType="text"|mimeType="(?:text\/vtt|application\/ttml\+xml)"/.test(text);
}

// ---- extractors for the other services ----------------------------------------------
//
// Each returns subtitle tracks as [{ url, language, sdh, format, ... }], best
// first, and where the response names the title, { movieId, meta }. A track
// with format 'hls' is a subtitle media playlist (segmented WebVTT) rather
// than a file; content/network.js downloads and joins its segments.

/** English by code ("en", "en-US", "eng") or by name ("English", "English [CC]"). */
export function isEnglish(value, want = 'en') {
  if (typeof value !== 'string' || !value) return false;
  if (want !== 'en') return isLang(value, want);
  return isLang(value, 'en') || /^eng\b|^english\b/i.test(value.trim());
}

const SDH_NAME = /\b(cc|sdh)\b|closed caption|hearing/i;

function absolute(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

/** Set (or replace) one query parameter without re-encoding the rest of a signed URL. */
function withParam(url, key, value) {
  const re = new RegExp(`([?&])${key}=[^&#]*`);
  if (re.test(url)) return url.replace(re, `$1${key}=${value}`);
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${value}`;
}

// ---- YouTube ------------------------------------------------------------------------

/**
 * Caption tracks of a YouTube player response
 * (captions.playerCaptionsTracklistRenderer.captionTracks): manual English
 * tracks first (CC/SDH-named ones before others), then automatic (kind 'asr'),
 * and only when the video has no English at all, a machine translation of its
 * first track (tlang=en). Each URL asks for json3. `ask`: when the download
 * comes back empty (YouTube can require a token only its player has), the
 * viewer is asked to turn captions on once so the player's own request is read.
 */
export function youtubeCaptionTracks(playerResponse, lang = 'en') {
  const list = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(list)) return [];
  const manual = [];
  const asr = [];
  const other = [];
  for (const t of list) {
    if (!isObj(t) || typeof t.baseUrl !== 'string') continue;
    const base = absolute(t.baseUrl, 'https://www.youtube.com/');
    if (!base) continue;
    const name = t.name?.simpleText || (Array.isArray(t.name?.runs) ? t.name.runs.map((r) => r?.text || '').join('') : '');
    const auto = t.kind === 'asr' || /^a\./.test(t.vssId || '');
    const track = { url: withParam(base, 'fmt', 'json3'), language: t.languageCode, sdh: SDH_NAME.test(name), format: 'json3', kind: auto ? 'asr' : 'manual', name, ask: true };
    if (isLang(t.languageCode, lang)) (auto ? asr : manual).push(track);
    else if (t.isTranslatable !== false) other.push({ ...track, auto });
  }
  manual.sort((a, b) => Number(b.sdh) - Number(a.sdh));
  const out = [...manual, ...asr];
  if (!out.length && other.length) {
    const src = other.find((t) => !t.auto) || other[0];
    out.push({ url: withParam(src.url, 'tlang', lang), language: lang, sdh: false, format: 'json3', kind: 'translated', name: src.name, from: src.language, ask: true });
  }
  return out.slice(0, 3);
}

/**
 * What a YouTube player response (ytInitialPlayerResponse or /youtubei/v1/player)
 * says: { movieId: video id, meta: { name, channel, runtime, ... }, tracks, available, dehydrated: 0 }.
 * Null when it names no video.
 */
export function youtubePlayerInfo(pr, lang = 'en') {
  const vd = pr?.videoDetails;
  const id = typeof vd?.videoId === 'string' ? vd.videoId : null;
  if (!id) return null;
  const tracks = youtubeCaptionTracks(pr, lang);
  const mf = pr.microformat?.playerMicroformatRenderer;
  const year = Number(/^(\d{4})-/.exec(mf?.publishDate || '')?.[1]) || undefined;
  const meta = {
    name: vd.title || undefined,
    channel: vd.author || undefined,
    runtime: Number(vd.lengthSeconds) || undefined,
    type: 'video',
    ...(vd.isLiveContent ? { live: true } : {}),
    // Films and shows sold or streamed on YouTube are the only videos matched
    // to the catalog by name (see adapters/youtube.js).
    ...(vd.isTvfilmVideo ? { tvfilm: true, year } : {}),
  };
  return { movieId: id, meta, tracks, available: tracks.filter((t) => t.kind !== 'translated').length, dehydrated: 0 };
}

/**
 * Language of a YouTube timed-text request: the translation target if any,
 * else the track's own language.
 */
export function youtubeSubtitleLanguage(url) {
  const q = String(url).split('?')[1] || '';
  const get = (k) => new RegExp(`(?:^|&)${k}=([^&#]*)`).exec(q)?.[1] || '';
  return decodeURIComponent(get('tlang') || get('lang'));
}

// ---- Vimeo ----------------------------------------------------------------------------

/** Player config (player.vimeo.com/video/<id>/config, or window.playerConfig in the embed). */
export function vimeoConfigInfo(json, lang = 'en') {
  const video = json?.video;
  if (!isObj(video) || video.id == null) return null;
  const list = Array.isArray(json.request?.text_tracks) ? json.request.text_tracks : [];
  const tracks = list
    .filter((t) => isObj(t) && typeof t.url === 'string' && isEnglish(t.lang || t.label, lang) && !/forced/i.test(`${t.kind} ${t.label}`))
    .map((t) => ({ url: absolute(t.url, 'https://player.vimeo.com/'), language: t.lang, sdh: t.kind === 'captions' || SDH_NAME.test(t.label || ''), format: 'vtt' }))
    .filter((t) => t.url)
    .sort((a, b) => Number(b.sdh) - Number(a.sdh));
  return {
    movieId: String(video.id),
    meta: { name: video.title || undefined, channel: video.owner?.name || undefined, runtime: Number(video.duration) || undefined, type: 'video' },
    tracks,
    available: tracks.length,
    dehydrated: 0,
  };
}

// ---- Tubi -----------------------------------------------------------------------------

function findWith(json, key, depth = 3) {
  if (!isObj(json) || depth < 0) return null;
  if (Array.isArray(json[key])) return json;
  for (const v of Array.isArray(json) ? json : Object.values(json)) {
    const hit = isObj(v) ? findWith(v, key, depth - 1) : null;
    if (hit) return hit;
  }
  return null;
}

/** Content API response (the same shape the page embeds for its first title). */
export function tubiContentInfo(json, lang = 'en') {
  const item = findWith(json, 'subtitles');
  if (!item) return null;
  const tracks = item.subtitles
    .filter((s) => isObj(s) && typeof s.url === 'string' && (isEnglish(s.lang, lang) || isEnglish(s.lang_alpha3, lang)))
    // Listed as http://; the page is https and would block it as mixed content.
    .map((s) => ({ url: s.url.replace(/^http:\/\//, 'https://'), language: 'en', sdh: SDH_NAME.test(`${s.lang} ${s.lang_translation || ''}`), format: /\.vtt(\?|$)/i.test(s.url) ? 'vtt' : 'srt' }));
  const id = item.id ?? item.content_id;
  return {
    movieId: id != null ? String(id) : null,
    meta: { name: item.title || undefined, year: Number(item.year) || undefined, runtime: Number(item.duration) || undefined },
    tracks,
    available: tracks.length,
    dehydrated: 0,
  };
}

// ---- Hulu -----------------------------------------------------------------------------

/** play.hulu.com /v6/playlist: transcripts_urls { webvtt: { en: url }, ttml: { en: url } }. */
export function huluPlaylistTracks(json, lang = 'en') {
  const urls = json?.transcripts_urls;
  if (!isObj(urls)) return [];
  const out = [];
  for (const [format, key] of [['vtt', 'webvtt'], ['ttml', 'ttml']]) {
    const byLang = urls[key];
    if (!isObj(byLang)) continue;
    for (const [code, url] of Object.entries(byLang)) {
      if (typeof url === 'string' && isLang(code, lang)) out.push({ url, language: code, sdh: true, format });
    }
  }
  return out;
}

// ---- Crunchyroll --------------------------------------------------------------------

/**
 * Play service response: { captions: { 'en-US': { url, format } }, subtitles: { 'en-US': { url, format: 'ass' } } }.
 * Closed captions (with sound cues) first, then subtitles.
 */
export function crunchyrollPlayTracks(json, lang = 'en') {
  const out = [];
  for (const [field, sdh] of [['captions', true], ['subtitles', false]]) {
    const group = json?.[field];
    if (!isObj(group)) continue;
    for (const [code, t] of Object.entries(group)) {
      const url = isObj(t) ? t.url : null;
      const language = (isObj(t) && t.language) || code;
      if (typeof url !== 'string' || !/^https?:/.test(url) || !isLang(language, lang)) continue;
      out.push({ url, language, sdh, format: (isObj(t) && t.format) || (/\.ass(\?|$)/i.test(url) ? 'ass' : 'vtt') });
    }
  }
  return out;
}

// ---- Plex -----------------------------------------------------------------------------

/**
 * /library/metadata/<ratingKey> (JSON): what the item is, and its subtitle
 * streams that can be downloaded (text formats with a key). requestUrl gives the
 * server's address and the viewer's token, which the stream URLs need.
 */
export function plexMetadataInfo(json, requestUrl, lang = 'en') {
  const item = json?.MediaContainer?.Metadata?.[0];
  if (!isObj(item) || item.ratingKey == null) return null;
  const episode = item.type === 'episode';
  const meta = episode
    ? { type: 'episode', series: item.grandparentTitle, season: Number(item.parentIndex), episode: Number(item.index), name: item.title }
    : { type: 'movie', name: item.title, year: Number(item.year) || undefined };
  if (Number(item.duration)) meta.runtime = Math.round(Number(item.duration) / 1000);
  const tracks = [];
  let origin = null;
  let token = null;
  try {
    const u = new URL(requestUrl);
    origin = u.origin;
    token = u.searchParams.get('X-Plex-Token');
  } catch { /* relative or invalid */ }
  for (const media of item.Media || []) {
    for (const part of media?.Part || []) {
      for (const s of part?.Stream || []) {
        if (!isObj(s) || Number(s.streamType) !== 3 || typeof s.key !== 'string') continue;
        if (!(isEnglish(s.languageCode, lang) || isEnglish(s.language, lang))) continue;
        if (!/^(srt|ass|ssa|vtt|webvtt|ttml|smi|subrip)$/i.test(s.codec || '')) continue; // image subtitles (PGS, VobSub) cannot be read
        if (s.forced) continue;
        const url = absolute(`${s.key}${token ? `${s.key.includes('?') ? '&' : '?'}X-Plex-Token=${encodeURIComponent(token)}` : ''}`, origin || undefined);
        if (url) tracks.push({ url, language: s.languageCode || 'en', sdh: !!s.hearingImpaired || SDH_NAME.test(`${s.title || ''} ${s.displayTitle || ''}`), format: s.codec });
      }
    }
  }
  tracks.sort((a, b) => Number(b.sdh) - Number(a.sdh));
  return { ratingKey: String(item.ratingKey), guid: item.guid || null, meta, tracks };
}

// ---- HLS and DASH manifests ---------------------------------------------------------

function m3u8Attrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[3] ?? m[2];
  return out;
}

/**
 * Subtitle renditions of an HLS master playlist (#EXT-X-MEDIA:TYPE=SUBTITLES):
 * English, not forced, SDH ("describes-music-and-sound" or CC/SDH in the name) first.
 * Each is a media playlist of WebVTT segments (format 'hls').
 */
export function hlsSubtitleTracks(text, baseUrl, lang = 'en') {
  if (typeof text !== 'string' || !text.includes('#EXTM3U')) return [];
  const out = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=SUBTITLES/.test(line)) continue;
    const a = m3u8Attrs(line.slice('#EXT-X-MEDIA:'.length));
    if (!a.URI || a.FORCED === 'YES') continue;
    if (!(isEnglish(a.LANGUAGE, lang) || (!a.LANGUAGE && isEnglish(a.NAME, lang)))) continue;
    const url = absolute(a.URI, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const sdh = /describes-music-and-sound/.test(a.CHARACTERISTICS || '') || SDH_NAME.test(a.NAME || '');
    out.push({ url, language: a.LANGUAGE || lang, sdh, format: 'hls', name: a.NAME || '' });
  }
  return out.sort((a, b) => Number(b.sdh) - Number(a.sdh));
}

/** The segment URLs of an HLS media playlist, resolved against its own URL. */
export function hlsSegments(text, baseUrl) {
  if (typeof text !== 'string' || !text.includes('#EXTM3U')) return [];
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const url = absolute(line, baseUrl);
    if (url && out[out.length - 1] !== url) out.push(url); // byte-range playlists repeat one file
  }
  return out;
}

const xmlAttr = (attrs, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
const firstBaseUrl = (xml) => /<BaseURL[^>]*>\s*([^<\s][^<]*?)\s*<\/BaseURL>/.exec(xml)?.[1] || null;

/**
 * Sidecar text tracks of a DASH MPD: text AdaptationSets (WebVTT or TTML,
 * not fragmented MP4) whose Representation is a single file (BaseURL).
 * Segmented text tracks are skipped.
 */
export function dashSubtitleTracks(xml, baseUrl, lang = 'en') {
  if (typeof xml !== 'string' || !/<MPD[\s>]/.test(xml)) return [];
  // MPD-level BaseURL: the first one before any Period.
  const head = xml.slice(0, Math.max(0, xml.search(/<Period[\s>]/)));
  const root = absolute(firstBaseUrl(head) || '', baseUrl) || baseUrl;
  const out = [];
  const setRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g;
  let m;
  while ((m = setRe.exec(xml))) {
    const [, attrs, body] = m;
    const mime = xmlAttr(attrs, 'mimeType') || xmlAttr(body, 'mimeType') || '';
    const text = xmlAttr(attrs, 'contentType') === 'text' || /^(text\/vtt|application\/ttml\+xml)$/.test(mime);
    if (!text || /mp4/.test(mime)) continue;
    const language = xmlAttr(attrs, 'lang') || xmlAttr(body, 'lang') || '';
    if (!isEnglish(language, lang)) continue;
    const roles = [...body.matchAll(/<Role\b[^>]*value="([^"]*)"/g)].map((r) => r[1]).join(' ');
    if (/forced/i.test(`${roles} ${xmlAttr(attrs, 'label') || ''}`)) continue;
    const file = firstBaseUrl(body);
    if (!file || /<SegmentTemplate|<SegmentList/.test(body)) continue;
    const url = absolute(file, root);
    if (!url) continue;
    const sdh = /caption/i.test(roles) || SDH_NAME.test(`${xmlAttr(attrs, 'label') || ''} ${file}`) || /accessibility|hearing|DescribesMusicAndSound/i.test(body);
    out.push({ url, language, sdh, format: /ttml/.test(mime) || /\.(ttml2?|dfxp|xml)(\?|$)/i.test(file) ? 'ttml' : 'vtt' });
  }
  return out.sort((a, b) => Number(b.sdh) - Number(a.sdh));
}

/** Subtitle tracks listed by an HLS or DASH manifest body. */
export function manifestSubtitleTracks(text, baseUrl, lang = 'en') {
  if (typeof text !== 'string') return [];
  return text.includes('#EXTM3U') ? hlsSubtitleTracks(text, baseUrl, lang) : dashSubtitleTracks(text, baseUrl, lang);
}

// ---- structured data (JSON-LD) ------------------------------------------------------

/**
 * Title metadata from a page's JSON-LD blocks (parsed objects), as
 * { series, season, episode, name, year, type }. When `id` is given, only a
 * node whose url / @id contains it counts: single-page apps leave the first
 * page's block in place after navigating elsewhere.
 */
export function metaFromJsonLd(docs, id) {
  const nodes = [];
  const walk = (v, depth) => {
    if (!isObj(v) || depth > 4) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (v['@type']) nodes.push(v);
    if (Array.isArray(v['@graph'])) walk(v['@graph'], depth + 1);
  };
  walk(docs, 0);
  const type = (n) => [n['@type']].flat().join(' ');
  const mentions = (n) => !id || [n.url, n['@id'], n.embedUrl, n.contentUrl].some((u) => typeof u === 'string' && u.includes(id));
  const ep = nodes.find((n) => /\b(TVEpisode|Episode)\b/.test(type(n)) && mentions(n));
  if (ep) {
    const series = ep.partOfSeries?.name || ep.partOfSeason?.partOfSeries?.name;
    const season = Number(ep.partOfSeason?.seasonNumber);
    const episode = Number(ep.episodeNumber);
    return { type: 'episode', series, season: Number.isFinite(season) ? season : undefined, episode: Number.isFinite(episode) ? episode : undefined, name: ep.name };
  }
  const film = nodes.find((n) => /\bMovie\b/.test(type(n)) && mentions(n)) || nodes.find((n) => /\bVideoObject\b/.test(type(n)) && mentions(n));
  if (!film?.name) return null;
  const date = film.dateCreated || film.datePublished || film.releasedEvent?.startDate || '';
  const year = Number(/^(\d{4})/.exec(String(date))?.[1]) || undefined;
  return { type: /\bMovie\b/.test(type(film)) ? 'movie' : undefined, name: String(film.name).replace(/\s*\((\d{4})\)\s*$/, ''), year };
}
