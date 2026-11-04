// On-player UI in a shadow root. Everything CleanCut shows on a player lives
// in one place, a rail on the right edge of the picture, vertically centred:
// the middle band of the frame is the one part none of the supported sites
// puts controls in (Netflix and Prime keep theirs along the top and bottom
// edges, YouTube along the bottom and, in fullscreen, the top). From the top:
// toasts ("Skipped 0:10 · Undo"), the status badge, the flag control
// (flagger.js) at the centre, and the flag picker over all of them. A timeline
// strip of flagged scenes runs along the bottom edge.
//
// Colours, radii and type are the popup's dark theme (popup.css), so the
// player and the popup read as one product.

export const CATEGORY_COLORS = {
  nudity: '#e0569b',
  sex: '#c2185b',
  violence: '#e53935',
  gore: '#8e0000',
  language: '#f9a825',
  drugs: '#7cb342',
  frightening: '#5e35b1',
};

/** The popup's note icons, also used by toasts that are not about a category. */
export const NOTE_ICONS = {
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 15 14H1L8 1.8Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.2v3.6M8 11.6v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.2v4M8 4.6v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

const STYLE = `
:host { all: initial; }
.root {
  /* popup.css, dark theme */
  --surface: rgba(25, 26, 32, .94);
  --surface-solid: rgba(25, 26, 32, .98);
  --raised: rgba(255, 255, 255, .08);
  --raised-hover: rgba(255, 255, 255, .14);
  --line: rgba(255, 255, 255, .14);
  --line-strong: rgba(255, 255, 255, .26);
  --text: #ececf1;
  --muted: #a2a7b4;
  --accent: #3d68f0;
  --accent-hover: #4c75f7;
  --on-accent: #ffffff;
  --link: #8fb0ff;
  --focus: #8fb0ff;
  --warn: #f5c86a;
  --bad: #ff8a80;
  --r-sm: 6px; --r-md: 8px; --r-lg: 12px;
  --fs-xs: 11px; --fs-sm: 12px; --fs-md: 13px; --fs-body: 14px; --fs-lg: 15px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --shadow: 0 8px 28px rgba(0, 0, 0, .45);
  position: fixed; pointer-events: none; z-index: 2147483646;
  font: var(--fs-body)/1.35 var(--font); color: var(--text); -webkit-font-smoothing: antialiased;
}
/* The rail: toasts and badge above the centre line, the flag control on it. */
.side { position: absolute; inset: 12px 16px; display: grid; grid-template-rows: minmax(0, 1fr) auto minmax(0, 1fr);
  justify-items: end; row-gap: 8px; pointer-events: none; }
.above { grid-row: 1; align-self: stretch; min-height: 0; max-width: 100%; display: flex; flex-direction: column; justify-content: flex-end;
  align-items: flex-end; gap: 8px; }
.side.picking .above { visibility: hidden; }
.toasts { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: min(440px, 100%); }
.toasts:empty { display: none; }
.toast { pointer-events: auto; box-sizing: border-box; max-width: 100%; min-height: 40px; display: flex; gap: 10px; align-items: center;
  padding: 7px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow);
  animation: in .18s ease-out; }
.toast.has-action { padding-right: 6px; }
.toast .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.toast svg { width: 16px; height: 16px; flex: none; }
.toast[data-tone=info] svg { color: var(--link); }
.toast[data-tone=warn] svg { color: var(--warn); }
.toast[data-tone=bad] svg { color: var(--bad); }
.toast .text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.toast .detail { font-size: var(--fs-sm); color: var(--muted); }
.toast button { all: unset; box-sizing: border-box; flex: none; min-width: 44px; height: 32px; padding: 0 10px; border-radius: var(--r-md);
  text-align: center; font: 600 var(--fs-md)/32px var(--font); color: var(--link); cursor: pointer; }
.toast button:hover { background: var(--raised-hover); }
.toast button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
@keyframes in { from { opacity: 0; transform: translateY(4px); } }
.badge { max-width: 100%; box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 500 var(--fs-sm)/16px var(--font); padding: 4px 10px; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--line); color: var(--text); opacity: 0; transition: opacity .25s; }
/* A dark track and an outlined playhead: legible over a bright frame as well as a dark one. */
.timeline { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; background: rgba(18, 18, 22, .62); opacity: 0; transition: opacity .25s; }
.mark { position: absolute; top: 0; bottom: 0; min-width: 2px; }
.mark.suggested { background-image: repeating-linear-gradient(45deg, rgba(0,0,0,.45) 0 3px, transparent 3px 6px); opacity: .75; }
.mark.allowed, .mark.allowed-by-list { opacity: .3; }
.pending { position: absolute; top: -2px; bottom: -2px; min-width: 3px; border-radius: 2px; background: var(--link); box-shadow: 0 0 0 1px #fff; }
.playhead { position: absolute; top: -3px; bottom: -3px; left: 0; width: 100%; will-change: transform; }
.playhead::before { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 2px; background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .6); }
.root.revealed .timeline, .root.revealed .badge { opacity: 1; }
/* While the site plays an ad CleanCut does nothing, so it shows nothing about the episode. */
.root.ad .timeline { visibility: hidden; }
.cover { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 8px 14px; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--line); font-size: var(--fs-md); color: var(--muted); }
`;

/**
 * Clicks on our controls stay ours. In fullscreen the overlay sits inside the
 * site's player, whose click toggles pause and whose double click toggles
 * fullscreen. Listeners on our own elements only, never on the page.
 */
export function containPointer(el) {
  const keep = (e) => e.stopPropagation();
  for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'contextmenu']) {
    el.addEventListener(type, keep);
  }
}

export class Overlay {
  /**
   * @param {{ fillViewport?: boolean }} [opts] fillViewport: the player fills the
   *   window (Netflix, Prime), so the overlay covers the viewport with CSS and
   *   never has to measure the video.
   */
  constructor({ fillViewport = false } = {}) {
    this.fillViewport = fillViewport;
    this.host = document.createElement('cleancut-overlay');
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow.innerHTML = `<style>${STYLE}</style>
      <div class="root">
        <div class="cover" hidden></div>
        <div class="side"><div class="above"><div class="toasts"></div><div class="badge"></div></div></div>
        <div class="timeline"><div class="pending" hidden></div><div class="playhead"></div></div>
      </div>`;
    this.root = this.shadow.querySelector('.root');
    this.side = this.shadow.querySelector('.side');
    this.toasts = this.shadow.querySelector('.toasts');
    this.timeline = this.shadow.querySelector('.timeline');
    this.pending = this.shadow.querySelector('.pending');
    this.playhead = this.shadow.querySelector('.playhead');
    this.badge = this.shadow.querySelector('.badge');
    this.cover = this.shadow.querySelector('.cover');
    this.video = null;
    // Toasts shown, oldest first. Kept here so deciding what to show never
    // reads the DOM; the elements follow in the next frame (syncToasts).
    this.toastList = [];
    // Above the badge there is room for three on a player that fills the
    // window, two on a smaller one (YouTube's default layout).
    this.maxToasts = fillViewport ? 3 : 2;
    this.ad = false;
    this.hideTimer = null;
    this.fadeTimer = null;
    this.hideAt = 0;
    // Reasons to stay revealed past the hide timer (the flag picker is open,
    // the pointer rests on the flag control), and reasons to stay displayed
    // without being revealed (the recording indicator).
    this.revealHolds = new Set();
    this.displayHolds = new Set();
    /** Called after the overlay moved into or out of a fullscreen element. */
    this.onReparent = null;
    // Nothing is rendered over the video unless there is something to show:
    // an element composited on top of a playing video costs GPU time on every
    // frame and can stop the browser handing the video to a hardware overlay.
    this.revealed = false;
    this.shown = false; // tracked here so deciding never reads the DOM
    this.lastReveal = 0;
    this.lastRect = '';
    this.lastPlayhead = '';
    this.root.style.display = 'none';
    if (fillViewport) Object.assign(this.root.style, { left: '0', top: '0', width: '100vw', height: '100vh' });
    // DOM work is batched into one animation frame: measure first (if needed),
    // then write. Reading layout after writing, or at a random timer tick
    // after the page changed, would force a synchronous layout of the page.
    this.writes = new Map();
    this.needsMeasure = false;
    this.raf = 0;
    this.onMove = () => {
      const now = performance.now();
      if (now - this.lastReveal > 250) this.reveal(); // mousemove fires ~60×/s
    };
    this.onFullscreen = () => {
      this.attach();
      this.remeasure();
      this.onReparent?.();
    };
    containPointer(this.toasts);
    this.onResize = () => this.remeasure();
    // Re-measure only when the video's box changes, never by polling: reading
    // layout while the player's controls are animating forces a synchronous
    // layout of the whole page.
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.remeasure()) : null;
    this.lastPlayheadAt = 0;
    this.attached = false;
    // Nothing is added to the page until there is a player to cover: attach()
    // is called once a video is found, detach() when it goes away.
  }

  attach() {
    if (!this.attached) {
      this.attached = true;
      document.addEventListener('mousemove', this.onMove, { passive: true });
      document.addEventListener('fullscreenchange', this.onFullscreen);
      window.addEventListener('resize', this.onResize);
    }
    // In fullscreen only the fullscreen element's subtree is visible.
    const parent = document.fullscreenElement || document.documentElement;
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
  }

  /** No player any more (single-page navigation away from it): leave the page as it was. */
  detach() {
    if (!this.attached) return;
    this.attached = false;
    document.removeEventListener('mousemove', this.onMove);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    window.removeEventListener('resize', this.onResize);
    clearTimeout(this.hideTimer);
    clearTimeout(this.fadeTimer);
    this.revealed = false;
    this.hideAt = 0;
    this.revealHolds.clear();
    this.displayHolds.clear();
    this.shown = false;
    this.root.style.display = 'none';
    this.root.classList.remove('revealed');
    this.host.remove();
  }

  // ---- frame batching -----------------------------------------------------------------

  /** Queue a DOM write for the next frame; a later write with the same key replaces it. */
  write(key, fn) {
    this.writes.set(key, fn);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  flush() {
    this.raf = 0;
    // Read phase: at most one measurement per frame, and only for players
    // that do not fill the window.
    let rect = null;
    if (this.needsMeasure && this.shown && !this.fillViewport && this.video?.isConnected) {
      const r = this.video.getBoundingClientRect();
      rect = `${r.left}|${r.top}|${r.width}|${r.height}`;
      if (rect !== this.lastRect) {
        this.lastRect = rect;
        this.writes.set('rect', () => Object.assign(this.root.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` }));
      }
    }
    this.needsMeasure = false;
    // Write phase.
    const writes = [...this.writes.values()];
    this.writes.clear();
    for (const fn of writes) fn();
  }

  // ---- state ------------------------------------------------------------------------------

  setVideo(video) {
    if (this.video && this.resizeObserver) this.resizeObserver.unobserve(this.video);
    this.video = video;
    if (video && this.resizeObserver && !this.fillViewport) this.resizeObserver.observe(video);
    this.lastRect = '';
    this.updateVisibility();
  }

  /** The video's box may have changed: measure again in the next frame (if shown). */
  remeasure() {
    if (this.fillViewport) return;
    this.lastRect = '';
    this.needsMeasure = true;
    this.write('noop', () => {});
  }

  get visible() {
    return this.shown;
  }

  /** Show the overlay only while a toast, the flag control or the revealed timeline needs it. */
  updateVisibility() {
    const wanted = !!(this.video?.isConnected && (this.revealed || this.revealHolds.size || this.displayHolds.size
      || this.toastList.length || !this.cover.hidden));
    if (wanted === this.shown) return;
    this.shown = wanted;
    this.write('display', () => {
      this.root.style.display = this.shown ? 'block' : 'none';
    });
    if (wanted) {
      this.lastPlayhead = '';
      this.remeasure();
    }
  }

  /** Kept for callers; measuring now always happens inside a frame. */
  position() {
    this.remeasure();
  }

  /** Show the timeline, badge and flag control for at least `ms` from now. */
  reveal(ms = 2500) {
    const now = performance.now();
    this.lastReveal = now;
    const until = now + ms;
    if (!this.revealed) {
      this.revealed = true;
      this.updateVisibility();
      this.writeRevealed();
    } else if (until <= this.hideAt) return; // already revealed for longer
    this.hideAt = until;
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.conceal(), ms);
  }

  conceal() {
    if (this.revealHolds.size) return; // releasing the last hold calls reveal() again
    this.revealed = false;
    this.hideAt = 0;
    this.writeRevealed();
    clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => this.updateVisibility(), 300); // after the fade-out
  }

  writeRevealed() {
    this.write('reveal', () => this.root.classList.toggle('revealed', this.revealed));
  }

  /**
   * Stay revealed while `reason` holds (a picker is open, the pointer rests on
   * the flag control); releasing it restarts the normal hide timer.
   */
  holdReveal(reason, on) {
    if (on) {
      this.revealHolds.add(reason);
      this.reveal();
    } else if (this.revealHolds.delete(reason)) this.reveal();
  }

  /** Stay displayed, though not necessarily revealed, while `reason` holds (the recording indicator). */
  holdDisplay(reason, on) {
    if (on) this.displayHolds.add(reason);
    else this.displayHolds.delete(reason);
    this.updateVisibility();
  }

  /** Label shown while the picture is hidden; null removes it. */
  setCover(text) {
    this.coverText = text || '';
    this.cover.hidden = !text; // read by updateVisibility; the element is inside our hidden shadow root
    this.write('cover', () => {
      this.cover.textContent = this.coverText;
    });
    this.updateVisibility();
  }

  setBadge(textContent) {
    if (textContent === this.badgeText) return;
    this.badgeText = textContent;
    this.write('badge', () => {
      this.badge.textContent = this.badgeText;
    });
  }

  /** @param {Array} flagged segments with decision, @param {number} duration */
  renderTimeline(flagged, duration) {
    this.write('timeline', () => {
      for (const m of this.timeline.querySelectorAll('.mark')) m.remove();
      if (!duration || !Number.isFinite(duration)) return;
      const frag = document.createDocumentFragment();
      for (const seg of flagged) {
        const el = document.createElement('div');
        el.className = `mark ${seg.decision}`;
        el.style.left = `${(seg.start / duration) * 100}%`;
        el.style.width = `${(Math.max(0.5, seg.end - seg.start) / duration) * 100}%`;
        el.style.background = CATEGORY_COLORS[seg.category] || '#999';
        frag.append(el);
      }
      this.timeline.insertBefore(frag, this.playhead);
    });
  }

  // A transform on its own compositor layer: moving it needs no layout, and
  // four updates a second is plenty for a 6 px strip.
  setPlayhead(time, duration) {
    if (!this.revealed || !(duration > 0)) return;
    const now = performance.now();
    if (now - this.lastPlayheadAt < 250) return;
    this.lastPlayheadAt = now;
    const pos = `translateX(${((time / duration) * 100).toFixed(2)}%)`;
    if (pos === this.lastPlayhead) return;
    this.lastPlayhead = pos;
    this.write('playhead', () => {
      this.playhead.style.transform = this.lastPlayhead;
    });
  }

  /** The range being flagged, drawn on the timeline; null removes it. */
  setPending(start, end, duration) {
    const show = start != null && duration > 0 && Number.isFinite(duration);
    const left = show ? `${(Math.max(0, start) / duration) * 100}%` : '';
    const width = show ? `${(Math.max(0, end - start) / duration) * 100}%` : '';
    this.write('pending', () => {
      this.pending.hidden = !show;
      if (show) Object.assign(this.pending.style, { left, width });
    });
  }

  /**
   * A short message above the badge; the newest sits nearest the flag control.
   * @param {string} message what happened, in a few words
   * @param {{ color?: string, tone?: 'info'|'warn'|'bad', detail?: string|string[],
   *   actionLabel?: string, onAction?: Function, ms?: number }} [o]
   *   color: a category's colour (a dot, as in the popup's list of cuts);
   *   otherwise tone picks the popup's info or warning icon.
   */
  toast(message, { color, tone = 'info', detail, actionLabel, onAction, ms = 5000 } = {}) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    if (color) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = color;
      el.append(dot);
    } else {
      el.dataset.tone = tone;
      el.insertAdjacentHTML('beforeend', NOTE_ICONS[tone === 'info' ? 'info' : 'warn']);
    }
    const text = document.createElement('span');
    text.className = 'text';
    const label = document.createElement('span');
    label.textContent = message;
    text.append(label);
    for (const line of [].concat(detail || [])) {
      const sub = document.createElement('span');
      sub.className = 'detail';
      sub.textContent = line;
      text.append(sub);
    }
    el.append(text);
    const drop = () => {
      const i = this.toastList.indexOf(el);
      if (i < 0) return;
      this.toastList.splice(i, 1);
      this.syncToasts();
    };
    if (actionLabel) {
      el.classList.add('has-action');
      const b = document.createElement('button');
      b.textContent = actionLabel;
      b.addEventListener('click', () => {
        onAction?.();
        drop();
      });
      el.append(b);
    }
    this.toastList.push(el);
    if (this.toastList.length > this.maxToasts) this.toastList.splice(0, this.toastList.length - this.maxToasts);
    this.syncToasts();
    // It stays while the pointer is on it (reaching for Undo), and goes a moment after it leaves.
    let timer = setTimeout(drop, ms);
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => {
      clearTimeout(timer);
      timer = setTimeout(drop, 2000);
    });
    return el;
  }

  /** Bring the toast elements in line with toastList in the next frame (shown ones stay put, so their animation does not replay). */
  syncToasts() {
    this.write('toasts', () => {
      for (const el of [...this.toasts.children]) if (!this.toastList.includes(el)) el.remove();
      for (const el of this.toastList) if (el.parentNode !== this.toasts) this.toasts.append(el);
    });
    this.updateVisibility();
  }

  /** An ad is playing: hide the timeline (it would be measured against the ad) and the flag control. */
  setAd(on) {
    if (on === this.ad) return;
    this.ad = on;
    this.write('ad', () => this.root.classList.toggle('ad', this.ad));
  }

  destroy() {
    this.detach();
    this.resizeObserver?.disconnect();
  }
}
