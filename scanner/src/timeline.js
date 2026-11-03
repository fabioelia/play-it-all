// Per-frame scores → segments. Hysteresis keeps one flickering frame from
// opening or closing a scene; nearby scenes merge; brief blips are dropped.

/**
 * @param {Array<{ time:number, scores:Record<string,number> }>} samples  in time order
 * @param {object} [o]
 * @param {number} [o.threshold=0.6]   score that opens a scene
 * @param {number} [o.exitRatio=0.6]   scene stays open while score ≥ threshold × exitRatio
 * @param {number} [o.exitSamples=2]   consecutive low samples needed to close
 * @param {number} [o.interval=1]      seconds between samples
 * @param {number} [o.minDuration=1]   drop scenes shorter than this (before padding)
 * @param {number} [o.pad=1]           seconds added on both sides
 * @param {number} [o.mergeGap=3]      join scenes of a category closer than this
 */
export function scoresToSegments(samples, o = {}) {
  const threshold = o.threshold ?? 0.6;
  const exit = threshold * (o.exitRatio ?? 0.6);
  const exitSamples = o.exitSamples ?? 2;
  const interval = o.interval ?? 1;
  const minDuration = o.minDuration ?? 1;
  const pad = o.pad ?? 1;
  const mergeGap = o.mergeGap ?? 3;

  const categories = new Set(samples.flatMap((s) => Object.keys(s.scores)));
  const out = [];
  for (const category of categories) {
    const scenes = [];
    let cur = null;
    let low = 0;
    const close = () => {
      if (cur && cur.last - cur.first + interval >= minDuration) scenes.push(cur);
      cur = null;
      low = 0;
    };
    for (const { time, scores } of samples) {
      const p = scores[category] ?? 0;
      if (!cur) {
        if (p >= threshold) cur = { first: time, last: time, peak: p, sum: p, n: 1 };
        continue;
      }
      if (p >= exit) {
        cur.last = time;
        cur.peak = Math.max(cur.peak, p);
        cur.sum += p;
        cur.n++;
        low = 0;
      } else if (++low >= exitSamples) close();
    }
    close();

    const merged = [];
    for (const s of scenes) {
      const prev = merged[merged.length - 1];
      if (prev && s.first - (prev.last + interval) <= mergeGap) {
        prev.last = s.last;
        prev.peak = Math.max(prev.peak, s.peak);
        prev.sum += s.sum;
        prev.n += s.n;
      } else merged.push({ ...s });
    }
    for (const s of merged) {
      out.push({
        start: round(Math.max(0, s.first - pad)),
        end: round(s.last + interval + pad),
        category,
        severity: s.peak >= 0.9 ? 3 : s.peak >= 0.75 ? 2 : 1,
        source: 'scanner',
        confidence: round(s.sum / s.n),
        note: `peak ${Math.round(s.peak * 100)}% over ${s.n} frame${s.n === 1 ? '' : 's'}`,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const round = (n) => Math.round(n * 100) / 100;
