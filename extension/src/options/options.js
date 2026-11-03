import { DEFAULT_API } from '../config.js';

const $ = (id) => document.getElementById(id);
const say = (id, text, ok = true) => {
  $(id).textContent = text;
  $(id).style.color = ok ? 'var(--ok)' : 'var(--bad)';
};

async function settings() {
  const { settings: s } = await chrome.storage.sync.get('settings');
  return s || {};
}

async function checkServer() {
  const s = await settings();
  const base = (s.apiBase || DEFAULT_API).replace(/\/+$/, '');
  $('api').value = base;
  try {
    const res = await fetch(`${base}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    say('api-status', `Connected to ${base}`);
  } catch (e) {
    say('api-status', `Cannot reach ${base} (${e.message}). Filtering still works with your own tags and subtitle scanning.`, false);
  }
}

async function renderAccount() {
  const { apiKey, userName } = await chrome.storage.local.get(['apiKey', 'userName']);
  $('account-none').hidden = !!apiKey;
  $('account-some').hidden = !apiKey;
  $('who').textContent = userName || 'unknown';
  const { localTags = {} } = await chrome.storage.local.get('localTags');
  const all = Object.values(localTags).flatMap((e) => e.segments);
  const unshared = all.filter((s) => !s.remoteId).length;
  $('tag-count').textContent = `${all.length} tag${all.length === 1 ? '' : 's'} across ${Object.keys(localTags).length} title${Object.keys(localTags).length === 1 ? '' : 's'}${unshared ? ` (${unshared} not shared)` : ''}.`;
}

$('api-save').addEventListener('click', async () => {
  let url;
  try {
    url = new URL($('api').value.trim());
  } catch {
    return say('api-status', 'Enter a full URL, e.g. https://cleancut.example.org', false);
  }
  const origin = `${url.origin}/*`;
  const local = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!local && !(await chrome.permissions.request({ origins: [origin] }))) {
    return say('api-status', 'Permission to contact that server was not granted.', false);
  }
  const s = await settings();
  await chrome.storage.sync.set({ settings: { ...s, apiBase: url.origin } });
  checkServer();
});

$('register').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'register', name: $('name').value.trim() });
  if (res?.error) return say('account-status', res.error, false);
  say('account-status', `Welcome, ${res.name}!`);
  renderAccount();
});

$('key-save').addEventListener('click', async () => {
  const key = $('key').value.trim();
  const s = await settings();
  try {
    const res = await fetch(`${(s.apiBase || DEFAULT_API).replace(/\/+$/, '')}/v1/me`, { headers: { Authorization: `Bearer ${key}` } });
    const me = await res.json();
    if (!res.ok) throw new Error(me.error);
    await chrome.storage.local.set({ apiKey: key, userName: me.name });
    say('account-status', `Signed in as ${me.name}`);
    renderAccount();
  } catch (e) {
    say('account-status', `Key rejected: ${e.message}`, false);
  }
});

$('share-all').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'shareAll' });
  if (res?.error) return say('account-status', res.error, false);
  say('account-status', `Shared ${res.uploaded} tag${res.uploaded === 1 ? '' : 's'}.`);
  renderAccount();
});

$('show-key').addEventListener('click', async () => {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  $('key-out').textContent = `${apiKey} — keep it secret; it lets anyone post as you.`;
});

$('signout').addEventListener('click', async () => {
  await chrome.storage.local.remove(['apiKey', 'userName']);
  $('key-out').textContent = '';
  renderAccount();
});

$('export').addEventListener('click', async () => {
  const { localTags = {} } = await chrome.storage.local.get('localTags');
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), localTags }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cleancut-tags.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('import-btn').addEventListener('click', () => $('import').click());
$('import').addEventListener('change', async (e) => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!data.localTags || typeof data.localTags !== 'object') throw new Error('not a CleanCut export');
    const { localTags = {} } = await chrome.storage.local.get('localTags');
    let added = 0;
    for (const [key, entry] of Object.entries(data.localTags)) {
      const cur = localTags[key] || { title: entry.title, segments: [] };
      const seen = new Set(cur.segments.map((s) => s.id));
      for (const s of entry.segments || []) if (!seen.has(s.id)) (cur.segments.push(s), added++);
      localTags[key] = cur;
    }
    await chrome.storage.local.set({ localTags });
    say('tag-status', `Imported ${added} tag${added === 1 ? '' : 's'}.`);
    renderAccount();
  } catch (err) {
    say('tag-status', `Import failed: ${err.message}`, false);
  }
});

$('clear-cache').addEventListener('click', async () => {
  await chrome.storage.local.remove('lookupCache');
  say('tag-status', 'Cache cleared.');
});

checkServer();
renderAccount();
