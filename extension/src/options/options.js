import { CATALOG_REPO, DEFAULT_CATALOG } from '../config.js';

const $ = (id) => document.getElementById(id);
/** A status line: a coloured dot (ok, warn or bad) and a sentence. */
const say = (id, text, ok = true) => {
  $(id).textContent = text;
  $(id).dataset.tone = ok === true ? 'ok' : ok || 'bad';
};
const plural = (n, word, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

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
  $('catalog-advanced').open ||= !!(s.catalogBase || s.catalogRepo);
  const st = await chrome.runtime.sendMessage({ type: 'catalogStatus' });
  const counts = $('catalog-counts');
  counts.hidden = !st?.counts;
  if (st?.counts) {
    const c = st.counts;
    const when = st.generated ? new Date(st.generated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown';
    say('catalog-status', st.online
      ? `Connected. Catalog updated ${when}.`
      : `Offline, using the saved copy from ${when}.`, st.online || 'warn');
    counts.replaceChildren(...[
      ['Shows', c.shows], ['Films', c.movies], ['Titles with flags', c.episodes], ['Flags', c.segments], ['Skip lists', c.lists],
    ].map(([label, n]) => {
      const div = document.createElement('div');
      div.append(Object.assign(document.createElement('dt'), { textContent: label }), Object.assign(document.createElement('dd'), { textContent: (n ?? 0).toLocaleString() }));
      return div;
    }));
  } else {
    say('catalog-status', `Can’t read the catalog at ${st?.base || 'that address'}${st?.error ? ` (${st.error})` : ''}. Cutting still works with your own flags and the subtitle scan.`, false);
  }
}

async function renderTags() {
  const { localTags = {} } = await chrome.storage.local.get('localTags');
  const all = Object.values(localTags).flatMap((e) => e.segments);
  const unshared = all.filter((s) => !s.sharedAt).length;
  const titles = Object.keys(localTags).length;
  $('tag-count').textContent = all.length ? `${plural(all.length, 'flag')} across ${plural(titles, 'title')}` : 'No flags yet';
  $('tag-unshared').textContent = unshared
    ? `${plural(unshared, 'flag')} not shared yet. Share them from the CleanCut menu while the title is playing.`
    : all.length ? 'All shared. Thank you!' : 'Scenes you flag while watching show up here.';
}

$('base-save').addEventListener('click', async () => {
  let url;
  try {
    url = new URL($('base').value.trim());
  } catch {
    return say('catalog-form-status', 'Enter a full address, e.g. https://raw.githubusercontent.com/owner/repo/main/catalog/', false);
  }
  const local = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  const github = url.hostname === 'raw.githubusercontent.com';
  if (!local && !github && !(await chrome.permissions.request({ origins: [`${url.origin}/*`] }))) {
    return say('catalog-form-status', 'Permission to read from that address was not granted.', false);
  }
  await patchSettings({ catalogBase: url.href.endsWith('/') ? url.href : `${url.href}/` });
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  say('catalog-form-status', 'Saved. CleanCut now reads from this address.');
  showCatalog();
});
$('base-reset').addEventListener('click', async () => {
  await patchSettings({ catalogBase: undefined });
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  say('catalog-form-status', 'Back to the public catalog.');
  showCatalog();
});
$('repo-save').addEventListener('click', async () => {
  const repo = $('repo').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return say('catalog-form-status', 'Use the form owner/repo.', false);
  await patchSettings({ catalogRepo: repo });
  say('catalog-form-status', `Saved. Shares now open an issue on ${repo}.`);
  showCatalog();
});
$('refresh').addEventListener('click', async () => {
  say('catalog-status', 'Checking the catalog…', 'warn');
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  showCatalog();
});

$('export').addEventListener('click', async () => {
  const { localTags = {} } = await chrome.storage.local.get('localTags');
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), localTags }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cleancut-flags.json';
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
    say('tag-status', `Imported ${plural(added, 'flag')}.`);
    renderTags();
  } catch (err) {
    say('tag-status', `Couldn’t import that file: ${err.message}.`, false);
  }
});

async function showParts() {
  const p = await chrome.runtime.sendMessage({ type: 'getParts' });
  $('part-hook').checked = p.hook;
  $('part-content').checked = p.content;
  const names = { 'cleancut-hook': 'network hook', 'cleancut-content': 'on-page script' };
  // Each part is registered twice: for the sites' own pages, and for players embedded in other sites (…-frames).
  const parts = [...new Set(p.registered.map((id) => id.replace(/-frames$/, '')))].map((id) => names[id] || id);
  const embedded = p.registered.some((id) => id.endsWith('-frames')) ? ', also in embedded players' : '';
  say('parts-status', `Running in pages: ${parts.length ? `${parts.join(', ')}${embedded}` : 'nothing'}. Reload the streaming tab after a change.`, parts.length ? true : 'warn');
}
for (const [id, part] of [['part-hook', 'hook'], ['part-content', 'content']]) {
  $(id).addEventListener('change', async (e) => {
    const res = await chrome.runtime.sendMessage({ type: 'setParts', parts: { [part]: e.target.checked } });
    if (res?.error) say('parts-status', res.error, false);
    else showParts();
  });
}

// ---- listening ahead ---------------------------------------------------------------

async function listenPrefs(patch) {
  const { listening = {} } = await chrome.storage.local.get('listening');
  if (patch) await chrome.storage.local.set({ listening: { ...listening, ...patch } });
  return { ...listening, ...(patch || {}) };
}

async function showListening() {
  const st = await chrome.runtime.sendMessage({ type: 'listenStatus' }).catch(() => null);
  if (!st?.supported) {
    say('listen-model', 'This browser can’t run the speech model (it needs Chrome’s offscreen documents).', 'warn');
    $('listen-delete').hidden = true;
    return;
  }
  const size = `${Math.round(st.bytes / 1e6)} MB`;
  const downloading = st.download?.state === 'downloading';
  if (st.model.ready) say('listen-model', `Speech model: ${st.name}, ${size}, downloaded.${st.prefs?.on ? ' Listening is on.' : ' Listening is off.'}`);
  else if (downloading) say('listen-model', `Speech model: ${st.name}, downloading ${Math.floor(st.download.fraction * 100)}% of ${size}.`, 'warn');
  else say('listen-model', `Speech model: ${st.name}, ${size}, not downloaded.`, 'warn');
  $('listen-delete').hidden = !st.model.ready && !st.model.bytes;
  $('listen-source').replaceChildren('From Hugging Face, ', Object.assign(document.createElement('a'), { href: st.page, target: '_blank', rel: 'noopener', textContent: `${st.page.split('/').slice(3, 5).join('/')} at ${st.revision}` }), `, ${st.license}. Every file is checked against its pinned checksum.`);
  const prefs = st.prefs || {};
  $('listen-always').checked = !!prefs.always;
  const off = Object.entries(prefs.sites || {}).filter(([, v]) => v === false).map(([h]) => h);
  $('listen-sites').hidden = !off.length;
  $('listen-site-list').replaceChildren(...off.map((host) => {
    const li = document.createElement('li');
    const b = Object.assign(document.createElement('button'), { className: 'link', textContent: 'Turn back on' });
    b.addEventListener('click', async () => {
      const p = await listenPrefs();
      const sites = { ...(p.sites || {}) };
      delete sites[host];
      await listenPrefs({ sites });
      showListening();
    });
    li.append(Object.assign(document.createElement('span'), { textContent: host }), b);
    return li;
  }));
  if (downloading) setTimeout(showListening, 1000);
}
$('listen-delete').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'listenDelete' });
  showListening();
});
$('listen-always').addEventListener('change', async (e) => {
  await listenPrefs({ always: e.target.checked });
});

showCatalog();
renderTags();
showParts();
showListening();
