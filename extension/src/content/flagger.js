// The flag control on the player. "Flag scene" starts a flag at the current
// time and shows a recording pill; Done (or "Last 10 s") pauses and opens a
// compact picker: nudge the range, pick what is in it, Save.
//
// It lives in the overlay's shadow root and follows the overlay's rules: it is
// hidden with the timeline, every DOM change goes through overlay.write()
// (one batch per frame), nothing measures layout, and no listener is added to
// the page. Only the recording pill stays up while the timeline is hidden,
// and only while recording.

import { CATEGORIES, SEVERITIES } from '../../../shared/ratings.js';
import { formatTime } from '../../../shared/identity.js';
import { CATEGORY_COLORS, containPointer } from './overlay.js';

const MIN_SECONDS = 1;
export const LAST_SECONDS = 10;

const svg = (body, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const ICON = {
  flag: svg('<path d="M5.5 21V4"/><path d="M5.5 4.5h12l-2.6 4.25 2.6 4.25h-12z" fill="currentColor"/>'),
  back: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v4.2h4.2"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  close: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  minus: svg('<path d="M7 12h10"/>'),
  plus: svg('<path d="M12 7v10M7 12h10"/>'),
};

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const STYLE = `
.side button, .side input { font-family: ${FONT}; }
.side :focus-visible { outline: 2px solid #8ab4ff; outline-offset: 2px; }
.side svg { width: 16px; height: 16px; flex: none; }

/* the dock: hidden with the timeline, except while recording */
.dock { position: relative; display: flex; align-items: center; padding: 4px; border-radius: 999px;
  background: rgba(18,18,22,.92); border: 1px solid rgba(255,255,255,.16); box-shadow: 0 8px 28px rgba(0,0,0,.45);
  opacity: 0; visibility: hidden; transition: opacity .2s, visibility 0s linear .2s; }
.root.revealed .dock, .dock.recording { opacity: 1; visibility: visible; pointer-events: auto; transition: opacity .2s; }
.dock[hidden] { display: none; }
.idle, .rec { display: flex; align-items: center; gap: 2px; }
.rec, .dock.recording .idle { display: none; }
.dock.recording .rec { display: flex; }
.fbtn { all: unset; position: relative; box-sizing: border-box; display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 13px;
  border-radius: 999px; font: 600 13px/1 ${FONT}; color: #fff; white-space: nowrap; cursor: pointer; }
.fbtn:hover { background: rgba(255,255,255,.13); }
.fbtn.quiet { color: rgba(255,255,255,.8); font-weight: 500; }
.fbtn.quiet:hover { color: #fff; }
.fbtn.icon { width: 32px; padding: 0; justify-content: center; color: rgba(255,255,255,.8); }
.fbtn.done { background: #fff; color: #111; padding: 0 14px 0 11px; }
.fbtn.done:hover { background: #e4e4ea; }
.sep { width: 1px; height: 18px; background: rgba(255,255,255,.16); margin: 0 1px; }
.status { display: inline-flex; align-items: center; gap: 8px; padding: 0 10px 0 11px; font: 600 13px/1 ${FONT}; font-variant-numeric: tabular-nums; }
.status .what { color: rgba(255,255,255,.66); font-weight: 500; }
.rdot { width: 9px; height: 9px; border-radius: 50%; background: #ff453a; box-shadow: 0 0 0 3px rgba(255,69,58,.28); }
.dock.recording .rdot { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .3; } }
/* one-shot ring when the popup sends the viewer here */
.dock::before { content: ''; position: absolute; inset: -1px; border-radius: inherit; box-shadow: 0 0 0 2px #8ab4ff; opacity: 0; pointer-events: none; }
.dock.invite::before { animation: ring 1.2s ease-out 2; }
@keyframes ring { 0% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1.06, 1.4); } }

/* tooltips with the shortcut */
.tip { position: absolute; top: calc(100% + 12px); right: -4px; display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 10px;
  border-radius: 8px; background: rgba(8,8,10,.96); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 6px 18px rgba(0,0,0,.4);
  font: 500 12px/1.2 ${FONT}; color: #fff; white-space: nowrap; opacity: 0; transform: translateY(-3px);
  transition: opacity .12s, transform .12s; pointer-events: none; }
.fbtn:hover .tip, .fbtn:focus-visible .tip { opacity: 1; transform: none; transition-delay: .35s; }
kbd { font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 3px 5px; border-radius: 5px;
  background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.16); color: #fff; }

/* the picker */
.picker { position: relative; pointer-events: auto; box-sizing: border-box; width: min(360px, 100%); max-height: 100%;
  display: flex; flex-direction: column; overflow: hidden; border-radius: 16px;
  background: rgba(18,18,22,.97); border: 1px solid rgba(255,255,255,.16); box-shadow: 0 18px 50px rgba(0,0,0,.55);
  font: 14px/1.35 ${FONT}; color: #fff; animation: pop .16s ease-out; }
.picker[hidden] { display: none; }
@keyframes pop { from { opacity: 0; transform: translateX(10px); } }
.picker:focus { outline: none; }
.pbody { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 16px 16px 2px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: -2px 0 12px; }
.title { font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
.title .len { margin-left: 6px; font-size: 13px; font-weight: 500; color: rgba(255,255,255,.6); font-variant-numeric: tabular-nums; }
.head .fbtn.icon { margin: 0 -6px 0 0; }
.head .tip { top: calc(100% + 8px); }
.range { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
.stepper { display: grid; grid-template-columns: 30px 1fr 30px; align-items: center; height: 44px; padding: 0 4px; border-radius: 11px;
  background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.09); }
.stepper .mid { text-align: center; line-height: 1.1; }
.stepper .lbl { display: block; font-size: 10px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: rgba(255,255,255,.5); }
.stepper .val { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.step { all: unset; width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: rgba(255,255,255,.85); cursor: pointer; }
.step:hover { background: rgba(255,255,255,.12); color: #fff; }
.step:disabled { opacity: .28; cursor: default; background: none; }
.lab { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: rgba(255,255,255,.66); white-space: nowrap; }
.cats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 14px; }
.cat { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 9px; min-height: 38px; padding: 5px 12px; border-radius: 10px;
  background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.08); font: 500 13.5px/1.2 ${FONT}; color: #fff; cursor: pointer; }
.cat:hover { background: rgba(255,255,255,.13); }
.cat:last-child:nth-child(odd) { grid-column: 1 / -1; }
.sw { width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 0 0 1.5px rgba(255,255,255,.28); }
.cat[aria-checked=true] { background: #fff; border-color: #fff; color: #111; font-weight: 600; }
.cat[aria-checked=true] .sw { box-shadow: none; }
.sev-row { display: flex; align-items: center; gap: 14px; }
.sev-row .lab { margin: 0; }
.sev { flex: 1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; border-radius: 11px; background: rgba(255,255,255,.07); }
.sev button { all: unset; height: 30px; border-radius: 8px; text-align: center; font: 500 13px/30px ${FONT}; color: rgba(255,255,255,.85); cursor: pointer; }
.sev button:hover { background: rgba(255,255,255,.1); }
.sev button[aria-checked=true] { background: #fff; color: #111; font-weight: 600; }
.note { box-sizing: border-box; display: block; width: 100%; height: 36px; margin: 0 0 10px; padding: 0 10px; border-radius: 9px; outline: none; appearance: none;
  background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.16); font: 13.5px ${FONT}; color: #fff; }
.note::placeholder { color: rgba(255,255,255,.42); }
.side .note:focus-visible { outline: none; }
.note:focus { border-color: #8ab4ff; box-shadow: 0 0 0 1px #8ab4ff; }
.note[hidden], .add-note[hidden] { display: none; }
/* the note and buttons stay in view when a short player makes the picker scroll */
.foot { flex: none; padding: 12px 16px 14px; }
.actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.add-note { all: unset; margin-right: auto; font: 500 13px/1 ${FONT}; color: #8ab4ff; cursor: pointer; padding: 6px 4px; margin-left: -4px; border-radius: 6px; }
.add-note:hover { text-decoration: underline; }
.btn { all: unset; box-sizing: border-box; height: 36px; padding: 0 16px; border-radius: 10px; font: 600 13.5px/36px ${FONT}; color: #fff; cursor: pointer; }
.btn.ghost:hover { background: rgba(255,255,255,.1); }
.btn.primary { background: #3d63e6; }
.btn.primary:hover { background: #4a70f2; }
.btn:disabled { opacity: .4; cursor: default; }
@media (prefers-reduced-motion: reduce) { .dock.recording .rdot, .dock.invite::before, .picker { animation: none; } }
`;

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** "7 s" for short spans, "1:23" for long ones. */
export const spanText = (s) => (s < 59.5 ? `${Math.max(0, Math.round(s))} s` : formatTime(s));

export class Flagger {
  /**
   * @param {import('./overlay.js').Overlay} overlay
   * @param {{ onStart: Function, onDone: Function, onLast: Function, onCancel: Function }} actions
   */
  constructor(overlay, actions) {
    this.overlay = overlay;
    this.actions = actions;
    this.mode = 'idle'; // idle | recording | picking
    this.elapsedText = '';
    this.picker = null; // built on first use
    this.resolve = null;

    const style = document.createElement('style');
    style.textContent = STYLE;
    overlay.shadow.append(style);
    this.side = overlay.side;
    this.dock = el('div', 'dock', `
      <div class="idle">
        <button class="fbtn flag-start" aria-label="Flag a scene, starting now (Alt+[)" aria-keyshortcuts="Alt+[">
          ${ICON.flag}<span>Flag scene</span><span class="tip" aria-hidden="true">Mark where the scene starts<kbd>Alt+[</kbd></span></button>
        <span class="sep" aria-hidden="true"></span>
        <button class="fbtn quiet flag-last" aria-label="Flag the last ${LAST_SECONDS} seconds (Alt+])" aria-keyshortcuts="Alt+]">
          ${ICON.back}<span>Last ${LAST_SECONDS} s</span><span class="tip" aria-hidden="true">Flag what just happened<kbd>Alt+]</kbd></span></button>
      </div>
      <div class="rec">
        <span class="status"><span class="rdot" aria-hidden="true"></span><span class="what">Flagging</span><span class="elapsed">0:00</span></span>
        <button class="fbtn done flag-done" aria-label="Done: the scene ends here (Alt+])" aria-keyshortcuts="Alt+]">
          ${ICON.check}<span>Done</span><span class="tip" aria-hidden="true">The scene ends here<kbd>Alt+]</kbd></span></button>
        <button class="fbtn icon flag-cancel" aria-label="Cancel flagging (Escape)" aria-keyshortcuts="Escape">
          ${ICON.close}<span class="tip" aria-hidden="true">Cancel<kbd>Esc</kbd></span></button>
      </div>`);
    this.dock.setAttribute('role', 'group');
    this.dock.setAttribute('aria-label', 'CleanCut: flag a scene');
    this.elapsed = this.dock.querySelector('.elapsed');
    this.side.append(this.dock);

    const on = (sel, fn) => this.dock.querySelector(sel).addEventListener('click', fn);
    on('.flag-start', () => this.actions.onStart());
    on('.flag-last', () => this.actions.onLast());
    on('.flag-done', () => this.actions.onDone());
    on('.flag-cancel', () => this.actions.onCancel());
    containPointer(this.dock);
    // A click must not move focus onto the control, or the next Space (the
    // site's pause key) would press it again; Tab still reaches it.
    this.dock.addEventListener('mousedown', (e) => e.preventDefault());
    this.dock.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') e.stopPropagation(); // ours, not the site's play/pause
    });
    this.dock.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') e.stopPropagation();
    });
    // Stay up while the pointer rests on the control or it has focus.
    this.dock.addEventListener('pointerenter', () => overlay.holdReveal('hover', true));
    this.dock.addEventListener('pointerleave', () => overlay.holdReveal('hover', false));
    this.dock.addEventListener('focusin', () => overlay.holdReveal('focus', true));
    this.dock.addEventListener('focusout', () => overlay.holdReveal('focus', false));
    this.dock.addEventListener('animationend', (e) => {
      if (e.animationName === 'ring') overlay.write('flag-invite', () => this.dock.classList.remove('invite'));
    });
    overlay.onReparent = () => this.refocus();
  }

  get busy() {
    return this.mode !== 'idle';
  }

  /** Show the control and draw the eye to it (the popup's "Flag a scene" button). */
  invite() {
    this.overlay.reveal(8000);
    if (this.mode === 'picking') return;
    this.overlay.write('flag-invite', () => this.dock.classList.add('invite'));
  }

  /** Recording from `start`: the pill stays up, even with the timeline hidden. */
  record() {
    this.mode = 'recording';
    this.elapsedText = '';
    this.setElapsed(0);
    this.overlay.holdDisplay('recording', true);
    this.overlay.write('flag-mode', () => {
      const focused = this.dock.contains(this.overlay.shadow.activeElement); // reached with Tab
      this.dock.classList.add('recording');
      if (focused) this.dock.querySelector('.flag-done').focus({ preventScroll: true });
    });
  }

  /** Seconds recorded so far; writes only when the shown text changes (once a second). */
  setElapsed(seconds) {
    const text = formatTime(seconds);
    if (text === this.elapsedText) return;
    this.elapsedText = text;
    this.overlay.write('flag-elapsed', () => {
      this.elapsed.textContent = this.elapsedText;
    });
  }

  idle() {
    this.mode = 'idle';
    this.overlay.holdDisplay('recording', false);
    this.overlay.write('flag-mode', () => {
      const focused = this.dock.contains(this.overlay.shadow.activeElement);
      this.dock.classList.remove('recording');
      this.dock.hidden = false;
      this.side.classList.remove('picking');
      if (focused) this.dock.querySelector('.flag-start').focus({ preventScroll: true });
    });
  }

  // ---- picker -----------------------------------------------------------------------

  buildPicker() {
    const p = el('div', 'picker');
    p.hidden = true;
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-modal', 'false');
    p.setAttribute('aria-labelledby', 'cc-flag-title');
    p.tabIndex = -1;
    const stepper = (edge, label) => `
      <div class="stepper" role="group" aria-label="${label}">
        <button class="step" data-edge="${edge}" data-d="-1" aria-label="${label} 1 second earlier">${ICON.minus}</button>
        <span class="mid"><span class="lbl">${label}</span><span class="val ${edge}" aria-live="polite">0:00</span></span>
        <button class="step" data-edge="${edge}" data-d="1" aria-label="${label} 1 second later">${ICON.plus}</button>
      </div>`;
    p.innerHTML = `<div class="pbody">
      <div class="head">
        <div class="title" id="cc-flag-title">Flag this scene<span class="len"></span></div>
        <button class="fbtn icon close" aria-label="Cancel (Escape)">${ICON.close}<span class="tip" aria-hidden="true">Cancel<kbd>Esc</kbd></span></button>
      </div>
      <div class="range">${stepper('start', 'Start')}${stepper('end', 'End')}</div>
      <div class="lab" id="cc-flag-cat">What’s in it?</div>
      <div class="cats" role="radiogroup" aria-labelledby="cc-flag-cat"></div>
      <div class="sev-row"><div class="lab" id="cc-flag-sev">How strong?</div><div class="sev" role="radiogroup" aria-labelledby="cc-flag-sev"></div></div>
      </div>
      <div class="foot">
        <input class="note" type="text" maxlength="280" hidden aria-label="Note (optional)" placeholder="Note (optional), e.g. “bar fight”">
        <div class="actions"><button class="add-note">+ Add a note</button><button class="btn ghost cancel">Cancel</button><button class="btn primary save" disabled>Save flag</button></div>
      </div>`;
    const cats = p.querySelector('.cats');
    for (const c of CATEGORIES) {
      const b = el('button', 'cat', `<span class="sw" style="background:${CATEGORY_COLORS[c.id] || '#999'}"></span><span>${c.label}</span>`);
      b.dataset.value = c.id;
      b.setAttribute('role', 'radio');
      cats.append(b);
    }
    const sev = p.querySelector('.sev');
    for (const [n, name] of Object.entries(SEVERITIES)) {
      const b = el('button', '', capital(name));
      b.dataset.value = n;
      b.setAttribute('role', 'radio');
      sev.append(b);
    }
    this.p = {
      root: p,
      len: p.querySelector('.len'),
      start: p.querySelector('.val.start'),
      end: p.querySelector('.val.end'),
      steps: [...p.querySelectorAll('.step')],
      cats,
      sev,
      addNote: p.querySelector('.add-note'),
      note: p.querySelector('.note'),
      save: p.querySelector('.save'),
    };

    p.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t || t.disabled) return;
      if (t.classList.contains('step')) this.nudge(t.dataset.edge, Number(t.dataset.d));
      else if (t.parentNode === cats) this.choose('category', t.dataset.value);
      else if (t.parentNode === sev) this.choose('severity', Number(t.dataset.value));
      else if (t === this.p.addNote) this.showNote();
      else if (t.classList.contains('save')) this.submit();
      else if (t.classList.contains('cancel') || t.classList.contains('close')) this.finish(null);
    });
    // The site's shortcuts (space = pause, f = fullscreen, arrows = seek) stay out of the picker.
    for (const type of ['keydown', 'keyup', 'keypress']) p.addEventListener(type, (e) => e.stopPropagation());
    p.addEventListener('keydown', (e) => this.onKey(e));
    containPointer(p);
    this.side.append(p);
  }

  /**
   * Open the picker for a range. Resolves with { start, end, category,
   * severity, note } or null when cancelled.
   * @param {{ start: number, end: number, duration: number, keyboard?: boolean,
   *   onRange?: (start: number, end: number) => void }} opts keyboard: opened
   *   from a shortcut, so focus goes straight to the categories.
   */
  pick({ start, end, duration, keyboard = false, onRange }) {
    if (!this.picker) {
      this.buildPicker();
      this.picker = this.p.root;
    }
    this.finish(null); // a previous picker, if any, is cancelled
    this.mode = 'picking';
    this.overlay.holdDisplay('recording', false);
    this.overlay.holdReveal('hover', false); // the dock is about to disappear from under the pointer
    this.overlay.holdReveal('focus', false);
    this.overlay.holdReveal('picker', true);
    this.max = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
    this.sel = { start, end, category: null, severity: 2, note: '' };
    this.onRange = onRange;
    this.overlay.write('flag-mode', () => {
      this.dock.classList.remove('recording', 'invite');
      this.dock.hidden = true;
      this.side.classList.add('picking');
      this.p.note.value = '';
      this.p.note.hidden = true;
      this.p.addNote.hidden = false;
      this.picker.hidden = false;
      this.picker.firstElementChild.scrollTop = 0;
    });
    this.renderRange();
    this.renderChoices();
    // From the mouse, focus the panel itself (keys reach it, no focus ring
    // that could pass for a preselected category); from a shortcut, the categories.
    this.keyboard = keyboard;
    this.overlay.write('flag-focus', () => (keyboard ? this.focusFirst() : this.picker.focus({ preventScroll: true })));
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  /** Close the picker (if open) with an answer; null cancels. */
  finish(answer) {
    if (!this.resolve) return;
    const resolve = this.resolve;
    this.resolve = null;
    this.onRange = null;
    this.overlay.write('flag-picker', () => {
      this.picker.hidden = true;
      // Leave the page's focus as it was before, so the site's keys work again.
      if (this.overlay.shadow.activeElement) this.overlay.shadow.activeElement.blur();
    });
    this.idle();
    this.overlay.holdReveal('picker', false);
    resolve(answer);
  }

  cancel() {
    if (this.mode === 'picking') this.finish(null);
    else this.idle();
  }

  nudge(edge, d) {
    const s = this.sel;
    if (edge === 'start') s.start = Math.min(Math.max(0, s.start + d), s.end - MIN_SECONDS);
    else s.end = Math.max(Math.min(this.max, s.end + d), s.start + MIN_SECONDS);
    s.start = Math.max(0, s.start);
    this.renderRange();
    this.onRange?.(s.start, s.end);
  }

  renderRange() {
    const { start, end } = this.sel;
    const max = this.max;
    const eps = 1e-6;
    const disabled = [start <= eps, start >= end - MIN_SECONDS - eps, end <= start + MIN_SECONDS + eps, end >= max - eps];
    const len = spanText(end - start);
    this.overlay.write('flag-range', () => {
      this.p.start.textContent = formatTime(start);
      this.p.end.textContent = formatTime(end);
      this.p.len.textContent = len;
      // Moving focus off a button that just became disabled would drop it to the page.
      this.p.steps.forEach((b, i) => {
        if (disabled[i] && this.overlay.shadow.activeElement === b) this.p.steps[i % 2 ? i - 1 : i + 1].focus({ preventScroll: true });
        b.disabled = disabled[i];
      });
    });
  }

  choose(kind, value) {
    this.sel[kind] = value;
    this.renderChoices();
  }

  renderChoices() {
    const { category, severity } = this.sel;
    this.overlay.write('flag-choices', () => {
      const cats = [...this.p.cats.children];
      cats.forEach((b, i) => {
        const on = b.dataset.value === category;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on || (!category && i === 0) ? 0 : -1; // one tab stop per group
      });
      for (const b of this.p.sev.children) {
        const on = Number(b.dataset.value) === severity;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      this.p.save.disabled = !category;
    });
  }

  showNote() {
    this.overlay.write('flag-note', () => {
      this.p.addNote.hidden = true;
      this.p.note.hidden = false;
      this.p.note.focus({ preventScroll: true });
    });
  }

  submit() {
    const s = this.sel;
    if (!s.category) return;
    this.finish({ start: s.start, end: s.end, category: s.category, severity: s.severity, note: this.p.note.value.trim() });
  }

  focusFirst() {
    const first = this.p.cats.querySelector('[tabindex="0"]') || this.p.cats.firstElementChild;
    first.focus({ preventScroll: true });
  }

  /** After moving into or out of fullscreen the focus is lost: put it back in the picker. */
  refocus() {
    if (this.mode === 'picking') this.overlay.write('flag-focus', () => (this.keyboard ? this.focusFirst() : this.picker.focus({ preventScroll: true })));
  }

  onKey(e) {
    const active = this.overlay.shadow.activeElement;
    if (e.key === 'Enter' && active === this.p.note) {
      e.preventDefault();
      this.submit();
    } else if (e.key === 'Tab') {
      // Keep Tab inside the picker while it is open.
      const items = [...this.picker.querySelectorAll('button, input')].filter((b) => !b.disabled && !b.hidden && b.tabIndex >= 0);
      e.preventDefault();
      if (active === this.picker) return this.focusFirst(); // from the panel, Tab starts at the categories
      const i = items.indexOf(active);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
      items[next]?.focus({ preventScroll: true });
    } else if (/^Arrow/.test(e.key) && active?.getAttribute('role') === 'radio') {
      // Arrow keys move through a radio group, selecting as they go.
      e.preventDefault();
      const group = [...active.parentNode.children];
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      const next = group[(group.indexOf(active) + step + group.length) % group.length];
      const kind = active.parentNode === this.p.cats ? 'category' : 'severity';
      this.choose(kind, kind === 'category' ? next.dataset.value : Number(next.dataset.value));
      next.tabIndex = 0;
      active.tabIndex = -1;
      next.focus({ preventScroll: true }); // now, so the next key press starts from here
    }
  }
}
