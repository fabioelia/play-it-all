#!/usr/bin/env node
// cleancut-scan: scan-ahead outside the browser.
//
// Streaming services encrypt their video (DRM), so a browser extension cannot
// look at the frames. This tool runs the visual models offline, on a file you
// have lawful access to (your own rip, a screener, a broadcast recording), and
// publishes machine-detected segments to the community database, where they
// show up as suggestions until people confirm them.
//
//   cleancut-scan subtitles <file.srt|vtt|dfxp> [--word]
//   cleancut-scan video <file> [--model <dir|file.onnx> --map nsfw=nudity] [--subs <file>]
//                              [--fps 1] [--threshold 0.6] [--start s] [--end s]
//   cleancut-scan publish <scan.json> --platform netflix --id 70248288
//                              [--series .. --season .. --episode .. --name ..]
//                              [--server http://localhost:8787] [--key cc_...]
//
// Output is JSON on stdout (use -o file to write it); progress goes to stderr.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { analyzeCues } from '../../shared/analyzer.js';
import { parseSubtitles } from '../../shared/subtitles.js';
import { validateSegment } from '../../shared/validate.js';
import { formatTime } from '../../shared/identity.js';
import { heuristicClassifier, onnxClassifier, parseLabelMap } from './classifiers.js';
import { probeDuration, sampleFrames } from './frames.js';
import { scoresToSegments } from './timeline.js';

const HELP = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 20).filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n');

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string' },
    map: { type: 'string', default: 'nsfw=nudity' },
    labels: { type: 'string' },
    subs: { type: 'string' },
    fps: { type: 'string', default: '1' },
    threshold: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    word: { type: 'boolean', default: false },
    platform: { type: 'string' },
    id: { type: 'string' },
    series: { type: 'string' },
    season: { type: 'string' },
    episode: { type: 'string' },
    name: { type: 'string' },
    server: { type: 'string', default: process.env.CLEANCUT_SERVER || 'http://localhost:8787' },
    key: { type: 'string', default: process.env.CLEANCUT_API_KEY },
    output: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
  },
});

const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);
const emit = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  if (opt.output) {
    writeFileSync(opt.output, json);
    log(`wrote ${opt.output}`);
  } else process.stdout.write(`${json}\n`);
};

function summarize(segments) {
  for (const s of segments) {
    log(`  ${formatTime(s.start).padStart(7)}–${formatTime(s.end).padEnd(7)} ${s.category.padEnd(11)} sev ${s.severity}  conf ${Math.round(s.confidence * 100)}%  ${s.note || ''}`);
  }
}

function scanSubtitles(file) {
  const cues = parseSubtitles(readFileSync(file, 'utf8'));
  if (!cues.length) throw new Error(`no cues found in ${file} (supported: SRT, WebVTT, TTML/DFXP)`);
  return { cues, segments: analyzeCues(cues, { languageMode: opt.word ? 'word' : 'line' }) };
}

async function scanVideo(file) {
  const fps = Number(opt.fps);
  if (!(fps > 0 && fps <= 10)) throw new Error('--fps must be between 0 and 10');
  const classifier = opt.model
    ? await onnxClassifier({
      model: opt.model,
      map: parseLabelMap(opt.map),
      labels: opt.labels ? Object.fromEntries(opt.labels.split(',').map((p) => p.split('='))) : undefined,
    })
    : heuristicClassifier();
  const size = classifier.size || 224;
  const threshold = opt.threshold ? Number(opt.threshold) : opt.model ? 0.6 : 0.3;
  const duration = await probeDuration(file);
  const start = opt.start ? Number(opt.start) : 0;
  const end = opt.end ? Number(opt.end) : duration;
  log(`scanning ${file} (${formatTime(duration)}) with ${classifier.name} at ${fps} fps…`);

  const samples = [];
  const t0 = Date.now();
  let lastReport = 0;
  for await (const frame of sampleFrames(file, { fps, size, start, end: opt.end ? end : undefined })) {
    samples.push({ time: frame.time, scores: await classifier.score(frame.rgb, size) });
    if (Date.now() - lastReport > 2000) {
      lastReport = Date.now();
      log(`  ${formatTime(frame.time)} / ${formatTime(end)}  (${(samples.length / ((Date.now() - t0) / 1000)).toFixed(1)} frames/s)`);
    }
  }
  const segments = scoresToSegments(samples, { threshold, interval: 1 / fps });
  if (!opt.model) for (const s of segments) s.note = `heuristic: ${s.note}`;
  log(`  ${samples.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { duration, classifier: classifier.name, fps, threshold, segments, samples: samples.length };
}

async function publish(file) {
  if (!opt.platform || !opt.id) throw new Error('publish needs --platform and --id (the platform\'s video id the times were measured against)');
  if (!opt.key) throw new Error('publish needs --key (or CLEANCUT_API_KEY); create an account in the extension options');
  const scan = JSON.parse(readFileSync(file, 'utf8'));
  const segments = (scan.segments || []).map((s, i) => {
    const v = validateSegment({ ...s, source: s.source === 'subtitles' ? 'subtitles' : 'scanner' });
    if (!v.ok) throw new Error(`segment ${i}: ${v.error}`);
    return v.segment;
  });
  if (!segments.length) throw new Error('nothing to publish');
  const title = {
    platform: opt.platform,
    platformId: opt.id,
    series: opt.series,
    season: opt.season,
    episode: opt.episode,
    name: opt.name,
    duration: scan.duration,
  };
  const res = await fetch(`${opt.server.replace(/\/+$/, '')}/v1/segments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opt.key}` },
    body: JSON.stringify({ title, segments }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  log(`published ${body.ids.length} segments for ${body.title.titleKey}${body.title.canonicalKey ? ` (${body.title.canonicalKey})` : ''}`);
  return body;
}

async function main() {
  const [cmd, file] = positionals;
  if (opt.help || !cmd || !file) {
    process.stdout.write(`${HELP}\n`);
    process.exit(opt.help ? 0 : 1);
  }
  if (cmd === 'subtitles') {
    const { cues, segments } = scanSubtitles(file);
    log(`${cues.length} cues → ${segments.length} segments`);
    summarize(segments);
    emit({ source: 'subtitles', file, segments });
  } else if (cmd === 'video') {
    const result = await scanVideo(file);
    if (opt.subs) {
      const subs = scanSubtitles(opt.subs);
      result.segments = [...result.segments, ...subs.segments].sort((a, b) => a.start - b.start);
    }
    log(`${result.segments.length} segments`);
    summarize(result.segments);
    emit({ source: 'scanner', file, ...result });
  } else if (cmd === 'publish') {
    emit(await publish(file));
  } else {
    throw new Error(`unknown command "${cmd}" — use subtitles, video or publish`);
  }
}

main().catch((e) => {
  log(`error: ${e.message}`);
  process.exit(1);
});
