// Summarise a Chrome DevTools Performance recording (Save profile… → .json or
// .json.gz) from a real streaming page: who used the main thread, how frames
// were presented, input latency, and whether CleanCut acted during it.
//
//   node test/perf/analyze-trace.mjs ~/Downloads/Trace-2026….json.gz
//
// The first long "EvaluateScript" task of a recording is usually DevTools
// starting its CPU profiler; it is detected and left out.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('usage: node test/perf/analyze-trace.mjs <trace.json[.gz]>');
  process.exit(1);
}
let buf = readFileSync(file);
if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
const doc = JSON.parse(buf.toString('utf8'));
const ev = Array.isArray(doc) ? doc : doc.traceEvents;
const win = doc.metadata?.modifications?.initialBreadcrumb?.window;
const tsAll = ev.filter((e) => e.ts > 0).map((e) => e.ts);
let T0 = win?.min ?? Math.min(...tsAll);
const T1 = win?.max ?? Math.max(...tsAll);

const KNOWN = { eobandplahgajplceghpgpambpdcnoee: 'CleanCut (unpacked)' };
const threads = new Map(ev.filter((e) => e.name === 'thread_name').map((e) => [`${e.pid}:${e.tid}`, e.args.name]));
const procs = new Map(ev.filter((e) => e.name === 'process_name').map((e) => [e.pid, e.args.name]));
const tkey = (e) => `${e.pid}:${e.tid}`;

// CleanCut's scripts are content.js + page-hook.js from one extension id.
const extFiles = new Map();
for (const e of ev) {
  for (const n of e.name === 'ProfileChunk' ? e.args.data.cpuProfile?.nodes || [] : []) {
    const u = n.callFrame?.url || '';
    if (u.startsWith('chrome-extension://')) {
      const [, , id, ...rest] = u.split('/');
      if (!extFiles.has(id)) extFiles.set(id, new Set());
      extFiles.get(id).add(rest.join('/'));
    }
  }
}
for (const [id, files] of extFiles) if (files.has('page-hook.js') && files.has('content.js')) KNOWN[id] ||= 'CleanCut';
const owner = (url) => {
  if (!url) return null;
  if (url.startsWith('chrome-extension://')) {
    const id = url.split('/')[2];
    return KNOWN[id] || `extension ${id.slice(0, 8)}… (${[...(extFiles.get(id) || [])].slice(0, 2).join(', ')})`;
  }
  try {
    return `page: ${new URL(url).hostname}`;
  } catch {
    return 'other';
  }
};

// Skip DevTools' own profiler start-up.
const startup = ev.find((e) => e.name === 'EvaluateScript' && e.dur > 100_000 && e.ts - T0 < 50_000);
if (startup) T0 = startup.ts + startup.dur;
const secs = (T1 - T0) / 1e6;
const inWin = (e) => e.ts >= T0 && e.ts <= T1;

// ---- main thread CPU by owner ----------------------------------------------------
const profiles = new Map();
for (const e of ev) {
  if (e.name === 'Profile') (profiles.get(e.id) || profiles.set(e.id, { nodes: new Map(), samples: [], deltas: [] }).get(e.id)).start = e.args.data.startTime;
  if (e.name === 'ProfileChunk') {
    const p = profiles.get(e.id) || profiles.set(e.id, { nodes: new Map(), samples: [], deltas: [] }).get(e.id);
    for (const n of e.args.data.cpuProfile?.nodes || []) p.nodes.set(n.id, n);
    p.samples.push(...(e.args.data.cpuProfile?.samples || []));
    p.deltas.push(...(e.args.data.timeDeltas || []));
  }
}
const byOwner = new Map();
const byFn = new Map();
let jsTotal = 0;
for (const p of profiles.values()) {
  const parent = new Map();
  for (const n of p.nodes.values()) for (const c of n.children || []) parent.set(c, n.id);
  let t = p.start ?? T0;
  p.samples.forEach((sid, i) => {
    const dt = p.deltas[i] || 0;
    t += dt;
    if (t < T0 || t > T1 || dt <= 0) return;
    const n = p.nodes.get(sid);
    const fn = n?.callFrame.functionName || '(anonymous)';
    if (!n || ['(idle)', '(program)', '(root)'].includes(fn)) return;
    let url = n.callFrame.url;
    let k = sid;
    while (!url && parent.has(k)) url = p.nodes.get((k = parent.get(k))).callFrame.url;
    const o = fn === '(garbage collector)' ? 'garbage collector' : owner(url) || 'browser internals';
    byOwner.set(o, (byOwner.get(o) || 0) + dt);
    jsTotal += dt;
    const f = `${fn} ${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber + 1}`;
    byFn.set(`${o}|${f}`, (byFn.get(`${o}|${f}`) || 0) + dt);
  });
}

// ---- thread busy, long tasks ---------------------------------------------------------
const busy = new Map();
const longTasks = [];
for (const e of ev) {
  if (e.name !== 'RunTask' || e.ph !== 'X' || !inWin(e)) continue;
  const k = `${procs.get(e.pid) || e.pid} / ${threads.get(tkey(e)) || e.tid}`;
  busy.set(k, (busy.get(k) || 0) + e.dur);
  if (threads.get(tkey(e)) === 'CrRendererMain' && e.dur > 50_000) longTasks.push(e);
}

// ---- frames, input, media --------------------------------------------------------------
const frames = {};
for (const e of ev) {
  if (e.name === 'PipelineReporter' && e.ph === 'b' && inWin(e)) {
    const s = e.args?.frame_reporter?.state || 'unknown';
    frames[s] = (frames[s] || 0) + 1;
    if (e.args?.frame_reporter?.affects_smoothness) frames.affects_smoothness = (frames.affects_smoothness || 0) + 1;
  }
}
const input = new Map();
const open = new Map();
for (const e of ev) {
  if (!e.name?.startsWith('InputLatency::') || !inWin(e)) continue;
  const id = `${e.name}:${e.id ?? e.id2?.local}`;
  if (e.ph === 'b') open.set(id, e.ts);
  if (e.ph === 'e' && open.has(id)) (input.get(e.name) || input.set(e.name, []).get(e.name)).push((e.ts - open.get(id)) / 1e3);
  if (e.ph === 'X') (input.get(e.name) || input.set(e.name, []).get(e.name)).push(e.dur / 1e3);
}
const media = {};
for (const e of ev) {
  if (e.name === 'EventDispatch' && inWin(e)) {
    const type = e.args.data.type;
    if (['seeking', 'seeked', 'volumechange', 'waiting', 'stalled', 'pause', 'play'].includes(type)) media[type] = (media[type] || 0) + 1;
  }
}
const cleanCutInvalidations = ev.filter((e) => ['ScheduleStyleRecalculation', 'InvalidateLayout'].includes(e.name) && inWin(e)
  && /CleanCut/.test(owner(e.args?.data?.stackTrace?.[0]?.url || '') || '')).length;

// ---- report -------------------------------------------------------------------------------
const ms = (us) => (us / 1000).toFixed(1);
console.log(`\n${file}\n${secs.toFixed(2)} s analysed${startup ? ` (skipped ${ms(startup.dur)} ms of DevTools profiler start-up)` : ''}\n`);
console.log('Main-thread JavaScript by owner            ms   ms/s');
for (const [o, v] of [...byOwner].sort((a, b) => b[1] - a[1])) console.log(`  ${o.slice(0, 38).padEnd(38)} ${ms(v).padStart(7)} ${(v / 1000 / secs).toFixed(2).padStart(6)}`);
console.log(`  ${'total'.padEnd(38)} ${ms(jsTotal).padStart(7)}  (${((jsTotal / 1e6 / secs) * 100).toFixed(1)}% of the time)`);
const cc = [...byFn].filter(([k]) => k.startsWith('CleanCut')).sort((a, b) => b[1] - a[1]).slice(0, 8);
if (cc.length) {
  console.log('\nCleanCut functions');
  for (const [k, v] of cc) console.log(`  ${ms(v).padStart(7)} ms  ${k.split('|')[1]}`);
}
console.log('\nBusiest threads (ms)');
for (const [k, v] of [...busy].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${ms(v).padStart(8)}  ${k}`);
console.log(`\nLong tasks on the page's main thread (>50 ms): ${longTasks.length}${longTasks.length ? ` — ${longTasks.map((e) => `${ms(e.dur)} ms @ ${ms(e.ts - T0)} ms`).join(', ')}` : ''}`);
console.log(`Frames: ${Object.entries(frames).map(([k, v]) => `${k.replace('STATE_', '').toLowerCase()} ${v}`).join(', ') || 'no frame data (enable "Screenshots"/frames in the recording)'}`);
for (const [name, arr] of input) {
  arr.sort((a, b) => a - b);
  console.log(`Input ${name.replace('InputLatency::', '')}: n=${arr.length} median ${arr[arr.length >> 1].toFixed(0)} ms, max ${arr[arr.length - 1].toFixed(0)} ms`);
}
console.log(`Player events: ${Object.entries(media).map(([k, v]) => `${k} ${v}`).join(', ') || 'none (no seek, mute or pause during the recording)'}`);
console.log(`Style/layout invalidations from CleanCut: ${cleanCutInvalidations}\n`);
