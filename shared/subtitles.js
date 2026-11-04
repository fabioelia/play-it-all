// Subtitle parsing: WebVTT, SRT and TTML/DFXP/IMSC (what Netflix, Prime Video
// and most services serve), YouTube's json3 and srv3 timed text, and ASS/SSA
// (Crunchyroll). Regex based so the same code runs in a content script, a
// service worker and Node.

/** @typedef {{ start:number, end:number, text:string }} Cue */

export function detectFormat(text) {
  const head = String(text || '').replace(/^﻿/, '').trimStart().slice(0, 400);
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (/^\{\s*"(wireMagic|events|pens|wpWinPositions)"/.test(head)) return 'json3';
  if (/<timedtext[\s>]|<transcript[\s>]/.test(head)) return 'srv3';
  if (/^\[Script Info\]/i.test(head) || (/\[Events\]/i.test(head) && /\nDialogue:/.test(String(text)))) return 'ass';
  if (/^<\?xml|^<tt[\s>]|<tt[\s:>]/.test(head)) return 'ttml';
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return 'srt';
  if (/\d{1,2}:\d{2}[,.]\d{1,3}\s*-->/.test(head) || /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return 'srt';
  return null;
}

/** Parse any supported subtitle document. Returns cues sorted by start. */
export function parseSubtitles(text) {
  const format = detectFormat(text);
  if (format === 'ttml') return parseTTML(text);
  if (format === 'vtt' || format === 'srt') return parseCueBlocks(text);
  if (format === 'json3') return parseJson3(text);
  if (format === 'srv3') return parseSrv3(text);
  if (format === 'ass') return parseASS(text);
  return [];
}

/** "01:02:03.456", "02:03,456", "3.5" → seconds */
export function parseClock(value) {
  const s = String(value).trim().replace(',', '.');
  const parts = s.split(':');
  if (parts.length > 3) return NaN;
  let seconds = 0;
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return NaN;
    seconds = seconds * 60 + Number(p);
  }
  return seconds;
}

/** WebVTT and SRT share the "start --> end" block structure. */
export function parseCueBlocks(text) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues = [];
  const timing = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
  for (let i = 0; i < lines.length; i++) {
    const m = timing.exec(lines[i]);
    if (!m) continue;
    const start = parseClock(m[1]);
    const end = parseClock(m[2]);
    const body = [];
    while (++i < lines.length && lines[i].trim() !== '') body.push(lines[i]);
    const textOut = cleanCueText(body.join('\n'));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && textOut) cues.push({ start, end, text: textOut });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function cleanCueText(s) {
  return decodeEntities(
    s
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, ''), // SSA-style override tags sometimes leak into SRT
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[2] ?? m[3]) : null;
}

/**
 * TTML time expressions: clock time ("00:00:01.500", "00:00:01:12" frames),
 * offset time ("1.5s", "1500ms", "90f", "15000000t" ticks — Netflix DFXP uses
 * ticks with ttp:tickRate="10000000").
 */
export function parseTTMLTime(value, { tickRate = 10_000_000, frameRate = 30 } = {}) {
  if (value == null) return NaN;
  const v = String(value).trim();
  const offset = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/.exec(v);
  if (offset) {
    const n = Number(offset[1]);
    switch (offset[2]) {
      case 'h': return n * 3600;
      case 'm': return n * 60;
      case 's': return n;
      case 'ms': return n / 1000;
      case 'f': return n / frameRate;
      case 't': return n / tickRate;
    }
  }
  const frames = /^(\d+):(\d{2}):(\d{2}):(\d+(?:\.\d+)?)$/.exec(v);
  if (frames) return Number(frames[1]) * 3600 + Number(frames[2]) * 60 + Number(frames[3]) + Number(frames[4]) / frameRate;
  return parseClock(v);
}

export function parseTTML(xml) {
  const doc = String(xml);
  const rootAttrs = (/<tt\b([^>]*)>/.exec(doc) || [])[1] || '';
  const tickRate = Number(attr(rootAttrs, 'tickRate')) || 10_000_000;
  const frameRate = Number(attr(rootAttrs, 'frameRate')) || 30;
  const opts = { tickRate, frameRate };
  const cues = [];
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRe.exec(doc))) {
    const attrs = m[1];
    const start = parseTTMLTime(attr(attrs, 'begin'), opts);
    let end = parseTTMLTime(attr(attrs, 'end'), opts);
    if (!Number.isFinite(end)) {
      const dur = parseTTMLTime(attr(attrs, 'dur'), opts);
      if (Number.isFinite(dur)) end = start + dur;
    }
    const text = cleanCueText(m[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Language tag of a TTML document (xml:lang on <tt>), if any. */
export function ttmlLanguage(xml) {
  const rootAttrs = (/<tt\b([^>]*)>/.exec(String(xml)) || [])[1] || '';
  return attr(rootAttrs, 'lang');
}

// ---- YouTube timed text ----------------------------------------------------------
//
// YouTube's automatic captions print every profanity as "[ __ ]". Read as a
// censored strong word ("f**k" matches the analyzer's censored-word rule), not
// as a sound description, so those lines are still muted.
const YT_MASK = /\[\s*_{2,}\s*\]/g;
const unmask = (s) => s.replace(YT_MASK, 'f**k');

/**
 * json3 (what the YouTube web player requests with fmt=json3):
 * { events: [{ tStartMs, dDurationMs, segs: [{ utf8, tOffsetMs? }] }] }.
 * Automatic captions come one word per seg; window and newline events carry no text.
 */
export function parseJson3(text) {
  let doc;
  try {
    doc = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return [];
  }
  const cues = [];
  for (const e of Array.isArray(doc?.events) ? doc.events : []) {
    if (!e || !Array.isArray(e.segs)) continue;
    const start = Number(e.tStartMs) / 1000;
    if (!Number.isFinite(start)) continue;
    const dur = Number(e.dDurationMs) / 1000;
    const body = cleanCueText(unmask(e.segs.map((g) => (typeof g?.utf8 === 'string' ? g.utf8 : '')).join('')));
    if (!body) continue;
    cues.push({ start, end: start + (dur > 0 ? dur : 2), text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/**
 * srv3 (<timedtext format="3"><body><p t="ms" d="ms">…</p>) and the older
 * transcript format (<transcript><text start="s" dur="s">…</text>).
 */
export function parseSrv3(xml) {
  const doc = String(xml);
  const cues = [];
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRe.exec(doc))) {
    const t = Number(attr(m[1], 't'));
    const d = Number(attr(m[1], 'd'));
    const body = cleanCueText(unmask(m[2]));
    if (Number.isFinite(t) && body) cues.push({ start: t / 1000, end: (t + (d > 0 ? d : 2000)) / 1000, text: body });
  }
  const tRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  while ((m = tRe.exec(doc))) {
    const start = Number(attr(m[1], 'start'));
    const dur = Number(attr(m[1], 'dur'));
    const body = cleanCueText(unmask(decodeEntities(m[2])));
    if (Number.isFinite(start) && body) cues.push({ start, end: start + (dur > 0 ? dur : 2), text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

// ---- ASS / SSA (Crunchyroll) ------------------------------------------------------

/** "0:01:02.34" (h:mm:ss.cc) → seconds */
function assTime(v) {
  const m = /^\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)\s*$/.exec(v);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

/**
 * Dialogue lines of an ASS/SSA script. Lines styled as on-screen signs are
 * left out: they are text in the picture, not speech.
 */
export function parseASS(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let format = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  let inEvents = false;
  const cues = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inEvents = /^\s*\[events\]/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    const f = /^\s*Format\s*:\s*(.*)$/i.exec(line);
    if (f) {
      format = f[1].split(',').map((x) => x.trim().toLowerCase());
      continue;
    }
    const d = /^\s*Dialogue\s*:\s*(.*)$/i.exec(line);
    if (!d) continue;
    const parts = d[1].split(',');
    const fields = parts.slice(0, format.length - 1);
    fields.push(parts.slice(format.length - 1).join(','));
    const get = (k) => fields[format.indexOf(k)] ?? '';
    if (/sign/i.test(get('style'))) continue;
    const start = assTime(get('start'));
    const end = assTime(get('end'));
    const body = cleanCueText(get('text').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' '));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && body) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

// ---- segmented WebVTT (HLS subtitle renditions) -----------------------------------

function vttClock(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/** Cues as one WebVTT document. */
export function toVtt(cues) {
  return `WEBVTT\n\n${cues.map((c) => `${vttClock(c.start)} --> ${vttClock(c.end)}\n${c.text}`).join('\n\n')}\n`;
}

/**
 * Join the WebVTT segments of an HLS subtitle rendition into one document.
 * Segments of MPEG-TS streams carry X-TIMESTAMP-MAP=MPEGTS:<90 kHz>,LOCAL:<time>;
 * times are made relative to the first segment's mapping (usually they all
 * share one, and nothing moves). Cues repeated across segment boundaries are kept once.
 */
export function joinVttSegments(parts) {
  const cues = [];
  const seen = new Set();
  let first = null;
  for (const part of parts) {
    if (typeof part !== 'string' || detectFormat(part) !== 'vtt') continue;
    const map = /X-TIMESTAMP-MAP=([^\r\n]*)/.exec(part)?.[1] || '';
    const mpegts = Number(/MPEGTS:(\d+)/.exec(map)?.[1]);
    const local = parseClock(/LOCAL:([\d:.]+)/.exec(map)?.[1] || '0');
    const here = Number.isFinite(mpegts) ? mpegts / 90000 - (Number.isFinite(local) ? local : 0) : 0;
    if (first === null) first = here;
    const shift = here - first;
    for (const c of parseCueBlocks(part)) {
      const cue = { start: c.start + shift, end: c.end + shift, text: c.text };
      const key = `${cue.start.toFixed(2)}|${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cues.push(cue);
    }
  }
  cues.sort((a, b) => a.start - b.start);
  return cues.length ? toVtt(cues) : null;
}
