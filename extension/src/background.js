// Background service worker: talks to the CleanCut API, keeps an offline
// cache and the viewer's own tags, and manages subscribed skip lists.

import { validateSegment } from '../../shared/validate.js';
import { titleKey } from '../../shared/identity.js';
import { defaultProfile } from '../../shared/ratings.js';

import { DEFAULT_API } from './config.js';
const TIMEOUT_MS = 6000;

async function config() {
  const [{ settings }, { apiKey }] = await Promise.all([chrome.storage.sync.get('settings'), chrome.storage.local.get('apiKey')]);
  return { apiBase: (settings?.apiBase || DEFAULT_API).replace(/\/+$/, ''), apiKey: apiKey || null, settings: settings || {} };
}

async function api(path, { method = 'GET', body, auth = false } = {}) {
  const { apiBase, apiKey } = await config();
  if (auth && !apiKey) throw new Error('no account — set one up in CleanCut options');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(apiBase + path, {
      method,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'server did not respond' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

const titleBody = (t) => ({
  platform: t.platform,
  platformId: t.platformId,
  series: t.series,
  season: t.season,
  episode: t.episode,
  name: t.name,
  duration: t.duration,
  canonicalKey: t.canonicalKey,
});

async function getLocal(key) {
  const { localTags = {} } = await chrome.storage.local.get('localTags');
  return localTags[key]?.segments || [];
}

async function lookup(title) {
  const key = titleKey(title.platform, title.platformId);
  const local = await getLocal(key);
  const params = new URLSearchParams({ platform: title.platform, id: title.platformId });
  if (title.canonicalKey) params.set('canonical', title.canonicalKey);
  let data;
  let online = false;
  let error = null;
  const { lookupCache = {} } = await chrome.storage.local.get('lookupCache');
  try {
    data = await api(`/v1/lookup?${params}`);
    online = true;
    lookupCache[key] = { at: Date.now(), data };
    // Keep the cache bounded.
    const keys = Object.keys(lookupCache);
    if (keys.length > 200) {
      keys.sort((a, b) => lookupCache[a].at - lookupCache[b].at);
      for (const k of keys.slice(0, keys.length - 200)) delete lookupCache[k];
    }
    await chrome.storage.local.set({ lookupCache });
  } catch (e) {
    error = e.message;
    data = lookupCache[key]?.data || null;
  }
  // Tags you shared come back from the server too; show each only once.
  const remote = data?.segments || [];
  const remoteIds = new Set(remote.map((s) => s.id));
  return {
    remote,
    local: local.filter((s) => !s.remoteId || !remoteIds.has(s.remoteId)),
    profiles: data?.profiles || [],
    borrowedFrom: data?.borrowedFrom || null,
    online,
    cached: !online && !!data,
    error,
  };
}

async function saveTag({ title, segment, share }) {
  const v = validateSegment({ ...segment, source: 'local' });
  if (!v.ok) return { error: v.error };
  const key = titleKey(title.platform, title.platformId);
  const seg = { ...v.segment, id: `local:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() };
  let shared = false;
  let shareError = null;
  if (share) {
    try {
      const res = await api('/v1/segments', { method: 'POST', auth: true, body: { title: titleBody(title), segments: [{ ...seg, source: 'community' }] } });
      seg.remoteId = res.ids[0];
      shared = true;
    } catch (e) {
      shareError = e.message;
    }
  }
  const { localTags = {} } = await chrome.storage.local.get('localTags');
  const entry = localTags[key] || { title: titleBody(title), segments: [] };
  entry.title = { ...entry.title, ...titleBody(title) };
  entry.segments.push(seg);
  localTags[key] = entry;
  await chrome.storage.local.set({ localTags });
  return { segment: seg, shared, shareError };
}

/** Upload local tags that were never shared (e.g. tagged before signing up). */
async function shareAll() {
  const { localTags = {} } = await chrome.storage.local.get('localTags');
  let uploaded = 0;
  for (const entry of Object.values(localTags)) {
    const pending = entry.segments.filter((s) => !s.remoteId);
    if (!pending.length) continue;
    const res = await api('/v1/segments', { method: 'POST', auth: true, body: { title: entry.title, segments: pending.map((s) => ({ ...s, source: 'community' })) } });
    pending.forEach((s, i) => (s.remoteId = res.ids[i]));
    uploaded += pending.length;
  }
  await chrome.storage.local.set({ localTags });
  return { uploaded };
}

async function publishProfile({ name, description, title, overrides }) {
  const { settings } = await config();
  const profile = { ...defaultProfile(), ...(settings.profile || {}) };
  const body = { name, description, settings: profile, overrides };
  if (title) body.title = titleBody(title);
  return api('/v1/profiles', { method: 'POST', auth: true, body });
}

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
  api(`/v1/profiles/${encodeURIComponent(profile.id)}/subscribe`, { method: 'POST' }).catch(() => {});
  return { ok: true };
}

async function stopList({ scopeKeys }) {
  const { activeLists = {} } = await chrome.storage.local.get('activeLists');
  for (const k of scopeKeys) delete activeLists[k];
  await chrome.storage.local.set({ activeLists });
  return { ok: true };
}

async function register({ name }) {
  const res = await api('/v1/users', { method: 'POST', body: { name } });
  await chrome.storage.local.set({ apiKey: res.apiKey, userName: res.name });
  return { name: res.name };
}

const handlers = {
  lookup: (m) => lookup(m.title),
  saveTag: (m) => saveTag(m),
  shareAll: () => shareAll(),
  publishProfile: (m) => publishProfile(m),
  useList: (m) => useList(m),
  stopList: (m) => stopList(m),
  register: (m) => register(m),
  vote: (m) => api(`/v1/segments/${encodeURIComponent(m.id)}/vote`, { method: 'POST', auth: true, body: { value: m.value } }),
  searchProfiles: (m) => api(`/v1/profiles?q=${encodeURIComponent(m.q || '')}`),
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

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { settings } = await chrome.storage.sync.get('settings');
  if (!settings) await chrome.storage.sync.set({ settings: { enabled: true, apiBase: DEFAULT_API, profile: defaultProfile() } });
  if (reason === 'install') chrome.runtime.openOptionsPage?.();
});
