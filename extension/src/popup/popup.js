import { ACTIONS, ACTION_LABELS, CATEGORIES, PRESETS, PRESET_ORDER, SEVERITIES, defaultProfile } from '../../../shared/ratings.js';
import { formatTime } from '../../../shared/identity.js';
import { platformName } from '../../../shared/platforms.js';
// The category colours and note icons are the on-player UI's, so both read the same.
import { CATEGORY_COLORS, NOTE_ICONS as ICONS } from '../content/overlay.js';

const $ = (id) => document.getElementById(id);
const LEVEL = { 0: 'None', 1: 'Mild', 2: 'Moderate', 3: 'Any' };
const SITES = { netflix: 'Netflix', prime: 'Prime Video' };
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
const cap = (s = '') => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const signed = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}s`;

let settings;
let tab;
let page = null; // content-script snapshot
const drawn = {}; // last rendered signature per list, so the 1 s refresh keeps focus and hover
let syncShown = false; // Timing opens by itself once, when the cuts look out of sync

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

/** Replace a list's children only when what it shows has changed. */
function redraw(name, signature, draw) {
  const sig = JSON.stringify(signature);
  if (drawn[name] === sig) return;
  drawn[name] = sig;
  draw();
}

// ---- rating controls ----------------------------------------------------------

const presetLabel = (id) => (id === 'custom' ? 'Custom' : PRESETS[id]?.label || 'Custom');

function choosePreset(id) {
  if (id === 'custom' && settings.profile.preset !== 'custom') {
    settings.profile.thresholds = { ...(PRESETS[settings.profile.preset] || PRESETS['PG-13']).thresholds };
  }
  settings.profile.preset = id;
  renderPresets();
  if (page) renderPage();
  saveSettings();
}

function renderPresets() {
  const box = $('presets');
  const hadFocus = box.contains(document.activeElement);
  box.replaceChildren();
  for (const id of PRESET_ORDER) {
    const b = document.createElement('button');
    const on = settings.profile.preset === id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
    b.dataset.preset = id;
    b.textContent = presetLabel(id);
    b.title = id === 'unfiltered' ? 'Nothing is cut' : id === 'custom' ? 'Set a limit for each category' : `Cut to ${PRESETS[id].label}`;
    b.addEventListener('click', () => choosePreset(id));
    box.append(b);
  }
  if (hadFocus) box.querySelector('[aria-checked=true]')?.focus();
  renderCustom();
}

// Arrow keys move through the rating like a radio group.
function bindPresetKeys() {
  $('presets').addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = PRESET_ORDER.indexOf(settings.profile.preset);
    choosePreset(PRESET_ORDER[(i + step + PRESET_ORDER.length) % PRESET_ORDER.length]);
  });
}

function renderCustom() {
  const box = $('custom');
  box.hidden = settings.profile.preset !== 'custom';
  if (box.hidden) return;
  box.replaceChildren();
  const help = document.createElement('p');
  help.className = 'help';
  help.textContent = 'The most each category may show. Anything stronger is cut.';
  box.append(help);
  for (const c of CATEGORIES) {
    const row = document.createElement('label');
    row.className = 'cat-row';
    const value = settings.profile.thresholds?.[c.id] ?? 3;
    row.innerHTML = '<span></span><input type="range" min="0" max="3" step="1"><span class="lvl"></span>';
    row.children[0].textContent = c.label;
    const input = row.children[1];
    const lvl = row.children[2];
    input.value = value;
    input.setAttribute('aria-label', `${c.label}: most allowed`);
    input.setAttribute('aria-valuetext', LEVEL[value]);
    lvl.textContent = LEVEL[value];
    input.addEventListener('input', () => {
      lvl.textContent = LEVEL[input.value];
      input.setAttribute('aria-valuetext', LEVEL[input.value]);
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
    for (const a of ACTIONS) sel.append(new Option(cap(ACTION_LABELS[a]), a));
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

// ---- listening ahead -------------------------------------------------------------
// Off until the viewer turns it on. The first time, the model download is
// explained (size, source, that audio stays on this computer) and only starts
// on "Download and turn on"; background.js turns listening on when it is done,
// even if this popup has closed by then.

let listen = null; // background listenStatus: { supported, model, download, prefs, name, bytes, page }
let consentOpen = false;
const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
const HEARD_STATES = new Set(['listening', 'paused', 'waiting', 'loading']);
const LISTEN_TEXT = {
  listening: (l) => (l.heardTo != null ? `Listening ahead · transcribed to ${formatTime(l.heardTo)}` : 'Listening ahead'),
  paused: (l) => `Listening ahead · paused${l.heardTo != null ? `, transcribed to ${formatTime(l.heardTo)}` : ''}`,
  waiting: () => 'Listening ahead · waiting for the player to buffer audio',
  loading: () => 'Listening ahead · starting the speech model',
  reload: () => 'Reload the page to start listening here',
  encrypted: () => 'Encrypted here, can’t listen',
  captions: () => 'This video has captions, so CleanCut reads those instead',
  'site-off': () => 'Off on this site',
  'no-model': () => 'The speech model is missing. Turn this off and on again to download it.',
  unsupported: (l) => `Can’t listen here${l.detail ? `: ${l.detail}` : ''}`,
  error: (l) => `Listening stopped${l.detail ? `: ${l.detail}` : ''}`,
};

async function setListenPrefs(patch) {
  const { listening = {} } = await chrome.storage.local.get('listening');
  await chrome.storage.local.set({ listening: { ...listening, ...patch } });
}

async function refreshListen() {
  listen = await chrome.runtime.sendMessage({ type: 'listenStatus' }).catch(() => null);
  renderListen();
}

function renderListen() {
  const st = listen;
  const status = (text, tone = '') => {
    $('listen-status').textContent = text;
    $('listen-status').dataset.tone = tone;
  };
  if (!st) return;
  if (!st.supported) {
    $('listen-on').disabled = true;
    $('listen-site').hidden = true;
    return status('This browser can’t run the speech model.');
  }
  const prefs = st.prefs || {};
  const downloading = st.download?.state === 'downloading';
  const l = page?.listening;
  $('listen-on').checked = !!prefs.on || downloading || consentOpen;
  $('listen-consent').hidden = !consentOpen || downloading;
  if (consentOpen) {
    $('listen-consent-text').textContent = `CleanCut needs a speech recognition model (${st.name}, ${mb(st.bytes)}), downloaded once from Hugging Face. It transcribes the audio the player has already buffered, here on this computer. Audio never leaves it.`;
  }
  $('listen-progress').hidden = !downloading;
  if (downloading) {
    const pct = Math.floor((st.download.fraction || 0) * 100);
    $('listen-bar').style.width = `${pct}%`;
    status(`Downloading model ${pct}% · ${mb(st.bytes)}`);
  } else if (prefs.error && !prefs.on) {
    status(`The model didn’t download (${prefs.error}). Turn this on to try again.`, 'bad');
  } else if (prefs.on) {
    const fn = l && LISTEN_TEXT[l.state];
    status(fn ? fn(l) : 'On: listens when a video without captions plays.', l?.state === 'encrypted' || l?.state === 'reload' ? 'warn' : l?.state === 'error' ? 'bad' : '');
  } else {
    status(consentOpen ? '' : st.model?.ready ? '' : `Mutes swearing in videos without captions. Needs a one-time ${mb(st.bytes)} download.`);
  }
  // This site on or off (only where it could listen).
  const site = l?.host;
  $('listen-site').hidden = !(prefs.on && site && l.state !== 'encrypted' && page?.platform);
  if (site) $('listen-site').textContent = l.site === false ? `Turn on for ${site}` : `Turn off for ${site}`;
  // On the hero: how far it has listened, or that the page needs a reload.
  const hero = prefs.on && l && (HEARD_STATES.has(l.state) || l.state === 'reload') ? LISTEN_TEXT[l.state](l) : '';
  $('now-listen').hidden = !hero || !page?.ident;
  $('now-listen').textContent = hero;
}

function bindListen() {
  $('listen-consent').querySelector('.listen-consent-icon').innerHTML = ICONS.info;
  $('listen-on').addEventListener('change', async (e) => {
    if (e.target.checked) {
      await refreshListen();
      if (!listen?.supported) {
        e.target.checked = false;
        return;
      }
      if (listen.model?.ready) await setListenPrefs({ on: true, error: null });
      else {
        consentOpen = true; // nothing is downloaded until the viewer says so
        renderListen();
        $('listen-download').focus();
        return;
      }
    } else {
      consentOpen = false;
      await setListenPrefs({ on: false, pending: false });
    }
    setTimeout(refreshPage, 200);
  });
  $('listen-download').addEventListener('click', async () => {
    consentOpen = false;
    const r = await chrome.runtime.sendMessage({ type: 'listenDownload' }).catch((err) => ({ error: String(err?.message || err) }));
    if (r?.error) await setListenPrefs({ error: r.error });
    refreshListen();
  });
  $('listen-cancel').addEventListener('click', () => {
    consentOpen = false;
    renderListen();
    $('listen-on').focus();
  });
  $('listen-site').addEventListener('click', async () => {
    const host = page?.listening?.host;
    if (!host) return;
    const { listening = {} } = await chrome.storage.local.get('listening');
    const sites = { ...(listening.sites || {}) };
    if (sites[host] === false) delete sites[host];
    else sites[host] = false;
    await chrome.storage.local.set({ listening: { ...listening, sites } });
    setTimeout(refreshPage, 200);
  });
}

// ---- now playing ---------------------------------------------------------------

function siteName(platform = page?.platform) {
  if (SITES[platform]) return SITES[platform];
  if (platform && platform !== 'web' && platformName(platform) !== platform) return platformName(platform);
  try {
    return new URL(tab.url).host || 'This page';
  } catch {
    return platform && platform !== 'web' ? cap(platform) : 'This page';
  }
}

function setStatus(text, tone) {
  $('now-status').hidden = !text;
  $('now-status').textContent = text || '';
  $('now-status').dataset.tone = tone || '';
}

function setHint(text) {
  $('now-hint').hidden = !text;
  $('now-hint').textContent = text || '';
}

function renderNotes(notes) {
  redraw('notes', notes, () => {
    $('now-warning').replaceChildren(...notes.map(([tone, text]) => {
      const li = document.createElement('li');
      li.className = 'note';
      li.dataset.tone = tone;
      li.innerHTML = ICONS[tone];
      li.append(Object.assign(document.createElement('span'), { textContent: text }));
      return li;
    }));
  });
  $('now-warning').hidden = !notes.length;
}

function renderPage() {
  const enabled = settings.enabled !== false;
  document.body.dataset.enabled = String(enabled);
  $('enabled-text').textContent = enabled ? 'On' : 'Off';
  const has = !!page?.supported;
  const ident = has && !!page.ident;
  document.body.dataset.view = !has ? 'unsupported' : ident ? 'playing' : page.hasVideo ? 'identifying' : 'waiting';

  $('stats').hidden = !ident;
  $('now-sources').hidden = !ident;
  $('upcoming-card').hidden = !ident;
  $('sync-row').hidden = !ident;
  // Only when a list fits this title (or one is in use, so it can be stopped).
  $('lists-card').hidden = !ident || !(page.profiles?.length || page.activeList);
  $('inject').hidden = has || !/^https?:/.test(tab?.url || '');
  const diag = has ? diagnosticsLine(page) : '';
  $('now-diag').hidden = !diag;
  $('now-diag').textContent = diag;
  const off = enabled ? [] : [['info', 'CleanCut is off, so everything plays uncut.']];

  if (!has) {
    const web = /^https?:/.test(tab?.url || '');
    $('now-site').textContent = web ? siteName('web') : '';
    $('now-title').textContent = web ? 'CleanCut isn’t running on this page' : 'Nothing playing here';
    $('now-title').removeAttribute('title');
    setHint(web
      ? 'It works on Netflix, Prime Video, YouTube, Disney+ and other streaming sites. If this page has a video, you can turn it on here.'
      : 'Open a streaming site, such as Netflix or YouTube, and start an episode.');
    setStatus(null);
    renderNotes([]);
    return;
  }
  $('now-site').textContent = siteName();
  if (!ident) {
    $('now-title').textContent = page.hasVideo ? 'Finding out what’s playing' : 'Waiting for a video';
    $('now-title').removeAttribute('title');
    setHint(page.hasVideo ? 'This takes a few seconds once the video starts.' : 'Start an episode and CleanCut will pick it up.');
    setStatus(enabled ? null : 'Off');
    renderNotes(off);
    return;
  }

  setHint(null);
  $('now-title').textContent = page.title || 'Unknown title';
  $('now-title').title = page.title || '';
  const offline = page.online === false || !!page.lookupError;
  if (!enabled) setStatus('Off');
  else if (offline) setStatus('Offline', 'warn');
  else setStatus('Filtering', 'ok');

  // At a glance: rating, cuts in effect, time skipped.
  const disabled = new Set(page.disabled);
  const live = page.actions.filter((a) => !disabled.has(a.key));
  const end = page.duration || Infinity;
  const skipped = live.filter((a) => a.action === 'skip').reduce((s, a) => s + Math.max(0, Math.min(a.end, end) - a.start), 0);
  const listPreset = page.activeList ? page.profiles?.find((p) => p.id === page.activeList.id)?.settings?.preset : null;
  $('stat-rating').textContent = page.activeList ? (listPreset ? presetLabel(listPreset) : 'List') : presetLabel(settings.profile.preset);
  $('stat-rating').title = page.activeList ? `From the skip list “${page.activeList.name}”` : '';
  $('stat-cuts').textContent = String(live.length);
  $('stat-time').textContent = formatTime(skipped);

  // Where this title's flags come from.
  const c = page.counts;
  const heard = page.listening && (HEARD_STATES.has(page.listening.state) || c.listening > 0);
  const parts = [page.catalog ? `${c.community} from the catalog` : 'Not in the catalog yet'];
  if (page.subtitle || !heard) parts.push(page.subtitle ? `${c.subtitles} from subtitles` : 'subtitles not scanned yet');
  if (heard) parts.push(`${c.listening || 0} from listening`);
  if (c.local) parts.push(`${c.local} from you`);
  $('now-sources').textContent = parts.join(' · ');

  const notes = [...off];
  const cat = page.catalog;
  const wantsListening = !!listen?.prefs?.on;
  if (offline) notes.push(['warn', 'Can’t reach the catalog right now. Using the saved copy and your own flags.']);
  if (cat?.timing === 'unsynced') notes.push(['warn', `These flags were timed on ${siteName(cat.timeline)}, so cuts may come early or late here. Turn on English subtitles to line them up, or adjust Timing below.`]);
  if (cat?.timing === 'aligned') notes.push(['info', `Flags lined up with ${siteName()} using its subtitles (${signed(cat.alignment.offset)}).`]);
  if (cat?.via === 'alias' || cat?.via === 'title') notes.push(['info', 'Found in the catalog by its title.']);
  if (wantsListening && page.listening?.state === 'encrypted') notes.push(['info', 'This service encrypts its audio, so CleanCut can’t listen ahead here.']);
  if (!page.subtitle && !heard && page.platform !== 'web' && cat?.timing !== 'unsynced') notes.push(['info', 'Tip: turn on English subtitles [CC] once so CleanCut can scan ahead.']);
  renderNotes(notes);

  $('offset').textContent = signed(page.offset);
  $('offset-summary').textContent = signed(page.offset);
  // Timing only matters when there is something to time, or it was already changed.
  $('sync-row').hidden = !(page.actions.length || page.offset !== 0 || cat?.timing === 'unsynced');
  if (!syncShown) {
    syncShown = true;
    $('sync-row').open = cat?.timing === 'unsynced' || page.offset !== 0;
  }
  renderListNote(listPreset);

  renderUpcoming();
  renderLists();
  $('share').hidden = !page.unshared;
  $('share').textContent = `Share ${plural(page.unshared, 'flag')} on GitHub`;
}

/**
 * A skip list in use decides what is cut on this title, while the rating
 * buttons keep showing the viewer's own rating: say which is which.
 */
function renderListNote(listPreset) {
  const box = $('list-note');
  const active = page?.activeList;
  box.hidden = !active;
  if (!active) {
    delete drawn['list-note'];
    return box.replaceChildren();
  }
  const rating = listPreset ? ` (${presetLabel(listPreset)})` : '';
  const where = scopeLabel(active.scope);
  const text = where === 'all titles'
    ? `The skip list “${active.name}”${rating} decides what’s cut on every title. The buttons show your own rating, used again once you stop.`
    : `For ${where}, the skip list “${active.name}”${rating} decides what’s cut. The buttons show your own rating, used everywhere else.`;
  redraw('list-note', [text], () => {
    const stop = Object.assign(document.createElement('button'), { className: 'link', textContent: 'Stop using the list' });
    stop.addEventListener('click', stopList);
    const body = document.createElement('span');
    body.append(Object.assign(document.createElement('span'), { textContent: `${text} ` }), stop);
    box.innerHTML = ICONS.info;
    box.append(body);
  });
}

async function stopList() {
  await chrome.runtime.sendMessage({ type: 'stopList', scopeKeys: scopeKeys() });
  setTimeout(refreshPage, 150);
}

/** One line saying how far subtitle scan-ahead got, so a report can say where it stopped. */
function diagnosticsLine(p) {
  const d = p.diag;
  if (!d || p.platform === 'web') return '';
  const parts = [`Page link ${d.hook ? 'ok' : 'missing'}`];
  if (p.platform === 'netflix') parts.push(`subtitle lists seen ${d.manifests}${d.decrypted ? ` (${d.decrypted} decrypted)` : ''}`);
  if (d.available != null) {
    parts.push(d.available ? `English tracks ${d.available}${d.dehydrated ? `, ${d.dehydrated} without links` : ''}` : 'no English subtitles listed');
  } else if (p.platform === 'netflix') parts.push('this episode not in any list yet');
  parts.push(`download ${d.download || (d.tracks ? 'pending' : 'not started')}`);
  if (p.subtitle) parts.push(`scanned ${p.subtitle.cues} lines${p.subtitle.sdh ? ' (SDH)' : ''}`);
  if (p.lookupError) parts.push(`catalog error: ${p.lookupError}`);
  return `Scan-ahead check: ${parts.join(' · ')}`;
}

function renderUpcoming() {
  const disabled = new Set(page.disabled);
  const regions = page.actions;
  const letPlay = regions.filter((r) => disabled.has(r.key)).length;
  $('skipped').textContent = letPlay ? `${letPlay} set to play` : '';
  // Where the playhead is: a cut already behind it, or the one it is in.
  const when = (r) => (r.end < page.time ? 'past' : r.start <= page.time ? 'now' : '');
  const sig = [regions.map((r) => [r.key, r.end, disabled.has(r.key), when(r)]), page.flagged.length];
  redraw('cuts', sig, () => {
    const ol = $('upcoming');
    ol.replaceChildren();
    if (!regions.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      const head = document.createElement('b');
      const suggested = page.flagged.filter((f) => f.decision === 'suggested').length;
      if (page.flagged.length) {
        head.textContent = 'Nothing to cut at this rating.';
        li.append(head, suggested
          ? `The subtitles hint at ${plural(suggested, 'more scene')}, too unsure to cut. ${suggested === 1 ? 'It’s' : 'They’re'} marked on the player’s timeline.`
          : 'Pick a stricter rating to cut more.');
      } else {
        head.textContent = 'No flags for this title yet.';
        li.append(head, 'Spot something? Flag it on the player and it’s cut for you right away.');
      }
      ol.append(li);
      return;
    }
    for (const r of regions) {
      const isOff = disabled.has(r.key);
      const li = document.createElement('li');
      if (isOff) li.classList.add('off');
      const at = when(r);
      if (at) li.classList.add(at);
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = CATEGORY_COLORS[r.reasons[0]?.category] || '#999';
      const time = document.createElement('span');
      time.className = 'when';
      time.textContent = `${formatTime(r.start)}–${formatTime(r.end)}`;
      // Said in words, not only by dimming the row.
      const state = document.createElement('span');
      state.className = 'state';
      state.textContent = at === 'past' ? ' Earlier' : at === 'now' ? ' Now' : ''; // the space keeps screen readers from running it into the time
      time.append(state);
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('b');
      name.textContent = r.reasons.map((x) => CATEGORY_LABEL[x.category] || cap(x.category)).join(', ');
      const how = document.createElement('span');
      how.textContent = `${cap(ACTION_LABELS[r.action] || r.action)} · ${[...new Set(r.reasons.map((x) => SEVERITIES[x.severity]))].join(', ')}`;
      what.append(name, how);
      what.title = `${name.textContent}: ${how.textContent}`;
      const btn = document.createElement('button');
      btn.className = 'btn toggle';
      btn.textContent = isOff ? 'Cut again' : 'Let play';
      btn.title = isOff ? 'Cut this scene again' : 'Let this scene play this time';
      btn.addEventListener('click', async () => {
        page = (await toContent({ type: 'toggleRegion', key: r.key })) || page;
        renderPage();
        // The row was redrawn: keep the keyboard where it was.
        $('upcoming').children[regions.indexOf(r)]?.querySelector('button')?.focus();
      });
      li.append(dot, time, what, btn);
      ol.append(li);
    }
  });
}

function scopeKeys() {
  const keys = [page.titleKey, '*'];
  if (page.ident?.canonicalKey) keys.push(`ck:${page.ident.canonicalKey}`);
  if (page.catalog?.key) keys.push(`ck:${page.catalog.key}`, `show:${page.catalog.key.split('/')[0]}`);
  return keys;
}

/** Where an adopted list applies: everything, the whole show, or one title. */
function scopeKeyFor(list) {
  if (list.scope === '*') return '*';
  if (list.scope.includes('/') || list.scope === page.catalog?.key) return `ck:${list.scope}`;
  return `show:${list.scope}`;
}

function scopeLabel(scope = '') {
  if (scope === '*' || scope === 'everything') return 'all titles';
  if (scope === 'this title') return 'this title'; // stored by older versions
  if (scope.includes('/')) return 'this episode';
  return page?.catalog?.key === scope ? 'this film' : 'this show';
}

function renderLists() {
  const active = page.activeList;
  const profiles = page.profiles || [];
  $('lists-meta').textContent = active ? '1 in use' : `${profiles.length} for this title`;
  redraw('lists', [active, profiles.map((p) => [p.id, p.name, p.author, p.scope, p.settings?.preset])], () => {
    const ul = $('lists');
    ul.replaceChildren();
    $('active-list').hidden = !active;
    if (active) {
      const text = document.createElement('span');
      text.textContent = `Using “${active.name}” for ${scopeLabel(active.scope)}.`;
      const stop = document.createElement('button');
      stop.className = 'link';
      stop.textContent = 'Stop using';
      stop.addEventListener('click', stopList);
      $('active-list').replaceChildren(text, stop);
    }
    for (const p of profiles) {
      const li = document.createElement('li');
      const info = document.createElement('div');
      info.className = 'info';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const preset = p.settings.preset === 'custom' ? 'Custom' : PRESETS[p.settings.preset]?.label;
      meta.textContent = `${preset}${p.author ? ` · by ${p.author}` : ''} · ${scopeLabel(p.scope)}`;
      if (p.description) info.title = p.description;
      info.append(name, meta);
      const use = document.createElement('button');
      use.className = active?.id === p.id ? 'btn small' : 'btn small primary';
      use.textContent = active?.id === p.id ? 'In use' : 'Use';
      use.disabled = active?.id === p.id;
      use.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'useList', profile: p, scopeKey: scopeKeyFor(p) });
        setTimeout(refreshPage, 150);
      });
      li.append(info, use);
      ul.append(li);
    }
  });
}

async function refreshPage() {
  [page, listen] = await Promise.all([
    toContent({ type: 'getState' }),
    chrome.runtime.sendMessage({ type: 'listenStatus' }).catch(() => listen),
  ]);
  renderPage();
  renderListen();
}

// ---- flagging and sharing ----------------------------------------------------------------

function note(text, tone) {
  $('cuts-note').textContent = text;
  $('cuts-note').dataset.tone = tone || '';
}

/** The flagger lives on the player: ask the page to open it, then get out of the way. */
async function openFlagger() {
  note('');
  const res = await toContent({ type: 'openFlagger' });
  const ERRORS = {
    'no video playing': 'Start the video first, then flag the scene on the player.',
    'ad playing': 'Wait for the ad to end, then flag the scene.',
  };
  if (res?.error) return note(ERRORS[res.error] || res.error, 'bad');
  if (res == null) {
    // No content script answered, or one too old to know this message.
    return note('Couldn’t reach the player. Reload the page, or press Alt+[ and Alt+] while watching.', 'bad');
  }
  window.close();
}

// Sharing goes through GitHub: open a prefilled "Submit to the catalog" issue.
async function openOnGitHub(res, setNote) {
  if (!res.prefilled) {
    try {
      await navigator.clipboard.writeText(res.json);
      setNote('Too long to fill in for you, so it’s on your clipboard. Paste it into the form that just opened.');
    } catch {
      setNote('Too long to fill in for you. Use Export flags in Options and paste the file into the form instead.');
    }
  }
  await chrome.tabs.create({ url: res.url });
}

// ---- debug log ------------------------------------------------------------------------

async function bindDebug() {
  const { debug } = await chrome.storage.local.get('debug');
  const show = (on) => {
    $('debug-rec').checked = on;
    $('debug-save').hidden = !on;
  };
  show(!!debug);
  if (debug) {
    $('debug-note').textContent = 'Recording. Save the log after playing the episode for about 30 seconds.';
    $('troubleshooting').open = true;
  }
  $('debug-rec').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await chrome.storage.local.set({ debug: on });
    show(on);
    $('debug-note').textContent = on
      ? 'Now reload the video’s tab, play the episode for about 30 seconds (try turning English subtitles [CC] on), then come back and save the log.'
      : 'Recording off.';
  });
  $('debug-save').addEventListener('click', async () => {
    const log = await toContent({ type: 'getDebugLog' });
    if (!log || log.error) {
      $('debug-note').textContent = `No log from this tab${log?.error ? ` (${log.error})` : ''}. Open CleanCut from the video’s tab, after reloading it.`;
      return;
    }
    const name = `cleancut-debug-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.json`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(log, null, 1)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    $('debug-note').textContent = `Saved ${name} (${log.events?.length || 0} events) to your Downloads. Send it over.`;
  });
}

// ---- wiring --------------------------------------------------------------------------

async function main() {
  $('build').textContent = `Build ${__CLEANCUT_BUILD__}`;
  bindDebug();
  // popup.html?tab=<id> targets a specific tab (handy for testing the popup in a normal tab).
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  tab = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  await loadSettings();
  $('enabled').checked = settings.enabled !== false;
  $('enabled').addEventListener('change', (e) => {
    settings.enabled = e.target.checked;
    renderPage();
    saveSettings();
  });
  renderPresets();
  bindPresetKeys();
  renderActions();
  bindAdvanced();
  bindListen();

  for (const b of document.querySelectorAll('[data-offset]')) {
    b.addEventListener('click', async () => {
      page = (await toContent({ type: 'setOffset', value: (page?.offset || 0) + Number(b.dataset.offset) })) || page;
      renderPage();
    });
  }
  $('inject').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'inject', tabId: tab.id });
    if (res?.error) setHint(`Couldn’t turn on here: ${res.error}`);
    setTimeout(refreshPage, 1200);
  });
  $('flag').addEventListener('click', openFlagger);
  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('share').addEventListener('click', async () => {
    const res = await toContent({ type: 'share' });
    if (!res || res.error) {
      note(res?.error || 'Nothing to share.', 'bad');
      return;
    }
    await chrome.runtime.sendMessage({ type: 'markShared', titleKey: page.titleKey, ids: res.ids });
    await toContent({ type: 'shared', ids: res.ids });
    await openOnGitHub(res, note);
  });

  const dialog = $('publish-dialog');
  $('publish').addEventListener('click', () => {
    const key = page?.catalog?.key;
    $('pub-scope-show').hidden = !key?.includes('/');
    $('pub-scope-title').hidden = !key;
    $('pub-scope-title').textContent = page?.title ? `Only ${page.title}` : 'Only this title';
    $('pub-scope').value = '*';
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
    const key = page?.catalog?.key;
    const scope = { '*': '*', show: key?.split('/')[0], title: key }[$('pub-scope').value] || '*';
    // Catalog tags you chose to let play this session become explicit exceptions.
    const letPlay = scope === key && page ? page.flagged
      .filter((f) => page.actions.some((a) => page.disabled.includes(a.key) && a.segmentIds.includes(f.id)))
      .map((f) => f.id).filter((id) => !/^(local|sub|listening):/.test(id)) : [];
    const res = await chrome.runtime.sendMessage({
      type: 'shareList',
      name,
      description: $('pub-desc').value.trim(),
      scope,
      overrides: { include: [], exclude: letPlay },
    });
    if (res?.error) {
      $('pub-error').textContent = res.error;
      return;
    }
    dialog.close();
    await openOnGitHub(res, (text) => ($('foot-note').textContent = text));
  });

  await refreshPage();
  setInterval(refreshPage, 1000);
}

main();
