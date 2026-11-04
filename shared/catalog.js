// The community catalog: plain JSON files in a GitHub repository.
//
//   catalog/
//     index.json                         generated: what exists, and how to find it
//     shows/<show>/show.json             { name, year?, ids?, aliases? }
//     shows/<show>/s01e01.json           an episode (format below)
//     movies/<movie>.json                a film (same format, type "movie")
//     lists/<id>.json                    published skip lists
//
// One file per episode, shared by every platform. Each platform the episode
// is on gets an entry with its own video id and how its clock relates to the
// episode's reference timeline:
//
//   platform_time = reference_time × speed + offset
//
// Every tag remembers which platform it was timed on ("on"), so a tag made on
// Netflix plays on Prime as soon as Prime's offset is known: from a
// contributor, or measured automatically by matching subtitle timings
// (shared/align.js) against the episode's stored cue fingerprint.
//
// Episode file:
// {
//   "key": "game-of-thrones/s01e01", "type": "episode",
//   "series": "Game of Thrones", "season": 1, "episode": 1, "name": "Winter Is Coming", "runtime": 3720,
//   "timeline": "netflix",                                    // the reference platform
//   "platforms": {
//     "netflix": { "id": "70248288", "offset": 0, "speed": 1 },
//     "prime":   { "id": "B007ABC", "offset": 12.4, "speed": 1 },
//     "web":     { "id": "example.com/…", "offset": null }    // not yet synced
//   },
//   "sync": { "cues": [12.3, 15.8, …] },                       // subtitle cue starts, reference timeline
//   "segments": [ { "id": "k3x9a1", "on": "netflix", "start": 1210, "end": 1290,
//                   "category": "sex", "severity": 3, "note": "", "by": "octocat" } ]
// }

import { alignCues, fingerprint } from './align.js';
import { canonicalKey, PLATFORMS, slug } from './identity.js';
import { resolveProfile } from './ratings.js';
import { validateSegment } from './validate.js';

export const CATALOG_VERSION = 1;
const EPISODE_KEY = /^([a-z0-9-]+)\/s(\d{2,})e(\d{2,})$/;
const MOVIE_KEY = /^[a-z0-9-]+$/;

// ---- file format -------------------------------------------------------------------------

/** Pretty JSON with number lists (cue fingerprints) kept on one line. */
export function formatCatalogJson(doc) {
  return `${JSON.stringify(doc, null, 2).replace(/\[\s*(-?[\d.]+(?:,\s*-?[\d.]+)*)\s*\]/g, (_, nums) => `[${nums.split(/,\s*/).join(', ')}]`)}\n`;
}

// ---- paths and ids -------------------------------------------------------------------

export function pathForKey(key) {
  const m = EPISODE_KEY.exec(key);
  if (m) return `shows/${m[1]}/s${m[2]}e${m[3]}.json`;
  if (MOVIE_KEY.test(key)) return `movies/${key}.json`;
  throw new Error(`not a catalog key: ${key}`);
}

/** Stable short id from what the tag says, so the same tag gets the same id everywhere. */
export function segmentId(seg) {
  const s = `${seg.on}|${seg.category}|${Number(seg.start).toFixed(1)}|${Number(seg.end).toFixed(1)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36).padStart(7, '0');
}

// ---- time conversion -------------------------------------------------------------------

const synced = (p) => p && Number.isFinite(p.offset);

/** Convert a time on platform `from` to platform `to` (entries from episode.platforms). */
export function convertTime(t, from, to) {
  const ref = (t - from.offset) / (from.speed || 1);
  return ref * (to.speed || 1) + to.offset;
}

/**
 * Segments of an episode on one platform's clock.
 * @param {object} episode
 * @param {string} platform
 * @param {{offset:number, speed?:number}} [measured] alignment measured on this device,
 *   used when the catalog does not know this platform's offset yet
 * @returns {{ segments: Array, timing: 'native'|'synced'|'aligned'|'unsynced', skipped: number }}
 *   unsynced: the platform's clock is unknown; times are on the reference
 *   timeline and need a manual nudge.
 */
export function segmentsFor(episode, platform, measured) {
  const known = episode.platforms?.[platform];
  let target = synced(known) ? known : measured && Number.isFinite(measured.offset) ? { speed: 1, ...measured } : null;
  const timing = !target ? 'unsynced' : synced(known) ? (platform === episode.timeline ? 'native' : 'synced') : 'aligned';
  if (!target) target = { offset: 0, speed: 1 }; // show on the reference clock
  const out = [];
  let skipped = 0;
  for (const seg of episode.segments || []) {
    const on = seg.on || episode.timeline;
    let start = seg.start;
    let end = seg.end;
    // Tags timed on this platform always play as recorded.
    if (on !== platform) {
      const from = on === episode.timeline ? { offset: 0, speed: 1 } : episode.platforms?.[on];
      if (!synced(from)) {
        skipped++;
        continue;
      }
      start = convertTime(seg.start, from, target);
      end = convertTime(seg.end, from, target);
    }
    out.push({ ...seg, start: round2(start), end: round2(end), source: seg.source || 'community' });
  }
  return { segments: out, timing, skipped };
}

/** Subtitle fingerprint on the reference timeline, for aligning a new platform. */
export function referenceCues(episode) {
  return episode.sync?.cues || [];
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---- validation ------------------------------------------------------------------------

function checkPlatformEntry(name, entry, errors) {
  if (!PLATFORMS.includes(name)) errors.push(`platforms.${name}: unknown platform (use ${PLATFORMS.join(', ')})`);
  if (!entry || typeof entry.id !== 'string' || !entry.id) errors.push(`platforms.${name}.id must be a non-empty string`);
  if (entry && entry.offset !== null && !Number.isFinite(entry.offset)) errors.push(`platforms.${name}.offset must be a number or null`);
  if (entry && entry.speed !== undefined && !(entry.speed > 0.9 && entry.speed < 1.1)) errors.push(`platforms.${name}.speed must be close to 1`);
}

export function validateEpisode(doc, file = '') {
  const errors = [];
  if (!doc || typeof doc !== 'object') return ['not a JSON object'];
  if (!EPISODE_KEY.test(doc.key || '') && !MOVIE_KEY.test(doc.key || '')) errors.push('key must look like "show/s01e01" or "movie-name-1999"');
  else if (file && !file.endsWith(pathForKey(doc.key))) errors.push(`key "${doc.key}" belongs in ${pathForKey(doc.key)}`);
  if (!['episode', 'movie'].includes(doc.type)) errors.push('type must be "episode" or "movie"');
  if (doc.type === 'episode' && !(doc.series && Number.isInteger(doc.season) && Number.isInteger(doc.episode))) errors.push('episodes need series, season and episode');
  if (!doc.platforms || typeof doc.platforms !== 'object' || !Object.keys(doc.platforms).length) errors.push('platforms must list at least one platform');
  else {
    for (const [name, entry] of Object.entries(doc.platforms)) checkPlatformEntry(name, entry, errors);
    const ref = doc.platforms[doc.timeline];
    if (!ref) errors.push('timeline must name one of the platforms');
    else if (ref.offset !== 0 || (ref.speed ?? 1) !== 1) errors.push('the timeline platform must have offset 0 and speed 1');
  }
  if (doc.sync && !(Array.isArray(doc.sync.cues) && doc.sync.cues.length <= 1000 && doc.sync.cues.every(Number.isFinite))) errors.push('sync.cues must be up to 1000 numbers');
  const ids = new Set();
  (doc.segments || []).forEach((s, i) => {
    const v = validateSegment(s);
    if (!v.ok) errors.push(`segments[${i}]: ${v.error}`);
    if (!s.id) errors.push(`segments[${i}]: missing id`);
    else if (ids.has(s.id)) errors.push(`segments[${i}]: duplicate id ${s.id}`);
    ids.add(s.id);
    if (s.on && !doc.platforms?.[s.on]) errors.push(`segments[${i}]: on "${s.on}" is not in platforms`);
  });
  const seen = new Map();
  for (const [name, entry] of Object.entries(doc.platforms || {})) {
    if (entry?.id && seen.has(`${name}:${entry.id}`)) errors.push(`platform id ${name}:${entry.id} listed twice`);
    seen.set(`${name}:${entry?.id}`, true);
  }
  return errors;
}

export function validateShow(doc) {
  const errors = [];
  if (!doc?.name) errors.push('name is required');
  if (doc?.aliases && !(Array.isArray(doc.aliases) && doc.aliases.every((a) => typeof a === 'string'))) errors.push('aliases must be a list of names');
  return errors;
}

export function validateList(doc, file = '') {
  const errors = [];
  if (!/^[a-z0-9-]{3,60}$/.test(doc?.id || '')) errors.push('id must be 3–60 lowercase letters, digits or dashes');
  else if (file && !file.endsWith(`lists/${doc.id}.json`)) errors.push(`list "${doc.id}" belongs in lists/${doc.id}.json`);
  if (!doc?.name || doc.name.length < 3) errors.push('name is required');
  if (doc?.scope !== '*' && !EPISODE_KEY.test(doc?.scope || '') && !MOVIE_KEY.test(doc?.scope || '')) errors.push('scope must be "*", a show, an episode key or a movie key');
  if (!doc?.settings || typeof doc.settings !== 'object') errors.push('settings are required');
  return errors;
}

/** Normalise list settings through the same rules the extension applies. */
export function normalizeList(doc) {
  const r = resolveProfile(doc.settings);
  return {
    ...doc,
    settings: { preset: r.preset, thresholds: r.thresholds, actions: r.actions, ai: r.ai, languageMode: r.languageMode },
    overrides: { include: doc.overrides?.include || [], exclude: doc.overrides?.exclude || [] },
  };
}

// ---- index -----------------------------------------------------------------------------

/**
 * @param {{ shows: Record<string, object>, episodes: object[], lists: object[] }} catalog
 *   shows keyed by show slug; episodes and movies as parsed files; lists as parsed files
 */
export function buildIndex({ shows = {}, episodes = [], lists = [] }, generated = new Date().toISOString()) {
  const index = { version: CATALOG_VERSION, generated, counts: {}, titles: {}, aliases: {}, platforms: {}, lists: [] };
  let segmentCount = 0;
  for (const ep of [...episodes].sort((a, b) => a.key.localeCompare(b.key))) {
    const m = EPISODE_KEY.exec(ep.key);
    const platforms = Object.entries(ep.platforms).map(([name, p]) => ({ name, synced: synced(p) }));
    const summary = {
      name: ep.name || null,
      path: pathForKey(ep.key),
      segments: ep.segments?.length || 0,
      categories: [...new Set((ep.segments || []).map((s) => s.category))],
      platforms: platforms.map((p) => p.name),
      unsynced: platforms.filter((p) => !p.synced).map((p) => p.name),
    };
    segmentCount += summary.segments;
    if (m) {
      const showSlug = m[1];
      const show = shows[showSlug] || {};
      const t = (index.titles[showSlug] ||= { type: 'show', name: show.name || ep.series, year: show.year ?? null, ids: show.ids || {}, episodes: {} });
      t.episodes[`s${m[2]}e${m[3]}`] = summary;
    } else {
      index.titles[ep.key] = { type: 'movie', name: ep.name, year: ep.year ?? null, ids: ep.ids || {}, ...summary };
    }
    for (const [name, p] of Object.entries(ep.platforms)) index.platforms[`${name}:${p.id}`] = ep.key;
  }
  // Names differ between services ("Game of Thrones" vs "Game Of Thrones (HBO)"):
  // every alias and every movie title without its year points at the key.
  for (const [showSlug, show] of Object.entries(shows)) {
    for (const alias of [show.name, ...(show.aliases || [])]) {
      const a = slug(alias);
      if (a && a !== showSlug) index.aliases[a] = showSlug;
    }
  }
  const bare = {};
  for (const [key, t] of Object.entries(index.titles)) {
    if (t.type !== 'movie') continue;
    const name = slug(t.name);
    if (name !== key) (bare[name] ||= []).push(key);
    for (const alias of t.aliases || []) index.aliases[slug(alias)] = key;
  }
  for (const [name, keys] of Object.entries(bare)) if (keys.length === 1 && !index.titles[name]) index.aliases[name] = keys[0];

  for (const l of [...lists].sort((a, b) => a.id.localeCompare(b.id))) {
    index.lists.push({ id: l.id, name: l.name, description: l.description || '', author: l.author || null, scope: l.scope, preset: l.settings?.preset || 'custom', path: `lists/${l.id}.json` });
  }
  index.counts = {
    shows: Object.values(index.titles).filter((t) => t.type === 'show').length,
    movies: Object.values(index.titles).filter((t) => t.type === 'movie').length,
    episodes: episodes.length,
    segments: segmentCount,
    lists: lists.length,
  };
  return index;
}

/**
 * Find the catalog entry for what is playing.
 * @returns {{ key:string, path:string, via:'platform'|'title'|'alias' } | null}
 */
export function lookup(index, { platform, platformId, canonicalKey: ck }) {
  const direct = index.platforms?.[`${platform}:${platformId}`];
  if (direct) return { key: direct, path: pathForKey(direct), via: 'platform' };
  if (!ck) return null;
  const m = EPISODE_KEY.exec(ck);
  if (m) {
    const ep = `s${m[2]}e${m[3]}`;
    for (const [showSlug, via] of [[m[1], 'title'], [index.aliases?.[m[1]], 'alias']]) {
      if (showSlug && index.titles?.[showSlug]?.episodes?.[ep]) {
        const key = `${showSlug}/${ep}`;
        return { key, path: pathForKey(key), via };
      }
    }
    return null;
  }
  if (index.titles?.[ck]?.type === 'movie') return { key: ck, path: pathForKey(ck), via: 'title' };
  const alias = index.aliases?.[ck];
  if (alias && index.titles?.[alias]) return { key: alias, path: pathForKey(alias), via: 'alias' };
  return null;
}

/**
 * Lists made for this title: the episode's (or film's) own, and its show's.
 * Lists for all titles (scope '*') are general presets, not offered per title.
 * @param {string|string[]} keys catalog key and/or canonical key of the title
 */
export function listsFor(index, keys) {
  const wanted = new Set();
  for (const key of [keys].flat()) {
    if (!key) continue;
    wanted.add(key);
    wanted.add(key.split('/')[0]);
  }
  return (index.lists || []).filter((l) => l.scope !== '*' && wanted.has(l.scope));
}

// ---- submissions ------------------------------------------------------------------------

/**
 * A submission is what the extension (or a contributor) sends:
 * { cleancut: 1,
 *   title: { platform, platformId, series?, season?, episode?, name?, year?, runtime? },
 *   sync?: number[],                 // cue starts on this platform (optional, enables auto-sync)
 *   segments: [{ start, end, category, severity, note? }] }   // times on this platform
 * or { cleancut: 1, list: { id, name, description, scope, settings, overrides } }
 */
export function parseSubmission(text) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error('could not find valid JSON in the submission');
  }
  if (doc?.cleancut !== 1) throw new Error('not a CleanCut submission (missing "cleancut": 1)');
  return doc;
}

export function submissionKey(title) {
  const key = canonicalKey(title || {});
  if (!key) throw new Error('title needs series + season + episode, or a film name (and year)');
  return key;
}

/**
 * Merge a submission into an episode (or create it). Pure: returns new objects.
 * @param {object|null} existing  current episode file, if any
 * @param {object} sub            parsed submission
 * @param {{ author?: string }} [o]
 * @returns {{ episode, key, created:boolean, added:number, addedSegments:Array, duplicates:number, platform:string,
 *             platformStatus:'reference'|'known'|'aligned'|'unsynced'|'new', alignment:object|null }}
 */
export function mergeSubmission(existing, sub, { author = null } = {}) {
  const t = sub.title || {};
  if (!PLATFORMS.includes(t.platform)) throw new Error(`title.platform must be one of ${PLATFORMS.join(', ')}`);
  if (!t.platformId) throw new Error('title.platformId is required');
  if (!Array.isArray(sub.segments) || !sub.segments.length) throw new Error('segments must be a non-empty list');
  if (sub.segments.length > 500) throw new Error('at most 500 segments per submission');
  const key = existing?.key || submissionKey(t);
  const platform = t.platform;
  const isEpisode = EPISODE_KEY.test(key);
  const subCues = Array.isArray(sub.sync) ? sub.sync.filter(Number.isFinite) : [];

  let ep = existing ? structuredClone(existing) : {
    key,
    type: isEpisode ? 'episode' : 'movie',
    ...(isEpisode ? { series: t.series, season: Number(t.season), episode: Number(t.episode) } : {}),
    name: t.name || null,
    ...(t.year ? { year: Number(t.year) } : {}),
    ...(t.runtime ? { runtime: Math.round(Number(t.runtime)) } : {}),
    timeline: platform,
    platforms: { [platform]: { id: String(t.platformId), offset: 0, speed: 1 } },
    ...(subCues.length ? { sync: { cues: fingerprint(subCues) } } : {}),
    segments: [],
  };
  if (!ep.name && t.name) ep.name = t.name;

  let platformStatus = existing ? 'known' : 'reference';
  let alignment = null;
  const entry = ep.platforms[platform];
  if (entry && entry.id !== String(t.platformId)) {
    throw new Error(`${platform} already has id ${entry.id} for ${key}; got ${t.platformId}. If both are real (regional versions), a maintainer needs to decide.`);
  }
  if (!entry || !synced(entry)) {
    // A platform we have not timed yet: try to measure its clock from subtitles.
    alignment = subCues.length && referenceCues(ep).length ? alignCues(referenceCues(ep), subCues) : null;
    ep.platforms[platform] = alignment
      ? { id: String(t.platformId), offset: alignment.offset, speed: alignment.speed }
      : { id: String(t.platformId), offset: null };
    platformStatus = alignment ? 'aligned' : entry ? 'unsynced' : 'new';
    if (!alignment && !entry) platformStatus = 'unsynced';
  }
  // Store a fingerprint if the episode has none and this platform's clock is known.
  const p = ep.platforms[platform];
  if (!ep.sync && subCues.length && synced(p)) {
    ep.sync = { cues: fingerprint(subCues.map((c) => (c - p.offset) / (p.speed || 1))) };
  }

  let added = 0;
  let duplicates = 0;
  const addedSegments = [];
  const existingOn = (seg) => segmentsFor(ep, platform).segments.filter((s) => s.category === seg.category);
  for (const [i, raw] of sub.segments.entries()) {
    // Machine-detected tags stay marked as such (viewers treat them as suggestions).
    const machine = raw?.source === 'scanner' || raw?.source === 'subtitles';
    const v = validateSegment({ ...raw, source: machine ? 'scanner' : 'community' });
    if (!v.ok) throw new Error(`segments[${i}]: ${v.error}`);
    const seg = { on: platform, start: v.segment.start, end: v.segment.end, category: v.segment.category, severity: v.segment.severity };
    if (v.segment.note) seg.note = v.segment.note;
    if (machine) {
      seg.source = 'scanner';
      seg.confidence = v.segment.confidence;
    }
    if (author) seg.by = author;
    // Same category, mostly overlapping on this platform's clock: already tagged.
    const dup = existingOn(seg).some((s) => overlapRatio(s, seg) >= 0.6);
    if (dup) {
      duplicates++;
      continue;
    }
    seg.id = segmentId(seg);
    if (ep.segments.some((s) => s.id === seg.id)) {
      duplicates++;
      continue;
    }
    ep.segments.push(seg);
    addedSegments.push(seg);
    added++;
  }
  ep.segments.sort((a, b) => a.start - b.start || a.category.localeCompare(b.category));
  return { episode: ep, key, created: !existing, added, addedSegments, duplicates, platform, platformStatus, alignment };
}

function overlapRatio(a, b) {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  return union > 0 ? inter / union : 0;
}
