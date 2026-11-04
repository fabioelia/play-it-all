// Small DOM helpers shared by the platform adapters. None of them reads
// layout (no getBoundingClientRect, offsetWidth, getComputedStyle): they run
// in the once-a-second identify loop on pages with very large DOMs.

import { metaFromJsonLd } from '../../../../shared/sources.js';

/**
 * The main video, chosen without reading layout: by whether it has media
 * loaded and by its own resolution (videoWidth × videoHeight are properties of
 * the stream, not the page, so reading them never forces a reflow).
 */
export function largestVideo(root = document) {
  let best = null;
  let bestScore = -1;
  for (const v of root.querySelectorAll('video')) {
    if (!(v.currentSrc || v.src || v.srcObject)) continue;
    const score = (v.readyState > 0 ? 1e9 : 0) + v.videoWidth * v.videoHeight;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

export const text = (sel, root = document) => root?.querySelector(sel)?.textContent?.trim() || '';

/** First match of any selector, tried in order (a selector list would return document order). */
export function first(selectors, root = document) {
  for (const sel of selectors) {
    const el = root?.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/**
 * querySelector through open shadow roots along a path of hosts:
 * shadow(['disney-web-player'], 'video') = disney-web-player → its shadow root → video.
 */
export function shadow(hosts, sel) {
  let root = document;
  for (const h of hosts) {
    root = root?.querySelector(h)?.shadowRoot;
    if (!root) return null;
  }
  return root.querySelector(sel);
}

// JSON-LD is parsed once per address (identify runs every second), and again
// after a few seconds if it did not name the title yet (apps add it late).
let ldUrl = null;
let ldAt = 0;
let ldMeta = null;
/** Title metadata from the page's JSON-LD, if a block there names `id`. */
export function jsonLdMeta(id) {
  const now = performance.now();
  if (ldUrl === location.href && (ldMeta || now - ldAt < 5000)) return ldMeta;
  ldUrl = location.href;
  ldAt = now;
  const docs = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      docs.push(JSON.parse(s.textContent));
    } catch { /* not JSON */ }
  }
  ldMeta = docs.length ? metaFromJsonLd(docs, id) : null;
  return ldMeta;
}

/**
 * The document title without the site's name: "Severance - Apple TV+" → "Severance".
 * Single-page apps update it on navigation, so it is only a last resort.
 */
export function documentTitle(siteName) {
  let t = (document.title || '').trim();
  for (const sep of [' | ', ' - ', ' – ', ' — ', ' • ']) {
    const i = t.lastIndexOf(sep);
    if (i > 0 && new RegExp(siteName, 'i').test(t.slice(i + sep.length))) t = t.slice(0, i).trim();
  }
  t = t.replace(/^(watch|stream)\s+/i, '');
  return t && !new RegExp(`^(${siteName})$`, 'i').test(t) ? t : '';
}
