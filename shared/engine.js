// The decision engine: turns tagged segments + a viewer profile into a
// playback plan, and answers "what should happen at time t?".
//
// Pure functions only — the content script owns the <video> element.

import { exceeds, resolveProfile } from './ratings.js';

// Machine-detected: subtitle scan, offline scanner, listening to the audio ahead.
const MACHINE_SOURCES = new Set(['subtitles', 'scanner', 'listening']);

// Adjacent filtered regions closer than this are merged so playback does not
// stutter through a run of tiny cuts.
const MERGE_GAP = { skip: 1.5, mute: 0.4, blur: 1.0 };

/**
 * @param {Array} segments  tagged segments {id,start,end,category,severity,action?,source?,confidence?}
 * @param {object} profile  viewer profile (see ratings.defaultProfile)
 * @param {object} [opts]
 * @param {{include?:string[],exclude?:string[]}} [opts.overrides] per-segment overrides from a published skip list
 * @param {number} [opts.padBefore=0.25] seconds added before each filtered region
 * @param {number} [opts.padAfter=0.25]  seconds added after each filtered region
 * @returns {{ actions: Array, flagged: Array, ignored: Array }}
 *   actions  merged regions to act on {start,end,action,segmentIds,reasons}
 *   flagged  every segment with a decision attached, for the timeline UI
 */
export function buildPlan(segments, profile, opts = {}) {
  const resolved = resolveProfile(profile);
  const include = new Set(opts.overrides?.include || []);
  const exclude = new Set(opts.overrides?.exclude || []);
  const padBefore = opts.padBefore ?? 0.25;
  const padAfter = opts.padAfter ?? 0.25;

  const flagged = [];
  const raw = [];
  for (const seg of segments || []) {
    if (!(seg && seg.end > seg.start)) continue;
    const id = seg.id != null ? String(seg.id) : `${seg.category}@${seg.start}`;
    let decision;
    if (exclude.has(id)) decision = 'allowed-by-list';
    else if (include.has(id)) decision = 'filter';
    else if (!exceeds(seg, resolved)) decision = 'allowed';
    else if (MACHINE_SOURCES.has(seg.source)) {
      const confident = (seg.confidence ?? 0) >= resolved.ai.minConfidence;
      decision = resolved.ai.enabled && confident ? 'filter' : 'suggested';
    } else decision = 'filter';

    const action = resolved.actions[seg.category] || seg.action || 'skip';
    flagged.push({ ...seg, id, decision, action });
    if (decision === 'filter') {
      raw.push({
        start: Math.max(0, seg.start - padBefore),
        end: seg.end + padAfter,
        action,
        segmentIds: [id],
        reasons: [{ category: seg.category, severity: seg.severity }],
      });
    }
  }

  const actions = mergeRegions(raw);
  flagged.sort((a, b) => a.start - b.start);
  return { actions, flagged, profile: resolved };
}

/** Merge overlapping or near-adjacent regions that share an action. */
export function mergeRegions(regions) {
  const byAction = new Map();
  for (const r of regions) {
    if (!byAction.has(r.action)) byAction.set(r.action, []);
    byAction.get(r.action).push(r);
  }
  const out = [];
  for (const [action, list] of byAction) {
    list.sort((a, b) => a.start - b.start);
    const gap = MERGE_GAP[action] ?? 0.5;
    let cur = null;
    for (const r of list) {
      if (cur && r.start <= cur.end + gap) {
        cur.end = Math.max(cur.end, r.end);
        cur.segmentIds.push(...r.segmentIds);
        cur.reasons.push(...r.reasons);
      } else {
        if (cur) out.push(cur);
        cur = { ...r, segmentIds: [...r.segmentIds], reasons: [...r.reasons] };
      }
    }
    if (cur) out.push(cur);
  }
  // Mute/blur regions entirely inside a skip region never play; drop them.
  const skips = out.filter((r) => r.action === 'skip');
  const kept = out.filter((r) => r.action === 'skip' || !skips.some((s) => s.start <= r.start && s.end >= r.end));
  kept.sort((a, b) => a.start - b.start || a.end - b.end);
  return kept.map((r, i) => ({ ...r, key: `${r.action}:${i}:${r.start.toFixed(2)}`, reasons: dedupeReasons(r.reasons) }));
}

function dedupeReasons(reasons) {
  const best = new Map();
  for (const r of reasons) best.set(r.category, Math.max(best.get(r.category) || 0, r.severity));
  return [...best].map(([category, severity]) => ({ category, severity }));
}

/**
 * What should be happening at content time `time`?
 * @param {number} time        current content time, seconds
 * @param {Array}  actions     plan.actions
 * @param {object} [opts]
 * @param {Set<string>} [opts.disabled] region keys the viewer chose to let play
 * @param {number} [opts.lead=0.15] react this many seconds early (polling latency)
 * @returns {{ skipTo: number|null, skipRegion: object|null, mute: boolean, blur: boolean, active: Array }}
 */
export function decide(time, actions, opts = {}) {
  const disabled = opts.disabled || new Set();
  const lead = opts.lead ?? 0.15;
  const result = { skipTo: null, skipRegion: null, mute: false, blur: false, active: [] };
  for (const r of actions) {
    if (disabled.has(r.key)) continue;
    if (time < r.start - lead || time >= r.end) continue;
    result.active.push(r);
    if (r.action === 'skip') {
      if (result.skipTo === null || r.end > result.skipTo) {
        result.skipTo = r.end;
        result.skipRegion = r;
      }
    } else if (r.action === 'mute') result.mute = true;
    else if (r.action === 'blur') result.blur = true;
  }
  // Chained skips: if the landing point is inside another skip region, jump
  // straight to the end of the chain.
  if (result.skipTo !== null) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const r of actions) {
        if (r.action !== 'skip' || disabled.has(r.key)) continue;
        if (r.start <= result.skipTo && r.end > result.skipTo) {
          result.skipTo = r.end;
          moved = true;
        }
      }
    }
  }
  return result;
}

/** Seconds of runtime removed by skip regions (for "this cut is 4m12s shorter"). */
export function skippedSeconds(actions, duration = Infinity) {
  return actions
    .filter((r) => r.action === 'skip')
    .reduce((sum, r) => sum + Math.max(0, Math.min(r.end, duration) - r.start), 0);
}
