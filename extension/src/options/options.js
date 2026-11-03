import { CATALOG_REPO, DEFAULT_CATALOG } from '../config.js';

const $ = (id) => document.getElementById(id);
const say = (id, text, ok = true) => {
  $(id).textContent = text;
  $(id).style.color = ok ? 'var(--ok)' : 'var(--bad)';
};

async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return settings || {};
}
async function patchSettings(patch) {
  await chrome.storage.sync.set({ settings: { ...(await getSettings()), ...patch } });
}

async function showCatalog() {
  const s = await getSettings();
  $('base').value = s.catalogBase || DEFAULT_CATALOG;
  $('repo').value = s.catalogRepo || CATALOG_REPO;
  $('contributing').href = `https://github.com/${s.catalogRepo || CATALOG_REPO}/blob/main/CONTRIBUTING.md`;
  const st = await chrome.runtime.sendMessage({ type: 'catalogStatus' });
  if (st?.counts) {
    const c = st.counts;
    const when = st.generated ? new Date(st.generated).toLocaleString() : 'unknown';
    say('catalog-status', `${st.online ? 'Connected' : 'Offline (using cached copy)'}: ${c.shows} shows, ${c.movies} films, ${c.episodes} episodes and films with ${c.segments} tags, ${c.lists} skip lists. Updated ${when}.`, st.online);
  } else {
    say('catalog-status', `Cannot read the catalog at ${st?.base || 'that address'}${st?.error ? ` (${st.error})` : ''}. Filtering still works with your own tags and subtitle scanning.`, false);
  }
}

async function renderTags() {
  const { localTags = {} } = await chrome.storage.local.get('localTags');
  const all = Object.values(localTags).flatMap((e) => e.segments);
  const unshared = all.filter((s) => !s.sharedAt).length;
  const titles = Object.keys(localTags).length;
  $('tag-count').textContent = `${all.length} tag${all.length === 1 ? '' : 's'} across ${titles} title${titles === 1 ? '' : 's'}${unshared ? ` (${unshared} not shared yet: share them from the popup while the title is open)` : ''}.`;
}

$('base-save').addEventListener('click', async () => {
  let url;
  try {
    url = new URL($('base').value.trim());
  } catch {
    return say('catalog-status', 'Enter a full address, e.g. https://raw.githubusercontent.com/owner/repo/main/catalog/', false);
  }
  const local = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  const github = url.hostname === 'raw.githubusercontent.com';
  if (!local && !github && !(await chrome.permissions.request({ origins: [`${url.origin}/*`] }))) {
    return say('catalog-status', 'Permission to read from that address was not granted.', false);
  }
  await patchSettings({ catalogBase: url.href.endsWith('/') ? url.href : `${url.href}/` });
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  showCatalog();
});
$('base-reset').addEventListener('click', async () => {
  await patchSettings({ catalogBase: undefined });
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  showCatalog();
});
$('repo-save').addEventListener('click', async () => {
  const repo = $('repo').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return say('catalog-status', 'Use the form owner/repo.', false);
  await patchSettings({ catalogRepo: repo });
  showCatalog();
});
$('refresh').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  showCatalog();
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
    renderTags();
  } catch (err) {
    say('tag-status', `Import failed: ${err.message}`, false);
  }
});

async function showParts() {
  const p = await chrome.runtime.sendMessage({ type: 'getParts' });
  $('part-hook').checked = p.hook;
  $('part-content').checked = p.content;
  say('parts-status', `Running in pages: ${p.registered.length ? p.registered.map((id) => id.replace('cleancut-', '')).join(', ') : 'nothing'}. Reload the streaming tab after a change.`);
}
for (const [id, part] of [['part-hook', 'hook'], ['part-content', 'content']]) {
  $(id).addEventListener('change', async (e) => {
    const res = await chrome.runtime.sendMessage({ type: 'setParts', parts: { [part]: e.target.checked } });
    if (res?.error) say('parts-status', res.error, false);
    else showParts();
  });
}

showCatalog();
renderTags();
showParts();
