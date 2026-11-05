// Decoded audio, kept on the media clock until it is transcribed. Pure code
// (no browser APIs), so the tests run it in Node.
//
// Audio arrives as short decoded blocks (an Opus frame is 20 ms, an AAC frame
// 21 ms), mixed to mono at the stream's own rate. Blocks that follow each
// other are joined into runs; a seek or a gap starts a new run. A window is
// read out at 16 kHz, the model's rate.

export const MODEL_RATE = 16000;
const JOIN = 0.03; // seconds: blocks closer than this belong to one run

export class PcmStore {
  constructor() {
    this.runs = []; // { start, rate, data: Float32Array, length } sorted by start
  }

  /** Add a mono block that starts at `time` (seconds). Already-covered audio is ignored. */
  add(time, rate, samples) {
    const n = samples.length;
    if (!n || !Number.isFinite(time)) return;
    const end = time + n / rate;
    for (const r of this.runs) {
      const rEnd = r.start + r.length / r.rate;
      if (r.rate === rate && Math.abs(time - rEnd) < JOIN) {
        // Continues this run: append (a few samples of gap or overlap are absorbed).
        this.grow(r, samples);
        this.mergeAfter(r);
        return;
      }
      if (time >= r.start - 0.001 && end <= rEnd + 0.001) return; // already there
    }
    const run = { start: time, rate, data: new Float32Array(Math.max(n, rate * 8)), length: 0 };
    this.grow(run, samples);
    this.runs.push(run);
    this.runs.sort((a, b) => a.start - b.start);
    this.mergeAfter(run);
  }

  grow(run, samples) {
    if (run.length + samples.length > run.data.length) {
      const bigger = new Float32Array(Math.max(run.length + samples.length, run.data.length * 2));
      bigger.set(run.data.subarray(0, run.length));
      run.data = bigger;
    }
    run.data.set(samples, run.length);
    run.length += samples.length;
  }

  /** A run that now reaches the next one is joined to it. */
  mergeAfter(run) {
    const i = this.runs.indexOf(run);
    const next = this.runs[i + 1];
    if (!next || next.rate !== run.rate) return;
    const end = run.start + run.length / run.rate;
    if (next.start - end > JOIN) return;
    const skip = Math.max(0, Math.round((end - next.start) * run.rate));
    if (skip < next.length) this.grow(run, next.data.subarray(skip, next.length));
    this.runs.splice(i + 1, 1);
  }

  /** Time ranges with audio: [[start, end], …]. */
  ranges() {
    return this.runs.map((r) => [r.start, r.start + r.length / r.rate]);
  }

  /** Forget audio that ends before `time` (already played). */
  dropBefore(time) {
    this.runs = this.runs.filter((r) => r.start + r.length / r.rate >= time);
  }

  clear() {
    this.runs = [];
  }

  /** Bytes held, for the memory budget. */
  bytes() {
    return this.runs.reduce((n, r) => n + r.data.byteLength, 0);
  }

  /** [from, to) at 16 kHz; silence where there is no audio. */
  read(from, to) {
    const out = new Float32Array(Math.max(0, Math.round((to - from) * MODEL_RATE)));
    for (const r of this.runs) {
      const rEnd = r.start + r.length / r.rate;
      if (rEnd <= from || r.start >= to) continue;
      const a = Math.max(from, r.start);
      const b = Math.min(to, rEnd);
      // A little context either side so the filter has no edge at the cut.
      const pad = 64;
      const i0 = Math.max(0, Math.floor((a - r.start) * r.rate) - pad);
      const i1 = Math.min(r.length, Math.ceil((b - r.start) * r.rate) + pad);
      const res = resample(r.data.subarray(i0, i1), r.rate, MODEL_RATE);
      const resStart = r.start + i0 / r.rate;
      const o0 = Math.max(0, Math.round((a - from) * MODEL_RATE));
      const o1 = Math.min(out.length, Math.round((b - from) * MODEL_RATE));
      const skip = Math.round((a - resStart) * MODEL_RATE);
      for (let o = o0, k = skip; o < o1 && k < res.length; o++, k++) out[o] = res[k];
    }
    return out;
  }
}

// Low-pass FIR (windowed sinc) at 0.45 × the output rate, then linear
// interpolation: enough for speech recognition, which looks at 0–8 kHz.
const kernels = new Map();
function kernel(ratio) {
  const key = ratio.toFixed(5);
  if (kernels.has(key)) return kernels.get(key);
  const taps = 33;
  const fc = 0.45 * ratio; // cycles per input sample
  const k = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - (taps - 1) / 2;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1)); // Blackman
    k[i] = sinc * w;
    sum += k[i];
  }
  for (let i = 0; i < taps; i++) k[i] /= sum;
  kernels.set(key, k);
  return k;
}

/** Resample mono float audio. */
export function resample(input, from, to = MODEL_RATE) {
  if (from === to) return input.slice();
  const ratio = to / from;
  let x = input;
  if (ratio < 1) {
    const k = kernel(ratio);
    const half = (k.length - 1) / 2;
    x = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let acc = 0;
      for (let j = 0; j < k.length; j++) {
        const idx = i + j - half;
        if (idx >= 0 && idx < input.length) acc += input[idx] * k[j];
      }
      x[i] = acc;
    }
  }
  const n = Math.floor(input.length * ratio);
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const a = Math.floor(p);
    const f = p - a;
    out[i] = a + 1 < x.length ? x[a] * (1 - f) + x[a + 1] * f : x[a] || 0;
  }
  return out;
}

/** Root-mean-square level of audio (0 … 1). */
export function rms(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return to > from ? Math.sqrt(s / (to - from)) : 0;
}

/**
 * Where to end a window near `end` (seconds from the window start): the
 * quietest 100 ms in the last `look` seconds, so a word is not cut in two.
 */
export function quietCut(x, end, look = 3, rate = MODEL_RATE) {
  const frame = Math.round(0.1 * rate);
  const hi = Math.min(x.length, Math.round(end * rate));
  const lo = Math.max(0, hi - Math.round(look * rate));
  let best = hi;
  let bestLevel = Infinity;
  for (let i = hi - frame; i >= lo; i -= frame / 2) {
    const level = rms(x, i, i + frame);
    if (level < bestLevel * 0.85) {
      bestLevel = level;
      best = i + frame / 2;
    }
  }
  return best / rate;
}
