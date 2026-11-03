// Content script: identifies what is playing, gathers segments (community
// database, your own tags, scan-ahead subtitle analysis), and drives the
// <video> element — skip, mute, blur — according to the active profile.

import { buildPlan, decide, skippedSeconds } from '../../../shared/engine.js';
import { analyzeCues } from '../../../shared/analyzer.js';
import { detectFormat, parseSubtitles, ttmlLanguage } from '../../../shared/subtitles.js';
import { displayTitle, formatTime, titleKey } from '../../../shared/identity.js';
import { CATEGORIES, SEVERITIES, defaultProfile, describeProfile } from '../../../shared/ratings.js';
import { detectAdapter } from './adapters.js';
import { CATEGORY_COLORS, Overlay } from './overlay.js';

(() => {
  if (window.__cleancutContent) return;
  window.__cleancutContent = true;

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

  // Netflix seeks go through the page-world player API (see page-hook.js).
  const pendingSeeks = new Map();
  let seekSeq = 0;
  const bridge = {
    seek(seconds) {
      const reqId = ++seekSeq;
      window.postMessage({ __cleancut: 'content', type: 'seek', seconds, reqId }, location.origin);
      return new Promise((resolve) => {
        pendingSeeks.set(reqId, resolve);
        setTimeout(() => {
          if (pendingSeeks.delete(reqId)) resolve(false);
        }, 1000);
      });
    },
  };

  const adapter = detectAdapter(bridge);
  const overlay = new Overlay();

  // ---- state ---------------------------------------------------------------

  const state = {
    settings: { enabled: true, profile: defaultProfile() },
    activeLists: {},
    ident: null,
    key: null,
    remote: [],
    local: [],
    subtitle: [],
    subtitleInfo: null, // { cues, sdh, url }
    pendingSubs: new Map(), // forId → payload, for tracks that arrive before/after their episode
    profiles: [],
    borrowedFrom: null,
    online: null,
    lookupError: null,
    offset: 0,
    plan: null,
    disabled: new Set(),
    video: null,
    mutedByUs: false,
    captionsHidden: false,
    prevMuted: false,
    blurred: false,
    lastSeek: null,
    markStart: null,
    stats: { skips: 0, mutes: 0 },
  };

  // ---- styles for blur and caption hiding (page DOM, not shadow) -------------

  const style = document.createElement('style');
  style.textContent = `
    video.cleancut-blur { filter: blur(48px) saturate(.3) brightness(.7) !important; transition: filter .15s; }
    .cleancut-hide-captions { visibility: hidden !important; }`;
  (document.head || document.documentElement).append(style);

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
    return state.activeLists[state.key] || (state.ident.canonicalKey && state.activeLists[`ck:${state.ident.canonicalKey}`]) || state.activeLists['*'] || null;
  }

  function effectiveProfile() {
    const list = activeList();
    return list ? { ...state.settings.profile, ...list.settings } : state.settings.profile;
  }

  // ---- planning --------------------------------------------------------------

  function analyzeSubtitles() {
    if (!state.subtitleInfo) return;
    state.subtitle = analyzeCues(state.subtitleInfo.cues, { languageMode: effectiveProfile().languageMode });
  }

  function replan() {
    const shift = (s) => ({ ...s, start: s.start + state.offset, end: s.end + state.offset });
    const all = [...state.remote.map(shift), ...state.local, ...state.subtitle];
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
      Object.assign(state, { remote: [], local: [], subtitle: [], subtitleInfo: null, profiles: [], borrowedFrom: null, disabled: new Set(), lastSeek: null, markStart: null });
      const pending = state.pendingSubs.get(ident.platformId) || state.pendingSubs.get('__unassigned');
      if (pending) handleSubtitles(pending, true);
      state.pendingSubs.clear();
      const { offsets } = alive() ? await chrome.storage.local.get('offsets') : {};
      state.offset = offsets?.[key] || 0;
      replan();
    }

    const res = await bg({ type: 'lookup', title: { ...ident.meta, platform: ident.platform, platformId: ident.platformId, canonicalKey: ident.canonicalKey } });
    if (state.key !== key) return; // navigated away meanwhile
    state.remote = res?.remote || [];
    state.local = res?.local || [];
    state.profiles = res?.profiles || [];
    state.borrowedFrom = res?.borrowedFrom || null;
    state.online = !!res?.online;
    state.lookupError = res?.error || null;
    replan();
    if (refresh) return;
    if (state.settings.enabled && state.remote.length + state.local.length) {
      const n = state.remote.length + state.local.length;
      overlay.toast(`${displayTitle(ident.meta)} · ${n} tagged scene${n === 1 ? '' : 's'} · filtering at ${activeList()?.name || describeProfile(effectiveProfile())}`, { ms: 4000 });
    }
    if (state.borrowedFrom) {
      overlay.toast(`Tags borrowed from ${state.borrowedFrom.platform}; adjust sync in the CleanCut popup if cuts land early or late.`, { ms: 8000, color: '#f9a825' });
    }
  }

  function identify() {
    const video = adapter.findVideo();
    if (video !== state.video) attachVideo(video);
    overlay.attach();
    overlay.position();
    if (!video) return;
    const ident = adapter.identify();
    if (!ident) return;
    const key = titleKey(ident.platform, ident.platformId);
    if (key !== state.key) {
      loadTitle(ident);
    } else if (ident.canonicalKey && !state.ident.canonicalKey) {
      // Metadata arrived after the first lookup: retry so cross-platform tags can be found.
      loadTitle(ident, { refresh: true });
    }
    if (!state.subtitleInfo && adapter.readTextTracks) {
      const cues = adapter.readTextTracks(video);
      if (cues?.length) {
        state.subtitleInfo = { cues, sdh: false, url: 'textTracks' };
        analyzeSubtitles();
        replan();
      }
    }
  }

  function attachVideo(video) {
    restorePlayback();
    state.video = video;
    overlay.setVideo(video);
    if (!video) return;
    video.addEventListener('seeking', tick);
    video.addEventListener('loadedmetadata', () => replan());
  }

  // ---- subtitles (scan-ahead) ---------------------------------------------------

  function handleSubtitles(payload, force = false) {
    const { text, forId, sdh, url } = payload;
    if (!force && !state.ident) {
      state.pendingSubs.set(forId || '__unassigned', payload);
      return;
    }
    if (!force && forId && forId !== state.ident.platformId) {
      state.pendingSubs.set(forId, payload); // next episode prefetch
      return;
    }
    const format = detectFormat(text);
    if (format === 'ttml') {
      const lang = ttmlLanguage(text);
      if (lang && !/^en\b/i.test(lang)) return;
    }
    if (state.subtitleInfo?.url === url) return; // already analyzed (replayed message)
    if (state.subtitleInfo?.sdh && !sdh) return; // keep the richer SDH track
    const cues = parseSubtitles(text);
    if (cues.length < 5) return;
    state.subtitleInfo = { cues, sdh: !!sdh || cues.some((c) => /\[[^\]]+\]/.test(c.text)), url };
    analyzeSubtitles();
    replan();
    const found = state.subtitle.length;
    if (found) overlay.toast(`Scanned ahead: ${found} possible issue${found === 1 ? '' : 's'} found in subtitles`, { ms: 3500, color: '#7cb342' });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__cleancut !== 'page') return;
    const { type, payload } = e.data;
    if (type === 'subtitles' && typeof payload?.text === 'string') handleSubtitles(payload);
    else if (type === 'seek-result') {
      const resolve = pendingSeeks.get(payload?.reqId);
      if (resolve) {
        pendingSeeks.delete(payload.reqId);
        resolve(!!payload.ok);
      }
    } else adapter.onPageMessage(type, payload);
  });

  // ---- the playback loop ----------------------------------------------------------

  function reasonText(reasons) {
    return reasons.map((r) => `${label(r.category).toLowerCase()} (${SEVERITIES[r.severity]})`).join(', ');
  }

  function setCaptionsHidden(hidden) {
    state.captionsHidden = hidden;
    if (!adapter.captionSelector) return;
    for (const el of document.querySelectorAll(adapter.captionSelector)) el.classList.toggle('cleancut-hide-captions', hidden);
  }

  function restorePlayback() {
    const v = state.video;
    if (v && state.mutedByUs) v.muted = state.prevMuted;
    if (v && state.blurred) v.classList.remove('cleancut-blur');
    state.mutedByUs = false;
    state.blurred = false;
    if (state.captionsHidden) setCaptionsHidden(false);
  }

  // Runs every 100 ms while playing, and on every seek (event argument).
  function tick(event) {
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

    if (d.skipTo !== null) {
      const now = performance.now();
      const target = Number.isFinite(duration) ? Math.min(d.skipTo, duration - 0.25) : d.skipTo;
      const recent = state.lastSeek && Math.abs(state.lastSeek.target - target) < 0.5 && now - state.lastSeek.at < 2500;
      if (!recent) {
        state.lastSeek = { target, at: now };
        const region = d.skipRegion;
        adapter.seek(video, target);
        state.stats.skips++;
        overlay.toast(`Skipped ${formatTime(target - Math.max(t, region.start))} · ${reasonText(region.reasons)}`, {
          color: CATEGORY_COLORS[region.reasons[0]?.category],
          actionLabel: 'Undo',
          onAction: () => {
            state.disabled.add(region.key);
            state.lastSeek = null;
            adapter.seek(video, region.start);
          },
        });
      }
    }

    const hideCaptions = effectiveProfile().hideCaptionsWhileMuted !== false;
    if (d.mute && !state.mutedByUs) {
      state.prevMuted = video.muted;
      video.muted = true;
      state.mutedByUs = true;
      state.stats.mutes++;
      if (hideCaptions) setCaptionsHidden(true);
    } else if (!d.mute && state.mutedByUs) {
      video.muted = state.prevMuted;
      state.mutedByUs = false;
      setCaptionsHidden(false);
    } else if (d.mute && hideCaptions) {
      setCaptionsHidden(true); // players re-render caption nodes constantly
    }

    if (d.blur !== state.blurred) {
      video.classList.toggle('cleancut-blur', d.blur);
      state.blurred = d.blur;
    }
  }

  // ---- tagging ----------------------------------------------------------------------

  function markStart() {
    if (!state.video) return { error: 'no video' };
    state.markStart = adapter.currentTime(state.video);
    overlay.toast(`Tag start at ${formatTime(state.markStart)} — press Alt+] at the end of the scene`, { color: '#4f7cff' });
    return { ok: true, start: state.markStart };
  }

  async function markEnd() {
    const video = state.video;
    if (!video || !state.ident) return { error: 'no video' };
    if (state.markStart == null) {
      overlay.toast('Press Alt+[ at the start of the scene first');
      return { error: 'no start mark' };
    }
    let start = state.markStart;
    let end = adapter.currentTime(video);
    if (end < start) [start, end] = [end, start];
    if (end - start < 0.5) end = start + 0.5;
    state.markStart = null;
    const wasPlaying = !video.paused;
    video.pause();
    const { apiKey } = alive() ? await chrome.storage.local.get('apiKey') : {};
    const answer = await overlay.openTagForm({ start, end, canShare: !!apiKey });
    if (wasPlaying) video.play().catch(() => {});
    if (!answer) return { cancelled: true };
    const res = await bg({
      type: 'saveTag',
      title: { ...state.ident.meta, platform: state.ident.platform, platformId: state.ident.platformId, canonicalKey: state.ident.canonicalKey, duration: video.duration },
      segment: { start, end, category: answer.category, severity: answer.severity, note: answer.note },
      share: answer.share,
    });
    if (res?.segment) {
      state.local.push(res.segment);
      replan();
      overlay.toast(res.shared ? 'Tag saved and shared — thank you!' : `Tag saved locally${res.shareError ? ` (sharing failed: ${res.shareError})` : ''}`, { color: '#7cb342' });
    } else overlay.toast(`Could not save tag: ${res?.error || 'unknown error'}`, { color: '#e53935' });
    return res;
  }

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'BracketLeft') {
      e.preventDefault();
      e.stopPropagation();
      markStart();
    } else if (e.code === 'BracketRight') {
      e.preventDefault();
      e.stopPropagation();
      markEnd();
    }
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
      borrowedFrom: state.borrowedFrom,
      counts: {
        community: count((s) => s === 'community' || s === 'scanner'),
        local: count((s) => s === 'local'),
        subtitles: count((s) => s === 'subtitles'),
      },
      subtitle: state.subtitleInfo ? { cues: state.subtitleInfo.cues.length, sdh: state.subtitleInfo.sdh } : null,
      actions: plan?.actions || [],
      flagged: plan?.flagged || [],
      skipped: plan ? skippedSeconds(plan.actions, v?.duration) : 0,
      disabled: [...state.disabled],
      profiles: state.profiles,
      activeList: list ? { id: list.id, name: list.name, scope: list.scope } : null,
      profileLabel: list ? list.name : describeProfile(effectiveProfile()),
      markStart: state.markStart,
      stats: state.stats,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case 'getState':
          return snapshot();
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
        case 'markStart':
          return markStart();
        case 'markEnd':
          markEnd();
          return { ok: true };
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
      if (changes.settings || changes.activeLists) {
        await loadSettings();
        analyzeSubtitles();
        replan();
        tick();
      }
    });
  }

  // ---- go -------------------------------------------------------------------------------

  loadSettings().then(() => {
    // Ask the page hook to replay anything it captured before we loaded.
    window.postMessage({ __cleancut: 'content', type: 'hello' }, location.origin);
    identify();
    setInterval(identify, IDENTIFY_MS);
    setInterval(tick, TICK_MS);
  });
  window.addEventListener('resize', () => overlay.position());
})();
