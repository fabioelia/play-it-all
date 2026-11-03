// On-player UI in a shadow root: toasts ("Skipped 0:42 · Undo"), a
// timeline strip of tagged segments, and the quick-tag form.

import { CATEGORIES, SEVERITIES } from '../../../shared/ratings.js';
import { formatTime } from '../../../shared/identity.js';

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
.root { position: fixed; pointer-events: none; z-index: 2147483646; font: 14px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; }
.toasts { position: absolute; top: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; max-width: 60%; }
.toast { pointer-events: auto; background: rgba(20,20,24,.88); border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
  padding: 8px 12px; display: flex; gap: 10px; align-items: center; box-shadow: 0 6px 24px rgba(0,0,0,.4); animation: in .18s ease-out; }
.toast .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.toast button { all: unset; cursor: pointer; color: #8ab4ff; font-weight: 600; }
.toast button:hover { text-decoration: underline; }
@keyframes in { from { opacity: 0; transform: translateY(-6px); } }
.timeline { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; background: rgba(255,255,255,.12); opacity: 0; transition: opacity .25s; }
.timeline.show { opacity: 1; }
.mark { position: absolute; top: 0; bottom: 0; min-width: 2px; }
.mark.suggested { background-image: repeating-linear-gradient(45deg, rgba(0,0,0,.45) 0 3px, transparent 3px 6px); opacity: .75; }
.mark.allowed, .mark.allowed-by-list { opacity: .28; }
.playhead { position: absolute; top: -3px; bottom: -3px; left: 0; width: 100%; will-change: transform; }
.playhead::before { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 2px; background: #fff; }
.badge { position: absolute; left: 12px; top: 12px; font-size: 12px; padding: 3px 8px; border-radius: 999px; background: rgba(20,20,24,.75);
  border: 1px solid rgba(255,255,255,.14); opacity: 0; transition: opacity .25s; }
.badge.show { opacity: 1; }
.cover { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 8px 14px; border-radius: 999px;
  background: rgba(30,30,36,.9); border: 1px solid rgba(255,255,255,.14); font-size: 13px; color: #ddd; }
.form { pointer-events: auto; position: absolute; left: 50%; bottom: 56px; transform: translateX(-50%); width: min(420px, 92%);
  background: rgba(20,20,24,.95); border: 1px solid rgba(255,255,255,.18); border-radius: 12px; padding: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
.form h3 { margin: 0 0 10px; font-size: 15px; }
.form .row { display: flex; gap: 8px; margin: 8px 0; align-items: center; flex-wrap: wrap; }
.form label { font-size: 12px; color: #bbb; }
.form select, .form input[type=text] { font: inherit; background: #2a2a30; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 5px 8px; }
.form input[type=text] { flex: 1; min-width: 0; }
.chip { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px; border: 1px solid #555; font-size: 13px; }
.chip[aria-pressed=true] { background: #fff; color: #111; border-color: #fff; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.btn { all: unset; cursor: pointer; padding: 6px 14px; border-radius: 8px; background: #333; font-weight: 600; }
.btn.primary { background: #4f7cff; }
.btn:focus-visible, .chip:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 2px; }
`;

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
        <div class="badge"></div>
        <div class="cover" hidden></div>
        <div class="toasts"></div>
        <div class="timeline"><div class="playhead"></div></div>
      </div>`;
    this.root = this.shadow.querySelector('.root');
    this.toasts = this.shadow.querySelector('.toasts');
    this.timeline = this.shadow.querySelector('.timeline');
    this.playhead = this.shadow.querySelector('.playhead');
    this.badge = this.shadow.querySelector('.badge');
    this.cover = this.shadow.querySelector('.cover');
    this.video = null;
    this.hideTimer = null;
    this.form = null;
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
    document.addEventListener('mousemove', this.onMove, { passive: true });
    document.addEventListener('fullscreenchange', () => {
      this.attach();
      this.remeasure();
    });
    // Re-measure only when the video's box changes, never by polling: reading
    // layout while the player's controls are animating forces a synchronous
    // layout of the whole page.
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.remeasure()) : null;
    this.lastPlayheadAt = 0;
    this.attach();
  }

  attach() {
    // In fullscreen only the fullscreen element's subtree is visible.
    const parent = document.fullscreenElement || document.documentElement;
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
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

  /** Show the overlay only while a toast, the form or the revealed timeline needs it. */
  updateVisibility() {
    const wanted = !!(this.video?.isConnected && (this.revealed || this.form || this.toasts.childElementCount || !this.cover.hidden));
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

  reveal(ms = 2500) {
    this.lastReveal = performance.now();
    this.revealed = true;
    this.updateVisibility();
    this.write('reveal', () => {
      this.timeline.classList.toggle('show', this.revealed);
      this.badge.classList.toggle('show', this.revealed);
    });
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.form) return;
      this.revealed = false;
      this.write('reveal', () => {
        this.timeline.classList.toggle('show', this.revealed);
        this.badge.classList.toggle('show', this.revealed);
      });
      setTimeout(() => this.updateVisibility(), 300); // after the fade-out
    }, ms);
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

  toast(message, { color = '#4f7cff', actionLabel, onAction, ms = 5000 } = {}) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = color;
    const label = document.createElement('span');
    label.textContent = message;
    el.append(dot, label);
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

  /** Quick-tag form. Resolves with { category, severity, note } or null. */
  openTagForm({ start, end }) {
    this.closeForm();
    return new Promise((resolve) => {
      const form = document.createElement('div');
      form.className = 'form';
      form.innerHTML = `
        <h3>Tag ${formatTime(start)} – ${formatTime(end)}</h3>
        <div class="row cats" role="group" aria-label="Category"></div>
        <div class="row sev" role="group" aria-label="Severity"></div>
        <div class="row"><input type="text" class="note" maxlength="280" placeholder="Note (optional), e.g. 'brothel scene'"></div>
        <div class="actions"><button class="btn cancel">Cancel</button><button class="btn primary save">Save tag</button></div>`;
      let category = 'violence';
      let severity = 2;
      const chips = (container, items, get, set) => {
        for (const [value, label] of items) {
          const b = document.createElement('button');
          b.className = 'chip';
          b.textContent = label;
          b.setAttribute('aria-pressed', String(get() === value));
          b.addEventListener('click', () => {
            set(value);
            for (const c of container.children) c.setAttribute('aria-pressed', 'false');
            b.setAttribute('aria-pressed', 'true');
          });
          container.append(b);
        }
      };
      chips(form.querySelector('.cats'), CATEGORIES.map((c) => [c.id, c.label]), () => category, (v) => (category = v));
      chips(form.querySelector('.sev'), Object.entries(SEVERITIES).map(([n, l]) => [Number(n), l]), () => severity, (v) => (severity = v));
      const done = (value) => {
        this.closeForm();
        resolve(value);
      };
      form.querySelector('.cancel').addEventListener('click', () => done(null));
      form.querySelector('.save').addEventListener('click', () =>
        done({ category, severity, note: form.querySelector('.note').value.trim() }));
      // Keep the site's keyboard shortcuts (space = pause, f = fullscreen) out of the form.
      form.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') done(null);
      });
      this.form = form;
      this.root.append(form);
      this.updateVisibility();
      this.reveal(600000);
      form.querySelector('.chip').focus();
    });
  }

  closeForm() {
    const wasOpen = !!this.form;
    this.form?.remove();
    this.form = null;
    if (wasOpen) this.reveal(); // restart the normal hide timer
    this.updateVisibility();
  }

  destroy() {
    document.removeEventListener('mousemove', this.onMove);
    this.resizeObserver?.disconnect();
    this.host.remove();
  }
}
