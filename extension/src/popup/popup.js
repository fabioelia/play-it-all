import { ACTIONS, CATEGORIES, PRESETS, PRESET_ORDER, SEVERITIES, defaultProfile } from '../../../shared/ratings.js';
import { formatTime } from '../../../shared/identity.js';
import { CATEGORY_COLORS } from '../content/overlay.js';

const $ = (id) => document.getElementById(id);
const LEVEL = { 0: 'none', 1: 'mild', 2: 'moderate', 3: 'any' };

let settings;
let tab;
let page = null; // content-script snapshot

async function loadSettings() {
  const { settings: s } = await chrome.storage.sync.get('settings');
  settings = { enabled: true, ...(s || {}) };
  settings.profile = { ...defaultProfile(), ...(settings.profile || {}) };
}

async function saveSettings() {
  await chrome.storage.sync.set({ settings });
  // Content script re-plans on storage change; refresh our view shortly after.
  setTimeout(refreshPage, 150);
}

async function toContent(message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    return null; // no content script on this tab
  }
}

// ---- rating controls ----------------------------------------------------------

function renderPresets() {
  const box = $('presets');
  box.replaceChildren();
  for (const id of PRESET_ORDER) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(settings.profile.preset === id));
    b.textContent = id === 'unfiltered' ? 'Off' : id === 'custom' ? 'Custom' : PRESETS[id].label;
    b.title = id === 'unfiltered' ? 'Unfiltered' : id === 'custom' ? 'Pick limits per category' : `Cut to ${PRESETS[id].label}`;
    b.addEventListener('click', () => {
      if (id === 'custom' && settings.profile.preset !== 'custom') {
        settings.profile.thresholds = { ...(PRESETS[settings.profile.preset] || PRESETS['PG-13']).thresholds };
      }
      settings.profile.preset = id;
      renderPresets();
      saveSettings();
    });
    box.append(b);
  }
  renderCustom();
}

function renderCustom() {
  const box = $('custom');
  box.hidden = settings.profile.preset !== 'custom';
  if (box.hidden) return;
  box.replaceChildren();
  for (const c of CATEGORIES) {
    const row = document.createElement('label');
    row.className = 'cat-row';
    const value = settings.profile.thresholds?.[c.id] ?? 3;
    row.innerHTML = `<span></span><input type="range" min="0" max="3" step="1"><span class="lvl"></span>`;
    row.children[0].textContent = c.label;
    const input = row.children[1];
    const lvl = row.children[2];
    input.value = value;
    input.setAttribute('aria-label', `${c.label}: highest severity allowed`);
    lvl.textContent = LEVEL[value];
    input.addEventListener('input', () => {
      lvl.textContent = LEVEL[input.value];
      settings.profile.thresholds = { ...settings.profile.thresholds, [c.id]: Number(input.value) };
    });
    input.addEventListener('change', saveSettings);
    box.append(row);
  }
}

function renderActions() {
  const box = $('actions');
  box.replaceChildren();
  for (const c of CATEGORIES) {
    const label = document.createElement('label');
    label.textContent = c.label;
    const sel = document.createElement('select');
    for (const a of ACTIONS) sel.append(new Option(a, a));
    sel.value = settings.profile.actions?.[c.id] || c.defaultAction;
    sel.addEventListener('change', () => {
      settings.profile.actions = { ...settings.profile.actions, [c.id]: sel.value };
      saveSettings();
    });
    label.append(sel);
    box.append(label);
  }
  const p = settings.profile;
  $('ai-enabled').checked = p.ai?.enabled !== false;
  $('ai-conf').value = p.ai?.minConfidence ?? 0.6;
  $('ai-conf-out').textContent = `${Math.round($('ai-conf').value * 100)}%`;
  $('lang-word').checked = p.languageMode === 'word';
  $('hide-captions').checked = p.hideCaptionsWhileMuted !== false;
}

function bindAdvanced() {
  $('ai-enabled').addEventListener('change', (e) => {
    settings.profile.ai = { ...settings.profile.ai, enabled: e.target.checked };
    saveSettings();
  });
  $('ai-conf').addEventListener('input', (e) => ($('ai-conf-out').textContent = `${Math.round(e.target.value * 100)}%`));
  $('ai-conf').addEventListener('change', (e) => {
    settings.profile.ai = { ...settings.profile.ai, minConfidence: Number(e.target.value) };
    saveSettings();
  });
  $('lang-word').addEventListener('change', (e) => {
    settings.profile.languageMode = e.target.checked ? 'word' : 'line';
    saveSettings();
  });
  $('hide-captions').addEventListener('change', (e) => {
    settings.profile.hideCaptionsWhileMuted = e.target.checked;
    saveSettings();
  });
}

// ---- now playing ---------------------------------------------------------------

function renderPage() {
  const has = !!page?.supported;
  $('inject').hidden = has || !/^https?:/.test(tab?.url || '');
  $('sync-row').hidden = !page?.ident;
  $('upcoming-card').hidden = !page?.ident;
  $('lists-card').hidden = !page?.ident;
  $('tag-card').hidden = !page?.ident;
  if (!has) {
    $('now-site').textContent = 'Not on a supported player';
    $('now-title').textContent = '';
    $('now-sources').textContent = 'Open Netflix or Prime Video, or enable CleanCut on any page with a video.';
    return;
  }
  $('now-site').textContent = { netflix: 'Netflix', prime: 'Prime Video', web: new URL(tab.url).host }[page.platform] || page.platform;
  $('now-title').textContent = page.title || (page.hasVideo ? 'Identifying…' : 'Waiting for a video…');
  if (!page.ident) {
    $('now-sources').textContent = '';
    return;
  }
  const c = page.counts;
  const parts = [`${c.community} community tag${c.community === 1 ? '' : 's'}`];
  if (c.local) parts.push(`${c.local} yours`);
  parts.push(page.subtitle ? `${c.subtitles} from subtitle scan (${page.subtitle.cues} lines${page.subtitle.sdh ? ', SDH' : ''})` : 'subtitles not scanned yet');
  $('now-sources').textContent = parts.join(' · ');

  const warn = [];
  if (page.lookupError) warn.push(`Database offline (${page.lookupError}) — using cache and local tags.`);
  if (page.borrowedFrom) warn.push(`Timing borrowed from ${page.borrowedFrom.platform}; nudge Sync if cuts land early or late.`);
  if (!page.subtitle && page.platform !== 'web') warn.push('Tip: turn on English [CC] subtitles once so CleanCut can scan ahead.');
  $('now-warning').hidden = !warn.length;
  $('now-warning').textContent = warn.join(' ');
  $('offset').textContent = `${page.offset >= 0 ? '+' : ''}${page.offset.toFixed(1)}s`;
  $('list-note').textContent = page.activeList ? `using “${page.activeList.name}”` : '';

  renderUpcoming();
  renderLists();
  $('mark-state').textContent = page.markStart != null ? `Start marked at ${formatTime(page.markStart)}` : '';
}

function renderUpcoming() {
  const ol = $('upcoming');
  ol.replaceChildren();
  const disabled = new Set(page.disabled);
  const regions = page.actions;
  $('skipped').textContent = page.skipped ? `−${formatTime(page.skipped)} runtime` : '';
  if (!regions.length) {
    const li = document.createElement('li');
    li.style.display = 'block';
    li.className = 'small muted';
    const suggested = page.flagged.filter((f) => f.decision === 'suggested').length;
    li.textContent = page.flagged.length
      ? `Nothing to cut at this rating.${suggested ? ` ${suggested} low-confidence detection${suggested === 1 ? '' : 's'} shown on the timeline.` : ''}`
      : 'No tags for this title yet. Be the first: tag scenes with Alt+[ and Alt+].';
    ol.append(li);
    return;
  }
  for (const r of regions) {
    const li = document.createElement('li');
    if (disabled.has(r.key)) li.classList.add('off');
    if (r.end < page.time) li.classList.add('past');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = CATEGORY_COLORS[r.reasons[0]?.category] || '#999';
    const when = document.createElement('span');
    when.textContent = `${formatTime(r.start)}–${formatTime(r.end)}`;
    const what = document.createElement('span');
    what.textContent = `${r.action} · ${r.reasons.map((x) => `${x.category} (${SEVERITIES[x.severity]})`).join(', ')}`;
    const btn = document.createElement('button');
    btn.className = 'mini';
    btn.textContent = disabled.has(r.key) ? 'Cut' : 'Let play';
    btn.title = disabled.has(r.key) ? 'Filter this again' : 'Let this one play (this session)';
    btn.addEventListener('click', async () => {
      page = (await toContent({ type: 'toggleRegion', key: r.key })) || page;
      renderPage();
    });
    li.append(dot, when, what, btn);
    ol.append(li);
  }
}

function scopeKeys() {
  const keys = [page.titleKey, '*'];
  if (page.ident?.canonicalKey) keys.push(`ck:${page.ident.canonicalKey}`);
  return keys;
}

function renderLists() {
  const ul = $('lists');
  ul.replaceChildren();
  const active = page.activeList;
  $('active-list').hidden = !active;
  if (active) {
    $('active-list').replaceChildren(`Using “${active.name}” for ${active.scope}. `);
    const stop = document.createElement('button');
    stop.className = 'link';
    stop.textContent = 'Stop using';
    stop.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'stopList', scopeKeys: scopeKeys() });
      setTimeout(refreshPage, 150);
    });
    $('active-list').append(stop);
  }
  if (!page.profiles.length) {
    const li = document.createElement('li');
    li.className = 'small muted';
    li.textContent = page.online === false ? 'Community lists unavailable offline.' : 'No published skip lists for this title yet.';
    ul.append(li);
    return;
  }
  for (const p of page.profiles) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = p.name;
    const meta = document.createElement('div');
    meta.className = 'small muted';
    const preset = p.settings.preset === 'custom' ? 'custom' : PRESETS[p.settings.preset]?.label;
    meta.textContent = `${preset} · by ${p.author} · ${p.subscribers} using${p.titleKey || p.canonicalKey ? '' : ' · all titles'}`;
    if (p.description) meta.title = p.description;
    info.append(name, meta);
    const use = document.createElement('button');
    use.className = 'mini';
    use.textContent = active?.id === p.id ? 'Active' : 'Use';
    use.disabled = active?.id === p.id;
    use.addEventListener('click', async () => {
      const scopeKey = p.titleKey || p.canonicalKey ? (p.titleKey === page.titleKey ? page.titleKey : `ck:${page.ident.canonicalKey || p.canonicalKey}`) : '*';
      await chrome.runtime.sendMessage({ type: 'useList', profile: p, scopeKey });
      setTimeout(refreshPage, 150);
    });
    li.append(info, use);
    ul.append(li);
  }
}

async function refreshPage() {
  page = await toContent({ type: 'getState' });
  renderPage();
}

// ---- wiring --------------------------------------------------------------------------

async function main() {
  // popup.html?tab=<id> targets a specific tab (handy for testing the popup in a normal tab).
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  tab = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  await loadSettings();
  $('enabled').checked = settings.enabled !== false;
  $('enabled').addEventListener('change', (e) => {
    settings.enabled = e.target.checked;
    saveSettings();
  });
  renderPresets();
  renderActions();
  bindAdvanced();

  for (const b of document.querySelectorAll('[data-offset]')) {
    b.addEventListener('click', async () => {
      page = (await toContent({ type: 'setOffset', value: (page?.offset || 0) + Number(b.dataset.offset) })) || page;
      renderPage();
    });
  }
  $('inject').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'inject', tabId: tab.id });
    if (res?.error) $('now-sources').textContent = `Could not enable here: ${res.error}`;
    setTimeout(refreshPage, 1200);
  });
  $('mark-start').addEventListener('click', async () => {
    await toContent({ type: 'markStart' });
    refreshPage();
  });
  $('mark-end').addEventListener('click', async () => {
    await toContent({ type: 'markEnd' });
    window.close(); // the tag form opens on the player
  });
  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  const dialog = $('publish-dialog');
  $('publish').addEventListener('click', async () => {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!apiKey) {
      chrome.runtime.openOptionsPage();
      return;
    }
    $('pub-title').closest('label').hidden = !page?.ident;
    $('pub-title-name').textContent = page?.title || 'this title';
    $('pub-error').textContent = '';
    dialog.showModal();
  });
  $('pub-go').addEventListener('click', async (e) => {
    e.preventDefault();
    const name = $('pub-name').value.trim();
    if (name.length < 3) {
      $('pub-error').textContent = 'Give it a name (3+ characters).';
      return;
    }
    const forTitle = page?.ident && $('pub-title').checked;
    const res = await chrome.runtime.sendMessage({
      type: 'publishProfile',
      name,
      description: $('pub-desc').value.trim(),
      title: forTitle ? { ...page.ident.meta, platform: page.ident.platform, platformId: page.ident.platformId, canonicalKey: page.ident.canonicalKey } : null,
      // Segments you chose to let play this session become explicit exceptions.
      overrides: forTitle ? { exclude: page.flagged.filter((f) => page.actions.some((a) => page.disabled.includes(a.key) && a.segmentIds.includes(f.id))).map((f) => f.id).filter((id) => /^\d+$/.test(id)) } : undefined,
    });
    if (res?.error) {
      $('pub-error').textContent = res.error;
      return;
    }
    dialog.close();
    await toContent({ type: 'refresh' });
    refreshPage();
  });

  await refreshPage();
  setInterval(refreshPage, 1000);
}

main();
