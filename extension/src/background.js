// Background service worker: reads the community catalog from GitHub (with an
// offline cache), keeps the viewer's own tags, manages adopted skip lists, and
// prepares GitHub submissions. There is no CleanCut server.

import { listsFor, lookup, normalizeList } from '../../shared/catalog.js';
import { analyzeCues } from '../../shared/analyzer.js';
import { detectFormat, parseSubtitles, ttmlLanguage } from '../../shared/subtitles.js';
import { titleKey } from '../../shared/identity.js';
import { validateSegment } from '../../shared/validate.js';
import { defaultProfile } from '../../shared/ratings.js';
import { CATALOG_REPO, DEFAULT_CATALOG, ISSUE_TEMPLATE, MAX_ISSUE_URL } from './config.js';

const TIMEOUT_MS = 8000;
const TTL_MS = 30 * 60 * 1000; // the catalog changes when pull requests merge: minutes, not seconds
const MAX_CACHE = 300;

async function settings() {
  const { settings: s } = await chrome.storage.sync.get('settings');
  return s || {};
}

async function catalogBase() {
  const s = await settings();
  const base = (s.catalogBase || DEFAULT_CATALOG).trim();
  return base.endsWith('/') ? base : `${base}/`;
}

async function repo() {
  return (await settings()).catalogRepo || CATALOG_REPO;
}

// The catalog cache keeps one storage key per file ('cat:' + URL) plus a small
// index of fetch times. chrome.storage.onChanged hands every change, old and
// new value, to every content script in every open streaming tab, so a write
// must carry only the file that changed, never the whole cache.
const CACHE_PREFIX = 'cat:';

async function cacheIndex() {
  const { catalogIndex = {} } = await chrome.storage.local.get('catalogIndex');
  return catalogIndex;
}

async function clearCatalogCache() {
  const index = await cacheIndex();
  await chrome.storage.local.remove(['catalogIndex', 'catalogCache', ...Object.keys(index).map((u) => CACHE_PREFIX + u)]);
}

/**
 * GET a catalog file with a local cache: fresh copies are used as-is, stale
 * ones are revalidated with ETag, and on network failure the last copy wins.
 */
async function fetchCatalog(path, { force = false } = {}) {
  const url = new URL(path, await catalogBase()).href;
  const key = CACHE_PREFIX + url;
  const { [key]: hit } = await chrome.storage.local.get(key);
  if (hit && !force && Date.now() - hit.at < TTL_MS) return { data: hit.data, online: true, cached: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-cache', headers: hit?.etag ? { 'If-None-Match': hit.etag } : {} });
    let entry;
    if (res.status === 304 && hit) {
      entry = { ...hit, at: Date.now() };
    } else if (res.status === 404) {
      return { data: null, online: true, cached: false };
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      entry = { at: Date.now(), etag: res.headers.get('etag'), data: await res.json() };
    }
    const index = await cacheIndex();
    index[url] = entry.at;
    const urls = Object.keys(index);
    const evict = urls.length > MAX_CACHE ? urls.sort((a, b) => index[a] - index[b]).slice(0, urls.length - MAX_CACHE) : [];
    for (const u of evict) delete index[u];
    if (evict.length) await chrome.storage.local.remove(evict.map((u) => CACHE_PREFIX + u));
    await chrome.storage.local.set({ [key]: entry, catalogIndex: index });
    return { data: entry.data, online: true, cached: false };
  } catch (e) {
    if (hit) return { data: hit.data, online: false, cached: true, error: e.name === 'AbortError' ? 'catalog did not respond' : e.message };
    throw new Error(e.name === 'AbortError' ? 'catalog did not respond' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function localEntry(key) {
  const { localTags = {} } = await chrome.storage.local.get('localTags');
  return localTags[key] || null;
}

/**
 * What the catalog has for the title playing. The episode file is returned
 * whole: the content script converts its tags to this service's clock,
 * measuring the clock from subtitles when the catalog does not know it yet.
 */
async function lookupTitle(title) {
  const key = titleKey(title.platform, title.platformId);
  const local = (await localEntry(key))?.segments || [];
  const out = { local, episode: null, catalogKey: null, via: null, lists: [], online: false, error: null };
  try {
    const index = await fetchCatalog('index.json');
    out.online = index.online;
    out.error = index.error || null;
    if (!index.data) throw new Error('catalog index not found');
    const hit = lookup(index.data, { platform: title.platform, platformId: title.platformId, canonicalKey: title.canonicalKey });
    if (hit) {
      out.catalogKey = hit.key;
      out.via = hit.via;
      out.episode = (await fetchCatalog(hit.path)).data;
    }
    const lists = await Promise.all(listsFor(index.data, [hit?.key, title.canonicalKey]).map((l) => fetchCatalog(l.path).then((r) => r.data, () => null)));
    out.lists = lists.filter(Boolean).map(normalizeList);
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

async function saveTag({ title, segment }) {
  const v = validateSegment({ ...segment, source: 'local' });
  if (!v.ok) return { error: v.error };
  const key = titleKey(title.platform, title.platformId);
  const seg = { ...v.segment, id: `local:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() };
  const { localTags = {} } = await chrome.storage.local.get('localTags');
  const entry = localTags[key] || { title, segments: [] };
  entry.title = { ...entry.title, ...title };
  entry.segments.push(seg);
  localTags[key] = entry;
  await chrome.storage.local.set({ localTags });
  return { segment: seg };
}

async function deleteTag({ titleKey: key, id }) {
  const { localTags = {} } = await chrome.storage.local.get('localTags');
  if (!localTags[key]) return { ok: false };
  localTags[key].segments = localTags[key].segments.filter((s) => s.id !== id);
  if (!localTags[key].segments.length) delete localTags[key];
  await chrome.storage.local.set({ localTags });
  return { ok: true };
}

// ---- sharing through GitHub --------------------------------------------------------------

function issueUrl(repoName, title, submission) {
  const params = new URLSearchParams({ template: ISSUE_TEMPLATE, title: `[catalog] ${title}` });
  if (submission) params.set('submission', JSON.stringify(submission, null, 1));
  return `https://github.com/${repoName}/issues/new?${params}`;
}

/**
 * Turn a submission into a GitHub link. Long ones shed subtitle timing first
 * (nice to have), then fall back to the clipboard.
 */
async function shareLink(submission, label) {
  const r = await repo();
  let sub = submission;
  let url = issueUrl(r, label, sub);
  for (const keep of [200, 80, 0]) {
    if (url.length <= MAX_ISSUE_URL || !sub.sync) break;
    sub = { ...sub, sync: keep ? sub.sync.filter((_, i) => i % Math.ceil(sub.sync.length / keep) === 0) : undefined };
    if (!keep) delete sub.sync;
    url = issueUrl(r, label, sub);
  }
  if (url.length <= MAX_ISSUE_URL) return { url, prefilled: true, json: JSON.stringify(sub, null, 1) };
  return { url: issueUrl(r, label, null), prefilled: false, json: JSON.stringify(submission, null, 1) };
}

/** Build the GitHub issue for this title's unshared tags. */
async function shareTags({ title, sync, label }) {
  const key = titleKey(title.platform, title.platformId);
  const entry = await localEntry(key);
  const pending = (entry?.segments || []).filter((s) => !s.sharedAt);
  if (!pending.length) return { error: 'no unshared tags for this title' };
  const submission = {
    cleancut: 1,
    title,
    ...(sync?.length ? { sync } : {}),
    segments: pending.map(({ start, end, category, severity, note }) => ({ start, end, category, severity, ...(note ? { note } : {}) })),
  };
  return { ...(await shareLink(submission, label)), count: pending.length, ids: pending.map((s) => s.id) };
}

async function markShared({ titleKey: key, ids }) {
  const { localTags = {} } = await chrome.storage.local.get('localTags');
  for (const s of localTags[key]?.segments || []) if (ids.includes(s.id)) s.sharedAt = Date.now();
  await chrome.storage.local.set({ localTags });
  return { ok: true };
}

async function shareList({ name, description, scope, overrides }) {
  const s = await settings();
  const profile = { ...defaultProfile(), ...(s.profile || {}) };
  const id = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  if (id.length < 3) return { error: 'give the list a longer name' };
  const list = { id, name, description, scope, settings: { preset: profile.preset, thresholds: profile.thresholds, actions: profile.actions }, overrides };
  return shareLink({ cleancut: 1, list }, `Skip list: ${name}`);
}

// ---- adopted skip lists -----------------------------------------------------------------

async function useList({ profile, scopeKey }) {
  const { activeLists = {} } = await chrome.storage.local.get('activeLists');
  activeLists[scopeKey] = {
    id: profile.id,
    name: profile.name,
    author: profile.author,
    settings: profile.settings,
    overrides: profile.overrides,
    scope: scopeKey === '*' ? 'everything' : 'this title',
  };
  await chrome.storage.local.set({ activeLists });
  return { ok: true };
}

async function stopList({ scopeKeys }) {
  const { activeLists = {} } = await chrome.storage.local.get('activeLists');
  for (const k of scopeKeys) delete activeLists[k];
  await chrome.storage.local.set({ activeLists });
  return { ok: true };
}

/**
 * Parse and scan a subtitle track here, in the extension's own process, so
 * none of it runs on the streaming page's main thread. Returns only what the
 * page needs: cue start times (for syncing) and the detected segments.
 */
function scanSubtitles({ text, cues: given, languageMode }) {
  let cues = given;
  if (typeof text === 'string') {
    if (detectFormat(text) === 'ttml') {
      const lang = ttmlLanguage(text);
      if (lang && !/^en\b/i.test(lang)) return { ok: false, reason: `not English (${lang})` };
    }
    cues = parseSubtitles(text);
  }
  if (!Array.isArray(cues) || cues.length < 5) return { ok: false, reason: 'too few subtitle lines' };
  return {
    ok: true,
    count: cues.length,
    cueStarts: cues.map((c) => Math.round(c.start * 1000) / 1000),
    sdh: cues.some((c) => /\[[^\]]+\]/.test(c.text)),
    segments: analyzeCues(cues, { languageMode }),
  };
}

const handlers = {
  scanSubtitles: (m) => scanSubtitles(m),
  lookup: (m) => lookupTitle(m.title),
  saveTag: (m) => saveTag(m),
  deleteTag: (m) => deleteTag(m),
  shareTags: (m) => shareTags(m),
  markShared: (m) => markShared(m),
  shareList: (m) => shareList(m),
  useList: (m) => useList(m),
  stopList: (m) => stopList(m),
  catalogStatus: async () => {
    const index = await fetchCatalog('index.json', { force: true });
    return { base: await catalogBase(), counts: index.data?.counts || null, generated: index.data?.generated || null, online: index.online, error: index.error || null };
  },
  clearCache: async () => {
    await clearCatalogCache();
    return { ok: true };
  },
  status: async (m, sender) => {
    const tabId = sender.tab?.id;
    if (tabId == null) return {};
    await chrome.action.setBadgeBackgroundColor({ tabId, color: m.enabled ? '#4f7cff' : '#777' });
    await chrome.action.setBadgeText({ tabId, text: m.enabled ? (m.count ? String(m.count) : '') : 'off' });
    return {};
  },
  inject: async (m) => {
    await chrome.scripting.executeScript({ target: { tabId: m.tabId }, files: ['content.js'] });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (e) => sendResponse({ error: e.message || String(e) }));
  return true;
});

// ---- what runs in streaming pages ------------------------------------------------
//
// Registered here rather than in the manifest so each part can be switched
// off (Options → Troubleshooting) to find what slows a page down:
//   hook     page-hook.js, page world, document_start: notices subtitle tracks
//   content  content.js, document_idle: skipping, muting, overlay, tagging

const SCRIPTS = {
  hook: { id: 'cleancut-hook', js: ['page-hook.js'], runAt: 'document_start', world: 'MAIN' },
  content: { id: 'cleancut-content', js: ['content.js'], runAt: 'document_idle', world: 'ISOLATED' },
};
// Each part is registered twice: for the streaming sites' own pages (top frame
// only), and for embedded players (YouTube, Vimeo) in any frame of any site.
const FRAMES_SUFFIX = '-frames';
const registrations = (s) => [
  { ...s, matches: __CLEANCUT_MATCHES__, persistAcrossSessions: true },
  ...(__CLEANCUT_FRAME_MATCHES__.length ? [{ ...s, id: s.id + FRAMES_SUFFIX, matches: __CLEANCUT_FRAME_MATCHES__, allFrames: true, persistAcrossSessions: true }] : []),
];
const OUR_IDS = Object.values(SCRIPTS).flatMap((s) => registrations(s).map((r) => r.id));

/**
 * Register the parts that are switched on. The registration persists across
 * sessions, so at browser start (while tabs are being restored) nothing is
 * unregistered and reloaded unless it differs; install, update and setParts
 * always re-register.
 */
async function syncContentScripts({ force = true } = {}) {
  const { parts = {} } = await chrome.storage.local.get('parts');
  const wanted = Object.entries(SCRIPTS).filter(([name]) => parts[name] !== false).flatMap(([, s]) => registrations(s));
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ours = existing.map((s) => s.id).filter((id) => OUR_IDS.includes(id));
  if (!force && ours.length === wanted.length && wanted.every((s) => ours.includes(s.id))) return { registered: ours };
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });
  if (wanted.length) await chrome.scripting.registerContentScripts(wanted);
  return { registered: wanted.map((s) => s.id) };
}

handlers.setParts = async (m) => {
  const { parts = {} } = await chrome.storage.local.get('parts');
  await chrome.storage.local.set({ parts: { ...parts, ...m.parts } });
  return syncContentScripts();
};
handlers.getParts = async () => {
  const { parts = {} } = await chrome.storage.local.get('parts');
  const registered = (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id);
  return { hook: parts.hook !== false, content: parts.content !== false, registered };
};

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await syncContentScripts();
  await chrome.storage.local.remove('catalogCache'); // the old single-key cache (before per-file keys)
  const s = await settings();
  if (!s.profile) await chrome.storage.sync.set({ settings: { enabled: true, ...s, profile: defaultProfile() } });
  if (reason === 'install') chrome.runtime.openOptionsPage?.();
});
chrome.runtime.onStartup.addListener(() => syncContentScripts({ force: false }));
