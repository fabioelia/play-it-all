// Content script: identifies what is playing, gathers segments (the community
// catalog on GitHub, your own tags, scan-ahead subtitle analysis), and drives
// the <video> element — skip, mute, hide picture — according to the profile.

import { buildPlan, decide, skippedSeconds } from '../../../shared/engine.js';
import { displayTitle, formatTime, titleKey } from '../../../shared/identity.js';
import { CATEGORIES, SEVERITIES, defaultProfile, describeProfile } from '../../../shared/ratings.js';
import { segmentsFor, referenceCues } from '../../../shared/catalog.js';
import { alignCues, fingerprint } from '../../../shared/align.js';
import { detectAdapter } from './adapters.js';
import { createNetworkInspector } from './network.js';
import { CATEGORY_COLORS, Overlay } from './overlay.js';
import { Flagger, LAST_SECONDS } from './flagger.js';

(() => {
  if (window.__cleancutContent) return;
  window.__cleancutContent = true;

  // Which build is running (see extension/build.mjs): check it in the page's console.
  console.info(`CleanCut ${__CLEANCUT_BUILD__}`);

  const TICK_MS = 100;
  const IDENTIFY_MS = 1000;
  const label = (id) => CATEGORIES.find((c) => c.id === id)?.label || id;

  // ---- messaging helpers ---------------------------------------------------

  const alive = () => !!chrome.runtime?.id; // false after the extension reloads
  async function bg(message) {
    if (!alive()) return { error: 'extension reloaded — refresh the page' };
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }

  // ---- debug log (Popup → "Record a debug log") ------------------------------
  // Steps, ids and counts only: no subtitle text, no URLs with tokens.
  const dlog = [];
  let debugOn = false;
  let dlogDropped = 0;
  function log(ev, data = {}) {
    if (!debugOn) return;
    if (dlog.length >= 800) {
      dlogDropped++;
      return;
    }
    dlog.push({ t: Math.round(performance.now()), ev, ...data });
  }
  const errorsSeen = new Map();
  function logError(where, e) {
    const key = `${where}: ${e?.message || e}`;
    const n = (errorsSeen.get(key) || 0) + 1;
    errorsSeen.set(key, n);
    if (n <= 3) log('error', { where, message: String(e?.message || e).slice(0, 300), stack: String(e?.stack || '').split('\n').slice(0, 4).join(' | ').slice(0, 500) });
  }
  function applyDebug(on) {
    debugOn = !!on;
    try {
      // Read by the page hook at document_start of the next load.
      if (debugOn) localStorage.setItem('cleancut:debug', '1');
      else localStorage.removeItem('cleancut:debug');
    } catch { /* storage blocked */ }
    log('debug-on', { path: location.pathname, build: __CLEANCUT_BUILD__ });
  }
  if (alive()) chrome.storage.local.get('debug').then(({ debug }) => applyDebug(debug), () => {});

  // The page hook (page world) talks to us over a private MessageChannel; see
  // connectHook below. Netflix seeks go through it to the player's own API.
  let hookPort = null;
  const pendingSeeks = new Map();
  let seekSeq = 0;
  const bridge = {
    seek(seconds) {
      if (!hookPort) return Promise.resolve(false);
      const reqId = ++seekSeq;
      hookPort.postMessage({ type: 'seek', seconds, reqId });
      return new Promise((resolve) => {
        pendingSeeks.set(reqId, resolve);
        setTimeout(() => {
          if (pendingSeeks.delete(reqId)) resolve(false);
        }, 1000);
      });
    },
  };

  const adapter = detectAdapter(bridge);
  const overlay = new Overlay({ fillViewport: !!adapter.fillsViewport });
  {
    const toast = overlay.toast.bind(overlay);
    overlay.toast = (text, o) => {
      log('toast', { text: String(text).slice(0, 160) });
      return toast(text, o);
    };
  }

  // ---- state ---------------------------------------------------------------

  const state = {
    settings: { enabled: true, profile: defaultProfile() },
    activeLists: {},
    ident: null,
    key: null,
    remote: [],
    local: [],
    subtitle: [],
    subtitleInfo: null, // { source: {text}|{cues}, url, sdh, count, cueStarts, mode }
    pendingSubs: new Map(), // forId → payload, for tracks that arrive before/after their episode
    profiles: [],
    episode: null, // catalog file for this title, if any
    catalogKey: null,
    via: null, // how the catalog matched: platform id, title or alias
    timing: null, // native | synced | aligned | unsynced
    alignment: null, // offset measured on this device from subtitles
    online: null,
    lookupError: null,
    offset: 0,
    plan: null,
    disabled: new Set(),
    video: null,
    mutedByUs: false,
    seekPending: false,
    seekBroken: false, // the player refused to seek: cover skip regions instead
    captionsHidden: false,
    prevMuted: false,
    blurred: false,
    lastSeek: null,
    markStart: null,
    flag: null, // { phase: 'recording', start, shown } | { phase: 'picking' }
    flagsSaved: 0,
    stats: { skips: 0, mutes: 0 },
  };

  // ---- hiding the picture and captions ---------------------------------------------
  // Inline styles on just the elements involved: no stylesheet is added to the
  // page, so Netflix's large DOM is never re-matched against our selectors.
  // brightness(0) is a single cheap colour pass; a blur() filter stuttered playback.
  const setPictureHidden = (video, hidden) => {
    if (hidden) video.style.setProperty('filter', 'brightness(0)', 'important');
    else video.style.removeProperty('filter');
  };

  // ---- settings --------------------------------------------------------------

  async function loadSettings() {
    if (!alive()) return;
    const [{ settings }, { activeLists }] = await Promise.all([
      chrome.storage.sync.get('settings'),
      chrome.storage.local.get('activeLists'),
    ]);
    state.settings = { enabled: true, ...(settings || {}), profile: { ...defaultProfile(), ...(settings?.profile || {}) } };
    state.activeLists = activeLists || {};
  }

  function activeList() {
    if (!state.ident) return state.activeLists['*'] || null;
    const lists = state.activeLists;
    const ck = state.catalogKey;
    return lists[state.key]
      || (ck && lists[`ck:${ck}`])
      || (state.ident.canonicalKey && lists[`ck:${state.ident.canonicalKey}`])
      || (ck && lists[`show:${ck.split('/')[0]}`])
      || lists['*'] || null;
  }

  function effectiveProfile() {
    const list = activeList();
    return list ? { ...state.settings.profile, ...list.settings } : state.settings.profile;
  }

  // ---- planning --------------------------------------------------------------

  /** Re-scan only when the language setting changed (scanning runs in the background worker). */
  async function analyzeSubtitles() {
    const info = state.subtitleInfo;
    const mode = effectiveProfile().languageMode;
    if (!info || info.mode === mode) return;
    const key = state.key;
    const r = await bg({ type: 'scanSubtitles', ...info.source, languageMode: mode });
    if (state.key !== key || state.subtitleInfo !== info || !r?.ok) return;
    info.mode = mode;
    state.subtitle = r.segments;
    replan();
  }

  /**
   * Hand a subtitle track to the background worker for parsing and scanning;
   * the page's main thread only sends the text and receives the results.
   */
  async function scanTrack(source, { url, sdh = false }) {
    const key = state.key;
    const mode = effectiveProfile().languageMode;
    const r = await bg({ type: 'scanSubtitles', ...source, languageMode: mode });
    log('scan', { ok: !!r?.ok, error: r?.error || null, cues: r?.count ?? null, segments: r?.segments?.length ?? null, sameTitle: state.key === key });
    if (!r?.ok || state.key !== key) return false;
    if (state.subtitleInfo?.sdh && !(sdh || r.sdh)) return false; // keep the richer SDH track
    state.subtitleInfo = { source, url, sdh: sdh || r.sdh, count: r.count, cueStarts: r.cueStarts, mode };
    state.subtitle = r.segments;
    syncFromSubtitles();
    replan();
    return true;
  }

  /**
   * Catalog tags on this service's clock. When the catalog has not timed this
   * service yet, measure its clock by matching our subtitle timing against the
   * episode's fingerprint; failing that, show them on the reference clock and
   * let the viewer nudge Sync.
   */
  function computeRemote() {
    const ep = state.episode;
    if (!ep) {
      state.remote = [];
      state.timing = null;
      return;
    }
    const platform = state.ident.platform;
    const known = ep.platforms?.[platform];
    state.alignment = null;
    if (!(known && Number.isFinite(known.offset)) && state.subtitleInfo && referenceCues(ep).length) {
      state.alignment = alignCues(referenceCues(ep), state.subtitleInfo.cueStarts);
    }
    const r = segmentsFor(ep, platform, state.alignment || undefined);
    state.remote = r.segments;
    state.timing = r.timing;
  }

  /** Subtitles just arrived: catalog tags timed elsewhere may now be alignable. */
  function syncFromSubtitles() {
    if (!state.episode || state.timing !== 'unsynced') return;
    computeRemote();
    if (state.timing === 'aligned') {
      const a = state.alignment;
      overlay.toast(`Synced ${state.remote.length} tag${state.remote.length === 1 ? '' : 's'} to this service from subtitle timing (${a.offset >= 0 ? '+' : ''}${a.offset}s)`, { ms: 5000, color: '#7cb342' });
    }
  }

  function replan() {
    const shift = (s) => ({ ...s, start: s.start + state.offset, end: s.end + state.offset });
    const remote = state.remote.map(shift);
    // Tags you shared come back through the catalog once merged; count them once.
    const overlaps = (a, b) => a.category === b.category && Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.6 * (Math.max(a.end, b.end) - Math.min(a.start, b.start));
    const local = state.local.filter((l) => !l.sharedAt || !remote.some((r) => overlaps(r, l)));
    const all = [...remote, ...local, ...state.subtitle];
    const list = activeList();
    state.plan = buildPlan(all, effectiveProfile(), { overrides: list?.overrides });
    const duration = state.video?.duration;
    overlay.renderTimeline(state.plan.flagged, duration);
    const cuts = state.plan.actions.length;
    const removed = skippedSeconds(state.plan.actions, duration);
    overlay.setBadge(`CleanCut · ${list ? list.name : describeProfile(effectiveProfile())} · ${cuts} cut${cuts === 1 ? '' : 's'}${removed ? ` (−${formatTime(removed)})` : ''}`);
    bg({ type: 'status', count: state.settings.enabled ? cuts : 0, enabled: state.settings.enabled });
  }

  // ---- identification & lookup -------------------------------------------------

  /**
   * @param {object} ident
   * @param {{ refresh?: boolean }} [opts] refresh: same episode, better metadata —
   *   look it up again but keep the subtitle scan and session choices.
   */
  async function loadTitle(ident, { refresh = false } = {}) {
    state.ident = ident;
    state.key = titleKey(ident.platform, ident.platformId);
    const key = state.key;
    if (!refresh) {
      restorePlayback();
      cancelFlag();
      Object.assign(state, { remote: [], local: [], subtitle: [], subtitleInfo: null, profiles: [], episode: null, catalogKey: null, via: null, timing: null, alignment: null, disabled: new Set(), lastSeek: null, seekPending: false, markStart: null });
      const pending = state.pendingSubs.get(ident.platformId) || state.pendingSubs.get('__unassigned');
      if (pending) handleSubtitles(pending, true);
      state.pendingSubs.clear();
      const { offsets } = alive() ? await chrome.storage.local.get('offsets') : {};
      state.offset = offsets?.[key] || 0;
      replan();
    }

    const res = await bg({ type: 'lookup', title: { ...ident.meta, platform: ident.platform, platformId: ident.platformId, canonicalKey: ident.canonicalKey } });
    if (state.key !== key) return; // navigated away meanwhile
    state.episode = res?.episode || null;
    state.catalogKey = res?.catalogKey || null;
    state.via = res?.via || null;
    state.local = res?.local || [];
    state.profiles = res?.lists || [];
    state.online = !!res?.online;
    state.lookupError = res?.error || null;
    log('catalog', { found: !!state.episode, key: state.catalogKey, via: state.via, local: state.local.length, error: state.lookupError });
    computeRemote();
    replan();
    if (refresh) return;
    if (state.settings.enabled && state.remote.length + state.local.length) {
      const n = state.remote.length + state.local.length;
      overlay.toast(`${displayTitle(ident.meta)} · ${n} tagged scene${n === 1 ? '' : 's'} · filtering at ${activeList()?.name || describeProfile(effectiveProfile())}`, { ms: 4000 });
    }
    if (state.timing === 'unsynced' && state.remote.length) {
      overlay.toast(`These tags were timed on ${state.episode.timeline}. Turn on English subtitles so CleanCut can sync them, or nudge Sync in the popup.`, { ms: 8000, color: '#f9a825' });
    }
  }

  // Runs once a second. Until a player shows up (browse and title pages) this
  // is all CleanCut does on the page: no overlay element, no playback loop.
  function identify() {
    try {
      identifyOnce();
    } catch (e) {
      logError('identify', e);
    }
  }
  function identifyOnce() {
    if (!alive()) return shutdown(); // extension reloaded or disabled: stop for good
    const video = adapter.findVideo();
    if (video !== state.video) attachVideo(video);
    if (!video) return;
    overlay.attach();
    inspector.activate();
    const ident = adapter.identify();
    if (!ident) return;
    const key = titleKey(ident.platform, ident.platformId);
    if (key !== state.key) {
      log('title', { platformId: ident.platformId, meta: ident.meta ? Object.keys(ident.meta).join(',') : null, canonicalKey: ident.canonicalKey });
      loadTitle(ident);
    } else if (ident.canonicalKey && !state.ident.canonicalKey) {
      // Metadata arrived after the first lookup: retry so cross-platform tags can be found.
      loadTitle(ident, { refresh: true });
    }
    inspector.want(ident.platformId); // fetch this title's subtitle track (once) when known
    if (!state.subtitleInfo && !state.trackScanPending && adapter.readTextTracks) {
      const cues = adapter.readTextTracks(video);
      if (cues?.length) {
        state.trackScanPending = true;
        scanTrack({ cues }, { url: 'textTracks' }).finally(() => {
          state.trackScanPending = false;
        });
      }
    }
  }

  // The 100 ms playback loop runs only while a video is attached and playing.
  let tickTimer = 0;
  const startTicking = () => {
    if (!tickTimer) tickTimer = setInterval(tick, TICK_MS);
  };
  const stopTicking = () => {
    clearInterval(tickTimer);
    tickTimer = 0;
  };
  const videoEvents = {
    seeking: (e) => tick(e),
    loadedmetadata: () => replan(),
    play: () => startTicking(),
    playing: () => startTicking(),
    pause: () => stopTicking(),
    ended: () => stopTicking(),
    emptied: () => stopTicking(),
  };

  function attachVideo(video) {
    log('video', { found: !!video, path: location.pathname, readyState: video?.readyState, duration: video?.duration || null });
    cancelFlag();
    restorePlayback();
    stopTicking();
    if (state.video) for (const [type, fn] of Object.entries(videoEvents)) state.video.removeEventListener(type, fn);
    state.video = video;
    overlay.setVideo(video);
    if (!video) {
      overlay.detach();
      inspector.deactivate();
      return;
    }
    for (const [type, fn] of Object.entries(videoEvents)) video.addEventListener(type, fn);
    if (!video.paused) startTicking();
  }

  // ---- subtitles (scan-ahead) ---------------------------------------------------

  function handleSubtitles(payload, force = false) {
    const { text, forId, sdh, url } = payload;
    log('subtitles', { forId, playing: state.ident?.platformId ?? null, sdh: !!sdh, chars: text?.length || 0, force, passive: !!payload.passive });
    if (!force && !state.ident) {
      state.pendingSubs.set(forId || '__unassigned', payload);
      return;
    }
    if (!force && forId && forId !== state.ident.platformId) {
      state.pendingSubs.set(forId, payload); // next episode prefetch
      return;
    }
    if (state.subtitleInfo?.url === url) return; // already analyzed (replayed message)
    if (state.subtitleInfo?.sdh && !sdh) return; // keep the richer SDH track
    scanTrack({ text }, { url, sdh: !!sdh }).then((ok) => {
      const found = state.subtitle.length;
      if (ok && found) overlay.toast(`Scanned ahead: ${found} possible issue${found === 1 ? '' : 's'} found in subtitles`, { ms: 3500, color: '#7cb342' });
    });
  }

  // Responses the page hook forwarded are parsed here, and only once a title
  // is in the player (see network.js), not in the hook at document_start.
  const pendingFetches = new Map();
  let fetchSeq = 0;
  /** Download through the page hook (the page's own origin and network stack). */
  function pageFetch(url) {
    if (!hookPort) return Promise.resolve({ ok: false, status: 0, error: 'no page hook' });
    const reqId = ++fetchSeq;
    hookPort.postMessage({ type: 'fetch', url, reqId });
    return new Promise((resolve) => {
      pendingFetches.set(reqId, resolve);
      setTimeout(() => {
        if (pendingFetches.delete(reqId)) resolve({ ok: false, status: 0, error: 'timed out' });
      }, 20_000);
    });
  }

  const askedForSubtitles = new Set();
  const inspector = createNetworkInspector((type, payload) => {
    if (type === 'subtitles') handleSubtitles(payload);
    else if (type === 'needs-subtitles') {
      // Netflix sends links only for the subtitle track that is selected.
      if (askedForSubtitles.has(payload.forId) || state.subtitleInfo) return;
      askedForSubtitles.add(payload.forId);
      overlay.toast('To scan ahead, turn on English subtitles [CC] once for this episode. You can turn them off again right after.', { ms: 9000, color: '#f9a825' });
    } else adapter.onPageMessage(type, payload);
  }, { pageFetch, log });

  function onHookMessage({ type, payload } = {}) {
    if (type === 'response' && payload) inspector.handle(payload);
    else if (type === 'tracks' && payload) {
      log('tracks-from-page', { movieId: payload.movieId, via: payload.via, links: payload.tracks?.length || 0, english: payload.available, withoutLinks: payload.dehydrated, formats: [...new Set((payload.tracks || []).map((t) => t.format))] });
      inspector.tracks(payload);
    } else if (type === 'debug' && payload) {
      if (debugOn) {
        if (dlog.length < 800) dlog.push({ ...payload, src: 'page' });
        else dlogDropped++;
      }
    } else if (type === 'debug-dump') {
      const resolve = pendingFetches.get(`dump${payload?.reqId}`);
      if (resolve) {
        pendingFetches.delete(`dump${payload.reqId}`);
        resolve(payload);
      }
    }
    else if (type === 'fetch-result') {
      const resolve = pendingFetches.get(payload?.reqId);
      if (resolve) {
        pendingFetches.delete(payload.reqId);
        resolve(payload);
      }
    }
    else if (type === 'seek-result') {
      const resolve = pendingSeeks.get(payload?.reqId);
      if (resolve) {
        pendingSeeks.delete(payload.reqId);
        resolve(!!payload.ok);
      }
    }
  }

  // Ask the page hook for a private channel (a DOM event both worlds see); it
  // answers with one window message carrying the port, then sends what it
  // found before we loaded. No window 'message' listener stays installed, so
  // the site's own window messages never wake this script.
  function connectHook() {
    const onPort = (e) => {
      if (e.source !== window || e.data?.__cleancut !== 'port' || !e.ports?.[0]) return;
      window.removeEventListener('message', onPort);
      hookPort = e.ports[0];
      hookPort.onmessage = (m) => onHookMessage(m.data);
      log('hook-connected');
    };
    window.addEventListener('message', onPort);
    document.dispatchEvent(new CustomEvent('cleancut:connect'));
    setTimeout(() => {
      window.removeEventListener('message', onPort);
      if (!hookPort) log('hook-missing', { note: 'no answer from the page hook within 5 s' });
    }, 5000); // no hook on this page
  }
  connectHook();

  // ---- the playback loop ----------------------------------------------------------

  function reasonText(reasons) {
    return reasons.map((r) => `${label(r.category).toLowerCase()} (${SEVERITIES[r.severity]})`).join(', ');
  }

  function setCaptionsHidden(hidden) {
    state.captionsHidden = hidden;
    if (!adapter.captionSelector) return;
    for (const el of document.querySelectorAll(adapter.captionSelector)) {
      // Reading an inline style is not a layout read; only write when needed.
      const isHidden = el.style.getPropertyValue('visibility') === 'hidden';
      if (hidden && !isHidden) el.style.setProperty('visibility', 'hidden', 'important');
      else if (!hidden && isHidden) el.style.removeProperty('visibility');
    }
  }

  function restorePlayback() {
    const v = state.video;
    if (v && state.mutedByUs) v.muted = state.prevMuted;
    if (v && state.blurred) setPictureHidden(v, false);
    if (state.blurred) overlay.setCover(null);
    state.mutedByUs = false;
    state.blurred = false;
    if (state.captionsHidden) setCaptionsHidden(false);
  }

  // Runs every 100 ms while playing, and on every seek (event argument).
  function tick(event) {
    try {
      tickOnce(event);
      if (state.flag?.phase === 'recording') updateRecording();
    } catch (e) {
      logError('tick', e);
    }
  }
  function tickOnce(event) {
    if (adapter.isAdPlaying?.()) return restorePlayback(); // never skip, mute or hide during an ad (adapters.js)
    const video = state.video;
    if (!video || !state.plan || !state.settings.enabled || !video.isConnected || video.readyState === 0) {
      if (!state.settings.enabled) restorePlayback();
      return;
    }
    if (video.paused && !event) return; // nothing moves while paused; seeks call us directly
    const t = adapter.currentTime(video);
    const duration = video.duration;
    overlay.setPlayhead(t, duration);
    const d = decide(t, state.plan.actions, { disabled: state.disabled });

    if (d.skipTo !== null && !state.seekBroken) {
      const now = performance.now();
      const target = Number.isFinite(duration) ? Math.min(d.skipTo, duration - 0.25) : d.skipTo;
      const recent = state.lastSeek && Math.abs(state.lastSeek.target - target) < 0.5 && now - state.lastSeek.at < 2500;
      // Never interrupt a seek that is still buffering: re-seeking restarts it,
      // which is exactly what stutter looks like.
      if (!recent && !state.seekPending && !video.seeking) {
        state.lastSeek = { target, at: now };
        state.seekPending = true;
        const region = d.skipRegion;
        const from = Math.max(t, region.start);
        const key = state.key;
        Promise.resolve(adapter.seek(video, target)).then((ok) => {
          state.seekPending = false;
          if (state.key !== key) return;
          if (ok === false) {
            // The player would not seek (on Netflix: its internal API changed).
            // Hide the scene another way rather than let it play.
            state.seekBroken = true;
            overlay.toast("This player won't let CleanCut skip, so those scenes will be muted with the picture hidden instead.", { color: '#f9a825', ms: 8000 });
            tick();
            return;
          }
          state.stats.skips++;
          overlay.toast(`Skipped ${formatTime(target - from)} · ${reasonText(region.reasons)}`, {
            color: CATEGORY_COLORS[region.reasons[0]?.category],
            actionLabel: 'Undo',
            onAction: () => {
              state.disabled.add(region.key);
              state.lastSeek = null;
              adapter.seek(video, region.start);
            },
          });
        });
      }
    }
    // Fallback when skipping is impossible: cover the scene instead.
    const cover = state.seekBroken && d.skipTo !== null;
    const mute = d.mute || cover;
    const blur = d.blur || cover;

    const hideCaptions = effectiveProfile().hideCaptionsWhileMuted !== false;
    if (mute && !state.mutedByUs) {
      state.prevMuted = video.muted;
      video.muted = true;
      state.mutedByUs = true;
      state.stats.mutes++;
      if (hideCaptions) setCaptionsHidden(true);
    } else if (!mute && state.mutedByUs) {
      video.muted = state.prevMuted;
      state.mutedByUs = false;
      setCaptionsHidden(false);
    } else if (mute && hideCaptions) {
      setCaptionsHidden(true); // players re-render caption nodes constantly
    }

    if (blur && state.blurred && video.style.getPropertyValue('filter') !== 'brightness(0)') {
      setPictureHidden(video, true); // the player re-rendered the element's style
    }
    if (blur !== state.blurred) {
      setPictureHidden(video, blur);
      state.blurred = blur;
      const hidden = d.active.filter((r) => r.action === 'blur' || (cover && r.action === 'skip'));
      overlay.setCover(blur ? `Picture hidden · ${reasonText(hidden.flatMap((r) => r.reasons))}` : null);
    }
  }

  // ---- flagging scenes -----------------------------------------------------------------
  // On the player: "Flag scene" (Alt+[) starts recording at the current time,
  // Done (Alt+[ again, or Alt+]) pauses and opens the picker; "Last 10 s"
  // (Alt+] when not recording) flags what just happened. Escape cancels.

  const flagger = new Flagger(overlay, {
    onStart: () => startFlag(),
    onDone: () => finishFlag(),
    onLast: () => flagLast(),
    onCancel: () => cancelFlag(),
  });

  function startFlag() {
    const video = state.video;
    if (!video) return { error: 'no video' };
    if (state.flag?.phase === 'picking') return { error: 'already picking' };
    // Pressed again while recording (popup "Mark start"): start over from here.
    state.markStart = adapter.currentTime(video);
    state.flag = { phase: 'recording', start: state.markStart, shown: 0 };
    flagger.record();
    overlay.setPending(state.markStart, state.markStart, video.duration);
    return { ok: true, start: state.markStart };
  }

  /** While recording: keep the elapsed time and the timeline range current (once a second). */
  function updateRecording() {
    const video = state.video;
    const flag = state.flag;
    const t = adapter.currentTime(video);
    const shown = Math.floor(Math.abs(t - flag.start));
    if (shown === flag.shown) return;
    flag.shown = shown;
    flagger.setElapsed(shown);
    overlay.setPending(Math.min(flag.start, t), Math.max(flag.start, t), video.duration);
  }

  /** @param {{ keyboard?: boolean }} [how] keyboard: from a shortcut (focus goes into the picker) */
  function finishFlag(how) {
    if (state.flag?.phase !== 'recording') return state.flag ? { error: 'already picking' } : flagLast(how);
    let start = state.flag.start;
    let end = adapter.currentTime(state.video);
    if (end < start) [start, end] = [end, start]; // sought back past the start
    return pickAndSave(start, end, how);
  }

  function flagLast(how) {
    const video = state.video;
    if (!video) return { error: 'no video' };
    if (state.flag) return { error: 'already flagging' };
    const end = adapter.currentTime(video);
    return pickAndSave(Math.max(0, end - LAST_SECONDS), end, how);
  }

  function cancelFlag() {
    if (!state.flag) return;
    const picking = state.flag.phase === 'picking';
    state.flag = null;
    state.markStart = null;
    overlay.setPending(null);
    if (picking) flagger.finish(null); // pickAndSave carries on: resumes playback
    else flagger.idle();
  }

  /** The title as the catalog wants it in a submission. */
  function submissionTitle() {
    const m = state.ident.meta || {};
    const duration = state.video?.duration;
    return {
      platform: state.ident.platform,
      platformId: state.ident.platformId,
      ...(m.series ? { series: m.series, season: m.season, episode: m.episode } : {}),
      ...(m.name ? { name: m.name } : {}),
      ...(m.year ? { year: m.year } : {}),
      ...(Number.isFinite(duration) ? { runtime: Math.round(duration) } : {}),
    };
  }

  /** Pause, let the viewer adjust the range and say what is in it, then save the tag. */
  async function pickAndSave(start, end, { keyboard = false } = {}) {
    const video = state.video;
    if (!video) return { error: 'no video' };
    const key = state.key;
    const duration = video.duration;
    const max = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
    // Whole seconds, rounded outward: what the picker shows is exactly what is
    // saved, and a cut that is a little long beats one that is a little short.
    start = Math.max(0, Math.floor(start));
    end = Math.min(Math.ceil(end), max);
    if (end - start < 1) {
      if (start + 1 <= max) end = start + 1;
      else start = Math.max(0, end - 1);
    }
    state.flag = { phase: 'picking' };
    state.markStart = null;
    const wasPlaying = !video.paused;
    if (wasPlaying) video.pause();
    overlay.setPending(start, end, duration);
    const answer = await flagger.pick({ start, end, duration, keyboard, onRange: (s, e) => overlay.setPending(s, e, duration) });
    if (state.flag?.phase === 'picking') state.flag = null;
    overlay.setPending(null);
    if (wasPlaying && state.video === video) video.play().catch(() => {});
    if (!answer) return { cancelled: true };
    if (!state.ident || state.key !== key) {
      overlay.toast('CleanCut has not recognised this title yet, so the flag was not saved. Try again in a moment.', { color: '#e53935' });
      return { error: 'title not identified' };
    }
    const res = await bg({
      type: 'saveTag',
      title: submissionTitle(),
      segment: { start: answer.start, end: answer.end, category: answer.category, severity: answer.severity, note: answer.note },
    });
    if (!res?.segment) {
      overlay.toast(`Could not save the flag: ${res?.error || 'unknown error'}`, { color: '#e53935' });
      return res;
    }
    const seg = res.segment;
    if (state.key === key) {
      state.local.push(seg);
      replan();
      // Playback resumed where it paused, at the very end of the new cut: do
      // not jump its last second with a "Skipped 0:00" toast.
      const t = adapter.currentTime(video);
      const d = decide(t, state.plan.actions, { disabled: state.disabled });
      if (d.skipTo !== null && d.skipTo - t < 2) {
        state.lastSeek = { target: Number.isFinite(duration) ? Math.min(d.skipTo, duration - 0.25) : d.skipTo, at: performance.now() };
      }
    }
    state.flagsSaved++;
    overlay.toast(`Flagged ${label(seg.category).toLowerCase()} (${SEVERITIES[seg.severity]})`, {
      color: CATEGORY_COLORS[seg.category],
      detail: `${formatTime(seg.start)}–${formatTime(seg.end)} · ${flagEffect(seg)}${state.flagsSaved === 1 ? ' · share it from the CleanCut menu' : ''}`,
      actionLabel: 'Undo',
      onAction: () => unflag(seg, key),
      ms: 8000,
    });
    return res;
  }

  /** What the new tag does at the current rating, in a few words. */
  const DONE_TO = { skip: 'skipped', mute: 'muted', blur: 'picture hidden' };
  function flagEffect(seg) {
    if (!state.settings.enabled) return 'saved; CleanCut is off';
    const f = state.plan?.flagged.find((x) => x.id === seg.id);
    const rating = activeList()?.name || describeProfile(effectiveProfile());
    return f?.decision === 'filter' ? `${DONE_TO[f.action] || 'cut'} at ${rating}` : `still plays at ${rating}`;
  }

  async function unflag(seg, key) {
    const res = await bg({ type: 'deleteTag', titleKey: key, id: seg.id });
    if (state.key === key) {
      state.local = state.local.filter((l) => l.id !== seg.id);
      replan();
    }
    if (res?.error) overlay.toast(`Could not remove the flag: ${res.error}`, { color: '#e53935' });
    else overlay.toast('Flag removed', { color: '#888', ms: 2500 });
  }

  /** The popup's "Flag a scene": show the control on the player, ready to start. */
  function openFlagger() {
    const video = state.video;
    if (!video?.isConnected) return { error: 'no video playing' };
    overlay.attach();
    flagger.invite();
    return { ok: true };
  }

  // Shortcuts: only Alt+[ and Alt+], and Escape while a flag is in progress.
  // The site's own keys (space, f, m, arrows, Escape otherwise) are never taken.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.flag && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      cancelFlag();
      return;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code !== 'BracketLeft' && e.code !== 'BracketRight') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || state.flag?.phase === 'picking') return;
    if (state.flag) finishFlag({ keyboard: true }); // either key ends a recording
    else if (e.code === 'BracketLeft') startFlag();
    else flagLast({ keyboard: true });
  }, true);

  // ---- popup / background messages ------------------------------------------------------

  function snapshot() {
    const v = state.video;
    const plan = state.plan;
    const count = (src) => (plan?.flagged || []).filter((s) => src(s.source)).length;
    const list = activeList();
    return {
      supported: true,
      platform: adapter.platform,
      hasVideo: !!v,
      enabled: state.settings.enabled,
      ident: state.ident,
      titleKey: state.key,
      title: state.ident ? displayTitle(state.ident.meta) : null,
      time: v ? adapter.currentTime(v) : 0,
      duration: v?.duration || 0,
      offset: state.offset,
      online: state.online,
      lookupError: state.lookupError,
      catalog: state.episode ? {
        key: state.catalogKey,
        via: state.via,
        timing: state.timing,
        alignment: state.alignment,
        timeline: state.episode.timeline,
        platforms: Object.keys(state.episode.platforms || {}),
        segments: state.episode.segments?.length || 0,
      } : null,
      unshared: state.local.filter((l) => !l.sharedAt).length,
      counts: {
        community: count((s) => s === 'community' || s === 'scanner'),
        local: count((s) => s === 'local'),
        subtitles: count((s) => s === 'subtitles'),
      },
      subtitle: state.subtitleInfo ? { cues: state.subtitleInfo.count, sdh: state.subtitleInfo.sdh } : null,
      diag: { hook: !!hookPort, ...inspector.diagnostics() },
      actions: plan?.actions || [],
      flagged: plan?.flagged || [],
      skipped: plan ? skippedSeconds(plan.actions, v?.duration) : 0,
      disabled: [...state.disabled],
      profiles: state.profiles,
      activeList: list ? { id: list.id, name: list.name, scope: list.scope } : null,
      profileLabel: list ? list.name : describeProfile(effectiveProfile()),
      markStart: state.markStart,
      flagging: state.flag?.phase || null,
      stats: state.stats,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case 'getState':
          return snapshot();
        case 'getDebugLog': {
          let page = null;
          if (hookPort) {
            const reqId = ++fetchSeq;
            page = await new Promise((resolve) => {
              pendingFetches.set(`dump${reqId}`, resolve);
              hookPort.postMessage({ type: 'debug-dump', reqId });
              setTimeout(() => {
                if (pendingFetches.delete(`dump${reqId}`)) resolve({ error: 'page hook did not answer' });
              }, 1500);
            });
          }
          const snap = snapshot();
          return {
            cleancut: __CLEANCUT_BUILD__,
            recorded: new Date().toISOString(),
            browser: navigator.userAgent,
            path: location.pathname,
            recording: debugOn,
            hookConnected: !!hookPort,
            settings: { enabled: state.settings.enabled, profile: snap.profileLabel, languageMode: effectiveProfile().languageMode },
            state: { platform: snap.platform, hasVideo: snap.hasVideo, ident: state.ident ? { platformId: state.ident.platformId, canonicalKey: state.ident.canonicalKey } : null,
              title: snap.title, duration: snap.duration, catalog: snap.catalog, counts: snap.counts, subtitle: snap.subtitle, cuts: snap.actions.length, diag: snap.diag },
            errors: [...errorsSeen].map(([k, n]) => ({ error: k, times: n })),
            events: dlog,
            eventsDropped: dlogDropped,
            page,
          };
        }
        case 'setOffset': {
          state.offset = Math.round(Number(msg.value) * 10) / 10 || 0;
          const { offsets = {} } = await chrome.storage.local.get('offsets');
          if (state.offset) offsets[state.key] = state.offset;
          else delete offsets[state.key];
          await chrome.storage.local.set({ offsets });
          replan();
          return snapshot();
        }
        case 'toggleRegion':
          if (state.disabled.has(msg.key)) state.disabled.delete(msg.key);
          else state.disabled.add(msg.key);
          return snapshot();
        case 'openFlagger':
          return openFlagger();
        case 'markStart':
          return startFlag();
        case 'markEnd':
          finishFlag();
          return { ok: true };
        case 'share': {
          if (!state.ident) return { error: 'nothing playing' };
          const cues = state.subtitleInfo?.cueStarts;
          return bg({
            type: 'shareTags',
            title: submissionTitle(),
            label: displayTitle(state.ident.meta),
            sync: cues?.length ? fingerprint(cues, 300) : null,
          });
        }
        case 'shared':
          for (const l of state.local) if (msg.ids.includes(l.id)) l.sharedAt = Date.now();
          return snapshot();
        case 'refresh':
          if (state.ident) await loadTitle(state.ident);
          return snapshot();
        default:
          return undefined;
      }
    })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  });

  if (alive()) {
    chrome.storage.onChanged.addListener(async (changes) => {
      if (changes.debug) applyDebug(changes.debug.newValue);
      if (changes.settings || changes.activeLists) {
        await loadSettings();
        analyzeSubtitles();
        replan();
        tick();
      }
    });
  }

  // ---- go -------------------------------------------------------------------------------

  let identifyTimer = 0;
  function shutdown() {
    clearInterval(identifyTimer);
    stopTicking();
    restorePlayback();
    overlay.destroy();
    hookPort?.close();
    window.__cleancutContent = false; // a fresh copy (after the extension reloads) may start
  }

  loadSettings().then(() => {
    identify();
    identifyTimer = setInterval(identify, IDENTIFY_MS);
  });
})();
