import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignCues, fingerprint } from '../shared/align.js';

// Deterministic pseudo-random so failures reproduce.
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
function episodeCues(seed, n = 500, length = 3300) {
  const r = rng(seed);
  const out = [];
  let t = 30;
  while (out.length < n && t < length) {
    out.push(Math.round(t * 1000) / 1000);
    t += 1.2 + r() * 6;
  }
  return out;
}
function transform(cues, { speed = 1, offset = 0, jitter = 0.08, drop = 0.15, extra = 0.1, seed = 7 }) {
  const r = rng(seed);
  const out = [];
  for (const c of cues) if (r() > drop) out.push(c * speed + offset + (r() - 0.5) * 2 * jitter);
  const n = Math.floor(cues.length * extra);
  for (let i = 0; i < n; i++) out.push(r() * 3300); // cues the other platform does not have
  return out;
}

test('finds a plain offset despite jitter, dropped and extra cues', () => {
  const ref = episodeCues(1);
  const a = alignCues(ref, transform(ref, { offset: 12.4 }));
  assert.ok(a, 'aligned');
  assert.equal(a.speed, 1);
  assert.ok(Math.abs(a.offset - 12.4) < 0.1, `offset ${a.offset}`);
  assert.ok(a.ratio > 0.7, `ratio ${a.ratio}`);
});

test('finds negative offsets (local starts earlier)', () => {
  const ref = episodeCues(2);
  const a = alignCues(ref, transform(ref, { offset: -47.25 }));
  assert.ok(Math.abs(a.offset + 47.25) < 0.1, `offset ${a.offset}`);
});

test('handles PAL speed-up (25 fps encode of a 23.976 fps master)', () => {
  const ref = episodeCues(3);
  const speed = 23.976 / 25;
  const a = alignCues(ref, transform(ref, { speed, offset: 3 }));
  assert.ok(a, 'aligned');
  assert.equal(a.speed, speed);
  assert.ok(Math.abs(a.offset - 3) < 0.15, `offset ${a.offset}`);
});

test('works from a sparse fingerprint against a full local track', () => {
  const ref = episodeCues(4, 900);
  const fp = fingerprint(ref, 200);
  assert.equal(fp.length, 200);
  const a = alignCues(fp, transform(ref, { offset: 8.8, drop: 0.05 }));
  assert.ok(Math.abs(a.offset - 8.8) < 0.1, `offset ${a.offset}`);
});

test('refuses to align unrelated episodes', () => {
  assert.equal(alignCues(episodeCues(5), episodeCues(6)), null);
  assert.equal(alignCues([1, 2, 3], [1, 2, 3]), null); // too few cues to trust
});
