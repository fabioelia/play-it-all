// On-player UI in a shadow root: toasts ("Skipped 0:42 · Undo") top right, a
// timeline strip of tagged segments along the bottom, and a rail on the right
// edge, clear of the site's back button and control bar, that holds the
// status badge and the flag control (flagger.js).

export const CATEGORY_COLORS = {
  nudity: '#e0569b',
  sex: '#c2185b',
  violence: '#e53935',
  gore: '#8e0000',
  language: '#f9a825',
  drugs: '#7cb342',
  frightening: '#5e35b1',
};

const STYLE = `
:host { all: initial; }
.root { position: fixed; pointer-events: none; z-index: 2147483646; font: 14px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
  -webkit-font-smoothing: antialiased; }
.toasts { position: absolute; top: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; max-width: 60%; }
.toast { pointer-events: auto; background: rgba(18,18,22,.92); border: 1px solid rgba(255,255,255,.14); border-radius: 12px;
  padding: 9px 12px; display: flex; gap: 10px; align-items: center; box-shadow: 0 6px 24px rgba(0,0,0,.4); animation: in .18s ease-out; }
.toast .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: flex-start; margin-top: 6px; }
.toast .text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.toast .detail { font-size: 12px; color: rgba(255,255,255,.66); }
.toast button { all: unset; cursor: pointer; color: #8ab4ff; font-weight: 600; padding: 2px 4px; margin: -2px -4px -2px 4px; border-radius: 6px; }
.toast button:hover { text-decoration: underline; }
.toast button:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 1px; }
@keyframes in { from { opacity: 0; transform: translateY(-6px); } }
.timeline { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; background: rgba(255,255,255,.12); opacity: 0; transition: opacity .25s; }
.mark { position: absolute; top: 0; bottom: 0; min-width: 2px; }
.mark.suggested { background-image: repeating-linear-gradient(45deg, rgba(0,0,0,.45) 0 3px, transparent 3px 6px); opacity: .75; }
.mark.allowed, .mark.allowed-by-list { opacity: .28; }
.pending { position: absolute; top: -2px; bottom: -2px; min-width: 3px; border-radius: 2px; background: #7da0ff; box-shadow: 0 0 0 1px #fff; }
.playhead { position: absolute; top: -3px; bottom: -3px; left: 0; width: 100%; will-change: transform; }
.playhead::before { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 2px; background: #fff; }
.side { position: absolute; inset: 12px 16px; display: flex; flex-direction: column; justify-content: center; align-items: flex-end; gap: 8px; pointer-events: none; }
.badge { max-width: 100%; box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; padding: 4px 10px;
  border-radius: 999px; background: rgba(18,18,22,.82); border: 1px solid rgba(255,255,255,.14); color: rgba(255,255,255,.9); opacity: 0; transition: opacity .25s; }
.side.picking .badge { display: none; }
.root.revealed .timeline, .root.revealed .badge { opacity: 1; }
.cover { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 8px 14px; border-radius: 999px;
  background: rgba(30,30,36,.9); border: 1px solid rgba(255,255,255,.14); font-size: 13px; color: #ddd; }
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
        <div class="side"><div class="badge"></div></div>
        <div class="cover" hidden></div>
        <div class="toasts"></div>
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
      || this.toasts.childElementCount || !this.cover.hidden));
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

  toast(message, { color = '#4f7cff', detail, actionLabel, onAction, ms = 5000 } = {}) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = color;
    const label = document.createElement('span');
    label.textContent = message;
    if (detail) {
      const text = document.createElement('span');
      text.className = 'text';
      const sub = document.createElement('span');
      sub.className = 'detail';
      sub.textContent = detail;
      text.append(label, sub);
      el.append(dot, text);
    } else el.append(dot, label);
    if (actionLabel) {
      const b = document.createElement('button');
      b.textContent = actionLabel;
      b.addEventListener('click', () => {
        onAction?.();
        el.remove();
        this.updateVisibility();
      });
      el.append(b);
    }
    this.toasts.append(el);
    while (this.toasts.children.length > 3) this.toasts.firstChild.remove();
    this.updateVisibility();
    setTimeout(() => {
      el.remove();
      this.updateVisibility();
    }, ms);
    return el;
  }

  destroy() {
    this.detach();
    this.resizeObserver?.disconnect();
  }
}
