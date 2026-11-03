import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoresToSegments } from '../scanner/src/timeline.js';
import { heuristicClassifier, parseLabelMap } from '../scanner/src/classifiers.js';
import { sampleFrames } from '../scanner/src/frames.js';

const series = (values, category = 'nudity') => values.map((p, i) => ({ time: i, scores: { [category]: p } }));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
// The CLI talks to an in-process server, so it must not block our event loop.
const runCli = (args) => new Promise((resolve) => execFile(process.execPath, [cli, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => resolve({ status: err ? err.code ?? 1 : 0, stdout, stderr })));
const catalogCli = fileURLToPath(new URL('../scripts/catalog.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../scanner/src/cli.js', import.meta.url));

test('scoresToSegments: hysteresis bridges a dip, padding, severity from peak', () => {
  //                       0  1  2    3    4    5    6    7  8  9
  const segs = scoresToSegments(series([0, 0, 0.7, 0.95, 0.4, 0.8, 0.1, 0, 0, 0]), { pad: 0.5 });
  assert.equal(segs.length, 1);
  assert.deepEqual([segs[0].start, segs[0].end], [1.5, 6.5]); // frames 2–5, +1 s interval, ±0.5 pad
  assert.equal(segs[0].severity, 3);
  assert.equal(segs[0].source, 'scanner');
});

test('scoresToSegments: single-frame blips are kept only above minDuration; nearby scenes merge', () => {
  assert.equal(scoresToSegments(series([0, 0.9, 0, 0, 0]), { minDuration: 2 }).length, 0);
  const merged = scoresToSegments(series([0.8, 0.8, 0, 0, 0, 0.8, 0.8, 0, 0]), { pad: 0, mergeGap: 3 });
  assert.equal(merged.length, 1);
  const apart = scoresToSegments(series([0.8, 0.8, 0, 0, 0, 0, 0, 0.8, 0.8]), { pad: 0, mergeGap: 3 });
  assert.equal(apart.length, 2);
});

test('parseLabelMap validates categories', () => {
  assert.deepEqual(parseLabelMap('nsfw=nudity, blood=gore'), { nsfw: 'nudity', blood: 'gore' });
  assert.throws(() => parseLabelMap('nsfw=porn'), /category must be one of/);
});

test('heuristic classifier scores are capped below the default AI confidence', async () => {
  const c = heuristicClassifier();
  const skin = Buffer.alloc(224 * 224 * 3);
  for (let i = 0; i < skin.length; i += 3) skin.set([224, 172, 105], i);
  const s = await c.score(skin, 224);
  assert.equal(s.nudity, 0.5);
  const grey = await c.score(Buffer.alloc(224 * 224 * 3, 128), 224);
  assert.equal(grey.nudity, 0);
});

test('video pipeline finds a synthetic scene and publishes it', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleancut-scan-'));
  const video = join(dir, 'clip.webm');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x303040:s=160x90:r=10:d=12',
    '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=0xE0AC69:t=fill:enable='between(t,4,8)'", '-c:v', 'libvpx', video]);
  let frames = 0;
  for await (const f of sampleFrames(video, { fps: 2, size: 32 })) {
    frames++;
    assert.equal(f.rgb.length, 32 * 32 * 3);
  }
  assert.ok(frames >= 23 && frames <= 25, `${frames} frames`);

  const out = join(dir, 'scan.json');
  execFileSync(process.execPath, [cli, 'video', video, '-o', out], { stdio: 'pipe' });
  const scan = JSON.parse((await import('node:fs')).readFileSync(out, 'utf8'));
  const nud = scan.segments.filter((s) => s.category === 'nudity');
  assert.equal(nud.length, 1, JSON.stringify(scan.segments));
  assert.ok(nud[0].start <= 4 && nud[0].start >= 2, `start ${nud[0].start}`);
  assert.ok(nud[0].end >= 8 && nud[0].end <= 10.5, `end ${nud[0].end}`);
  assert.ok(nud[0].confidence <= 0.5);

  // export a catalog submission and merge it into an empty catalog
  const subFile = join(dir, 'submission.json');
  const exp = await runCli(['export', out, '--platform', 'web', '--id', 'clip-1', '--name', 'Clip', '--year', '2026', '-o', subFile]);
  assert.equal(exp.status, 0, exp.stderr);
  const submission = JSON.parse((await import('node:fs')).readFileSync(subFile, 'utf8'));
  assert.equal(submission.cleancut, 1);
  assert.ok(submission.segments.every((x) => x.source === 'scanner' && x.confidence <= 0.5));
  const catalogDir = join(dir, 'catalog');
  const ingest = spawnSync(process.execPath, [catalogCli, 'ingest', subFile, '--dir', catalogDir, '--author', 'scanner-bot'], { encoding: 'utf8' });
  assert.equal(ingest.status, 0, ingest.stderr);
  const film = JSON.parse((await import('node:fs')).readFileSync(join(catalogDir, 'movies/clip-2026.json'), 'utf8'));
  assert.equal(film.segments.length, submission.segments.length);
  assert.ok(film.segments.every((x) => x.source === 'scanner'));
  const missing = await runCli(['export', out]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--platform and --id/);
});

test('subtitle scan CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleancut-subs-'));
  const srt = join(dir, 'ep.srt');
  writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\nShit, they found us.\n\n2\n00:00:05,000 --> 00:00:06,000\n[gunfire]\n');
  const res = spawnSync(process.execPath, [cli, 'subtitles', srt], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const { segments } = JSON.parse(res.stdout);
  assert.deepEqual(segments.map((s) => s.category), ['language', 'violence']);
});
