// Cross-platform time alignment from subtitle timing.
//
// The same episode on two services rarely starts at the same instant: one has
// a studio logo, another a recap, and some regions play 25 fps encodes of
// 23.976 fps masters (about 4% faster). Subtitle cue start times are a
// fingerprint of the programme's timing that survives all of that, so we fit
//
//     local = reference × speed + offset
//
// by voting: for each candidate speed, every pair of cues casts a vote for
// the offset it implies; the true offset collects votes from most cues while
// wrong pairings scatter. Only timings are compared, never subtitle text.

export const SPEEDS = [1, 23.976 / 25, 25 / 23.976];

function lowerBound(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Count reference cues that land within `tolerance` of a local cue. */
function countMatches(ref, local, speed, offset, tolerance) {
  let n = 0;
  const diffs = [];
  for (const r of ref) {
    const t = r * speed + offset;
    const i = lowerBound(local, t - tolerance);
    if (i < local.length && local[i] <= t + tolerance) {
      n++;
      diffs.push(local[i] - r * speed);
    }
  }
  return { n, diffs };
}

/**
 * @param {number[]} reference  cue start times on the reference timeline
 * @param {number[]} local      cue start times on this platform
 * @param {object} [o]
 * @returns {{ offset:number, speed:number, matches:number, ratio:number } | null}
 *   null when the timings do not match well enough to trust.
 */
export function alignCues(reference, local, o = {}) {
  const tolerance = o.tolerance ?? 0.3;
  const maxOffset = o.maxOffset ?? 600;
  const minMatches = o.minMatches ?? 15;
  const minRatio = o.minRatio ?? 0.35;
  const binSize = o.binSize ?? 0.2;
  const speeds = o.speeds ?? SPEEDS;

  const ref = [...new Set(reference.filter(Number.isFinite))].sort((a, b) => a - b);
  const loc = [...new Set(local.filter(Number.isFinite))].sort((a, b) => a - b);
  if (ref.length < minMatches || loc.length < minMatches) return null;

  let best = null;
  for (const speed of speeds) {
    const votes = new Map();
    for (const r of ref) {
      const base = r * speed;
      const from = lowerBound(loc, base - maxOffset);
      for (let i = from; i < loc.length && loc[i] <= base + maxOffset; i++) {
        const bin = Math.round((loc[i] - base) / binSize);
        votes.set(bin, (votes.get(bin) || 0) + 1);
      }
    }
    // Check the few most-voted offsets (a bin edge can split the true peak).
    const top = [...votes].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [bin] of top) {
      const guess = bin * binSize;
      const first = countMatches(ref, loc, speed, guess, tolerance);
      if (!first.n) continue;
      // Refine to the median residual, then recount.
      const sorted = first.diffs.sort((a, b) => a - b);
      const offset = sorted[Math.floor(sorted.length / 2)];
      const { n } = countMatches(ref, loc, speed, offset, tolerance);
      if (!best || n > best.matches) best = { offset, speed, matches: n };
    }
  }
  if (!best) return null;
  const ratio = best.matches / Math.min(ref.length, loc.length);
  if (best.matches < minMatches || ratio < minRatio) return null;
  return {
    offset: Math.round(best.offset * 100) / 100,
    speed: best.speed,
    matches: best.matches,
    ratio: Math.round(ratio * 100) / 100,
  };
}

/** Compact fingerprint for the catalog: cue starts, 0.1 s precision, capped. */
export function fingerprint(cues, max = 400) {
  const starts = [...new Set(cues.map((c) => Math.round((c.start ?? c) * 10) / 10))].sort((a, b) => a - b);
  if (starts.length <= max) return starts;
  // Keep an even spread across the whole programme rather than the first N.
  const step = starts.length / max;
  return Array.from({ length: max }, (_, i) => starts[Math.floor(i * step)]);
}
