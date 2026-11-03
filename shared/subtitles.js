// Subtitle parsing: WebVTT, SRT and TTML/DFXP/IMSC (what Netflix and Prime
// Video serve). Regex based so the same code runs in a content script, a
// service worker and Node.

/** @typedef {{ start:number, end:number, text:string }} Cue */

export function detectFormat(text) {
  const head = String(text || '').replace(/^﻿/, '').trimStart().slice(0, 400);
  if (head.startsWith('WEBVTT')) return 'vtt';
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
