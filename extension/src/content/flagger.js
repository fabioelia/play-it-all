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

// Tokens (--surface, --accent, --r-md, --fs-md…) come from the overlay's
// .root: the popup's dark theme. A selected choice looks like the popup's
// rating buttons (accent fill), a primary action like its primary buttons.
const STYLE = `
.side button, .side input { font-family: var(--font); }
.side :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.side svg { width: 16px; height: 16px; flex: none; }

/* the dock: on the rail's centre line, hidden with the timeline, except while recording */
.dock { grid-row: 2; position: relative; display: flex; align-items: center; padding: 4px; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow);
  opacity: 0; visibility: hidden; transition: opacity .2s, visibility 0s linear .2s; }
.root.revealed .dock, .dock.recording { opacity: 1; visibility: visible; pointer-events: auto; transition: opacity .2s; }
.dock[hidden], .root.ad .dock { display: none; }
.idle, .rec { display: flex; align-items: center; gap: 2px; }
.rec, .dock.recording .idle { display: none; }
.dock.recording .rec { display: flex; }
.fbtn { all: unset; position: relative; box-sizing: border-box; display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px;
  border-radius: 999px; font: 600 var(--fs-md)/1 var(--font); color: var(--text); white-space: nowrap; cursor: pointer; }
.fbtn:hover { background: var(--raised-hover); }
.fbtn.quiet { font-weight: 500; }
.fbtn.icon { width: 32px; padding: 0; justify-content: center; color: var(--muted); }
.fbtn.icon:hover { color: var(--text); }
.fbtn.primary { background: var(--accent); color: var(--on-accent); padding: 0 14px 0 11px; }
.fbtn.primary:hover { background: var(--accent-hover); }
.sep { width: 1px; height: 18px; background: var(--line); margin: 0 1px; }
.status { display: inline-flex; align-items: center; gap: 8px; padding: 0 10px 0 11px; font: 600 var(--fs-md)/1 var(--font); font-variant-numeric: tabular-nums; }
.status .what { color: var(--muted); font-weight: 500; }
/* steady, not pulsing (nothing animates over playing video): the clock beside it shows it is running */
.rdot { width: 8px; height: 8px; border-radius: 50%; background: #ff453a; box-shadow: 0 0 0 3px rgba(255, 69, 58, .3); }
/* one-shot ring when the popup sends the viewer here */
.dock::before { content: ''; position: absolute; inset: -1px; border-radius: inherit; box-shadow: 0 0 0 2px var(--focus); opacity: 0; pointer-events: none; }
.dock.invite::before { animation: ring 1.2s ease-out 2; }
@keyframes ring { 0% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1.06, 1.4); } }

/* tooltips with the shortcut */
.tip { position: absolute; top: calc(100% + 10px); right: -4px; display: flex; align-items: center; gap: 10px; padding: 6px 8px 6px 10px;
  border-radius: var(--r-md); background: var(--surface-solid); border: 1px solid var(--line); box-shadow: var(--shadow);
  font: 500 var(--fs-sm)/1.2 var(--font); color: var(--text); white-space: nowrap; opacity: 0; transform: translateY(-3px);
  transition: opacity .12s, transform .12s; pointer-events: none; }
.fbtn:hover .tip, .fbtn:focus-visible .tip { opacity: 1; transform: none; transition-delay: .35s; }
.keys { display: inline-flex; align-items: center; gap: 2px; color: var(--muted); }
/* as in the popup */
kbd { font: 600 var(--fs-xs)/1 var(--font); padding: 2px 5px; border: 1px solid var(--line-strong); border-bottom-width: 2px; border-radius: 4px;
  background: var(--raised); color: var(--text); }

/* the picker */
.picker { grid-row: 1 / -1; align-self: center; position: relative; pointer-events: auto; box-sizing: border-box; width: min(360px, 100%); max-height: 100%;
  display: flex; flex-direction: column; overflow: hidden; border-radius: var(--r-lg);
  background: var(--surface-solid); border: 1px solid var(--line); box-shadow: 0 18px 50px rgba(0, 0, 0, .55);
  font: var(--fs-md)/1.35 var(--font); color: var(--text); animation: pop .16s ease-out; }
.picker[hidden] { display: none; }
@keyframes pop { from { opacity: 0; transform: translateX(10px); } }
.picker:focus { outline: none; }
.pbody { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 16px 16px 4px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: -4px 0 12px; }
.title { font-size: var(--fs-lg); font-weight: 650; letter-spacing: -.01em; }
.title .len { margin-left: 6px; font-size: var(--fs-md); font-weight: 500; color: var(--muted); font-variant-numeric: tabular-nums; }
.head .fbtn.icon { margin: 0 -8px 0 0; }
.head .tip { top: calc(100% + 8px); }
.range { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
.stepper { display: grid; grid-template-columns: 32px 1fr 32px; align-items: center; height: 46px; padding: 0 4px; border-radius: var(--r-md);
  background: var(--raised); border: 1px solid var(--line); }
.stepper .mid { text-align: center; line-height: 1.15; }
.stepper .lbl { display: block; font-size: var(--fs-xs); font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.stepper .val { font-size: var(--fs-lg); font-weight: 650; font-variant-numeric: tabular-nums; }
.step { all: unset; width: 32px; height: 32px; border-radius: var(--r-sm); display: grid; place-items: center; color: var(--text); cursor: pointer; }
.step:hover { background: var(--raised-hover); }
.step:disabled { opacity: .3; cursor: default; background: none; }
.lab { margin: 0 0 8px; font-size: var(--fs-sm); font-weight: 600; color: var(--muted); white-space: nowrap; }
.cats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 16px; }
.cat { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 9px; min-height: 38px; padding: 6px 12px; border-radius: var(--r-md);
  background: var(--raised); border: 1px solid transparent; font: 500 var(--fs-md)/1.2 var(--font); color: var(--text); cursor: pointer; }
.cat:hover { background: var(--raised-hover); }
.cat:last-child:nth-child(odd) { grid-column: 1 / -1; }
.sw { width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .3); }
.cat[aria-checked=true] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.cat[aria-checked=true] .sw { box-shadow: 0 0 0 2px #fff; }
.sev-row { display: flex; align-items: center; gap: 14px; }
.sev-row .lab { margin: 0; }
/* the popup's segmented control */
.sev { flex: 1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 2px; border-radius: var(--r-md); background: var(--raised); }
.sev button { all: unset; height: 32px; border-radius: var(--r-sm); text-align: center; font: 600 var(--fs-md)/32px var(--font); color: var(--muted); cursor: pointer; }
.sev button:hover { color: var(--text); }
.sev button[aria-checked=true] { background: var(--accent); color: var(--on-accent); box-shadow: 0 1px 2px rgba(0, 0, 0, .25); }
.note { box-sizing: border-box; display: block; width: 100%; height: 36px; margin: 0 0 10px; padding: 0 10px; border-radius: var(--r-md); outline: none; appearance: none;
  background: var(--raised); border: 1px solid var(--line-strong); font: var(--fs-md) var(--font); color: var(--text); }
.note::placeholder { color: var(--muted); }
.side .note:focus-visible { outline: none; }
.note:focus { border-color: var(--focus); box-shadow: 0 0 0 1px var(--focus); }
.note[hidden], .add-note[hidden] { display: none; }
/* the note and buttons stay in view when a short player makes the picker scroll */
.foot { flex: none; padding: 12px 16px 14px; }
.actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.add-note { all: unset; margin: 0 auto 0 -6px; height: 32px; padding: 0 6px; border-radius: var(--r-sm); font: 500 var(--fs-md)/32px var(--font); color: var(--link); cursor: pointer; }
.add-note:hover { text-decoration: underline; }
/* the popup's buttons */
.btn { all: unset; box-sizing: border-box; height: 36px; padding: 0 14px; border-radius: var(--r-md); border: 1px solid var(--line-strong);
  font: 550 var(--fs-md)/34px var(--font); color: var(--text); cursor: pointer; }
.btn:hover { background: var(--raised-hover); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn:disabled { opacity: .45; cursor: default; }
.btn.primary:disabled:hover { background: var(--accent); border-color: var(--accent); }
@media (prefers-reduced-motion: reduce) { .dock.invite::before, .picker { animation: none; } .tip { transition: none; } }
`;

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** A shortcut as the popup writes it: <kbd>Alt</kbd>+<kbd>[</kbd>. */
const keys = (...k) => `<span class="keys">${k.map((x) => `<kbd>${x}</kbd>`).join('+')}</span>`;
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
          ${ICON.flag}<span>Flag scene</span><span class="tip" aria-hidden="true">Mark where the scene starts${keys('Alt', '[')}</span></button>
        <span class="sep" aria-hidden="true"></span>
        <button class="fbtn quiet flag-last" aria-label="Flag the last ${LAST_SECONDS} seconds (Alt+])" aria-keyshortcuts="Alt+]">
          ${ICON.back}<span>Last ${LAST_SECONDS} s</span><span class="tip" aria-hidden="true">Flag what just played${keys('Alt', ']')}</span></button>
      </div>
      <div class="rec">
        <span class="status"><span class="rdot" aria-hidden="true"></span><span class="what">Flagging</span><span class="elapsed">0:00</span></span>
        <button class="fbtn primary flag-done" aria-label="Done: the scene ends here (Alt+])" aria-keyshortcuts="Alt+]">
          ${ICON.check}<span>Done</span><span class="tip" aria-hidden="true">The scene ends here${keys('Alt', ']')}</span></button>
        <button class="fbtn icon flag-cancel" aria-label="Cancel flagging (Escape)" aria-keyshortcuts="Escape">
          ${ICON.close}<span class="tip" aria-hidden="true">Cancel${keys('Esc')}</span></button>
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
        <button class="fbtn icon close" aria-label="Cancel (Escape)">${ICON.close}<span class="tip" aria-hidden="true">Cancel${keys('Esc')}</span></button>
      </div>
      <div class="range">${stepper('start', 'Start')}${stepper('end', 'End')}</div>
      <div class="lab" id="cc-flag-cat">What’s in it?</div>
      <div class="cats" role="radiogroup" aria-labelledby="cc-flag-cat"></div>
      <div class="sev-row"><div class="lab" id="cc-flag-sev">How strong?</div><div class="sev" role="radiogroup" aria-labelledby="cc-flag-sev"></div></div>
      </div>
      <div class="foot">
        <input class="note" type="text" maxlength="280" hidden aria-label="Note (optional)" placeholder="Note (optional), e.g. “bar fight”">
        <div class="actions"><button class="add-note">+ Add a note</button><button class="btn cancel">Cancel</button><button class="btn primary save" disabled>Save flag</button></div>
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
