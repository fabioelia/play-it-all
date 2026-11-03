// Cost of the extension on the REAL Netflix site (public pages, no login):
// loads each page in Chromium with and without CleanCut, traces every load,
// and compares main-thread work, long tasks / TBT, compile and code-cache use,
// FCP/LCP/DCL/load, requests and CPU across all of Chromium's processes (from
// /proc). Runs are interleaved and rotated so network drift hits every variant
// alike; repeat until the spread (--verbose) is small next to the difference.
//
//   npm run bench:real                                    title page + home page, none vs full
//   npm run bench:real -- --runs 6 --variants none,full,hook,content,bare
//   npm run bench:real -- --traffic --pages /title/80057281 \
//     --ext before=/path/to/old/dist/chrome,after=extension/dist/chrome --variants none,full@before,full@after
//   ... --with /path/to/adblocker1,/path/to/adblocker2    other extensions in every variant
//   ... --profile                                         + JS time by owner (Netflix, CleanCut, other extensions, GC)
//
// Variants: none (no extension) · full · hook (page hook only) · content
// (content script only) · bare (installed, both scripts off), each optionally
// @label for one of several --ext builds. Parts are switched with the
// extension's own 'setParts' message. Each launch uses a fresh profile and
// loads the page --loads times: load 1 is cold (empty HTTP and code cache),
// later loads are warm, as for a regular viewer. --traffic then replays
// signed-in player traffic on the title page (see trafficRun). Needs network
// access to www.netflix.com, *.nflxext.com and *.nflxso.net; HTTPS_PROXY is
// used when set. Headless Chromium on a shared machine: compare variants
// within one run, not absolute numbers across machines.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { explainLaunchError, loadChromium } from '../support/browser.mjs';

const chromium = loadChromium();
const root = fileURLToPath(new URL('../../', import.meta.url));

const opt = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const RUNS = Number(opt('runs', 4));
const LOADS = Number(opt('loads', 3));
const SETTLE_MS = Number(opt('settle', 5000));
const PAGES = opt('pages', '/title/80057281,/').split(',');
// Builds: --ext path (default extension/dist/chrome) or --ext before=dir1,after=dir2;
// a variant 'full@before' then uses that build.
const EXTS = Object.fromEntries(opt('ext', join(root, 'extension/dist/chrome')).split(',').map((e, i) => {
  const m = /^(\w+)=(.*)$/.exec(e);
  return m ? [m[1], resolve(m[2])] : [i ? `ext${i}` : '', resolve(e)];
}));
const VARIANTS = opt('variants', 'none,full').split(',');
const variantOf = (v) => {
  const [part, label = Object.keys(EXTS)[0]] = v.split('@');
  if (part !== 'none' && !EXTS[label]) throw new Error(`no build called '${label}' (--ext ${label}=dir)`);
  return { part, ext: part === 'none' ? null : EXTS[label] };
};
const TRAFFIC = process.argv.includes('--traffic'); // also emulate logged-in player traffic (see trafficRun)
const PROFILE = process.argv.includes('--profile'); // adds V8 CPU sampling (slower, noisier)
const VERBOSE = process.argv.includes('--verbose');
const DUMP = opt('dump', ''); // write each load's request list to <dump>-<variant>-<n>.txt
const OUT = opt('out', ''); // write every load's metrics as JSON
// Other unpacked extensions loaded in EVERY variant (e.g. the viewer's ad blockers).
const WITH = (opt('with', '') || '').split(',').filter(Boolean).map((d) => resolve(d));
const WITH_WAIT_MS = Number(opt('with-wait', 8000)); // let them initialise (filter lists) before measuring

// Chrome derives an unpacked extension's id from its absolute path.
const unpackedId = (dir) => [...createHash('sha256').update(dir).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

const PARTS = {
  full: { hook: true, content: true },
  hook: { hook: true, content: false },
  content: { hook: false, content: true },
  bare: { hook: false, content: false },
};

const CATEGORIES = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'loading', 'blink.user_timing',
  ...(PROFILE ? ['disabled-by-default-v8.cpu_profiler'] : [])];

// ---- one browser per (variant, page, run) ------------------------------------------

async function launch(name) {
  const { part: variant, ext: EXT } = variantOf(name);
  const dir = mkdtempSync(join(tmpdir(), 'cleancut-real-'));
  const args = ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'];
  const load = [...WITH, ...(variant === 'none' ? [] : [EXT])];
  if (!load.length) args.push('--disable-extensions');
  else args.push(`--disable-extensions-except=${load.join(',')}`, `--load-extension=${load.join(',')}`);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: true, ignoreHTTPSErrors: true, viewport: { width: 1366, height: 800 },
    ...(proxy ? { proxy: { server: proxy } } : {}), args,
  }).catch(explainLaunchError);
  if (variant !== 'none') {
    const id = unpackedId(EXT);
    const ours = () => ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${id}/`));
    for (const end = Date.now() + 15_000; !ours() && Date.now() < end;) await ctx.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => {});
    const opts = await ctx.newPage();
    await opts.goto(`chrome-extension://${id}/options.html`);
    const want = PARTS[variant];
    const deadline = Date.now() + 10_000;
    for (;;) {
      const r = await opts.evaluate((parts) => chrome.runtime.sendMessage({ type: 'setParts', parts }), want);
      const got = await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'getParts' }));
      const ok = got.registered.includes('cleancut-hook') === want.hook && got.registered.includes('cleancut-content') === want.content;
      if (ok) break;
      if (Date.now() > deadline) throw new Error(`could not set parts ${JSON.stringify(want)}: ${JSON.stringify(r)} ${JSON.stringify(got)}`);
      await opts.waitForTimeout(200);
    }
  }
  // The extension opens its options page on install (ad blockers open a welcome
  // page): close every other tab so the page under test is the only, foreground
  // one (background tabs are throttled).
  const page = await ctx.newPage();
  await page.waitForTimeout(WITH.length ? WITH_WAIT_MS : 500);
  for (const other of ctx.pages()) if (other !== page) await other.close();
  await page.bringToFront();
  return { ctx, page, dir };
}

// CPU seconds used by every process of this browser (found by its profile dir).
function processCpu(dir) {
  const out = {};
  const hz = 100;
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    let cmd;
    let stat;
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.includes(dir) && !cmd.includes('--type=')) continue;
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      continue;
    }
    if (!cmd.includes(dir) && !process.env.ALL_CHROMIUM) {
      // child processes do not carry the profile dir: match them by parent chain below
    }
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(f[1]);
    const cpu = (Number(f[11]) + Number(f[12])) / hz;
    const type = /--type=([\w-]+)/.exec(cmd)?.[1] || 'browser';
    const kind = type === 'renderer' && cmd.includes('--extension-process') ? 'extension' : type;
    out[pid] = { ppid, cpu, kind, own: cmd.includes(dir) };
  }
  // Keep the browser (has the dir) and its descendants.
  const mine = new Set(Object.keys(out).filter((p) => out[p].own && out[p].kind === 'browser'));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [p, v] of Object.entries(out)) if (!mine.has(p) && mine.has(String(v.ppid))) { mine.add(p); grew = true; }
  }
  const byKind = {};
  for (const p of mine) byKind[out[p].kind] = (byKind[out[p].kind] || 0) + out[p].cpu;
  return byKind;
}

async function traceLoad(ctx, page, url) {
  await page.goto('about:blank');
  const cdp = await ctx.newCDPSession(page);
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => { for (const x of e.value) events.push(x); });
  await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: CATEGORIES, excludedCategories: ['*'] } });
  let requests = 0;
  let bytes = 0;
  const urls = [];
  const onReq = (r) => { requests++; if (DUMP) urls.push(`${r.resourceType()} ${r.method()} ${r.url().slice(0, 160)}`); };
  const onDone = async (r) => { try { bytes += (await r.sizes()).responseBodySize || 0; } catch { /* ignore */ } };
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
  const loadWall = Date.now() - t0;
  await page.waitForTimeout(SETTLE_MS);
  const web = await page.evaluate(async () => {
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    // LCP entries are only reachable through a (buffered) observer.
    const lcp = await new Promise((done) => {
      let last = null;
      const o = new PerformanceObserver((l) => { last = l.getEntries().at(-1) || last; });
      o.observe({ type: 'largest-contentful-paint', buffered: true });
      setTimeout(() => { o.disconnect(); done(last); }, 50);
    });
    return {
      dcl: nav?.domContentLoadedEventEnd, load: nav?.loadEventEnd, ttfb: nav?.responseStart,
      fcp: fcp?.startTime, lcp: lcp?.startTime ?? null, nodes: document.getElementsByTagName('*').length,
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : null,
      hooked: !String(window.fetch).includes('[native code]'),
      overlay: !!document.querySelector('cleancut-overlay'),
      visible: document.visibilityState,
      // Frames the page produced in 500 ms: a hidden or throttled tab paints none.
      fps: await new Promise((done) => {
        let n = 0;
        const end = performance.now() + 500;
        const f = () => (performance.now() < end ? (n++, requestAnimationFrame(f)) : done(n * 2));
        requestAnimationFrame(f);
      }),
    };
  });
  page.off('request', onReq);
  page.off('requestfinished', onDone);
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.end');
  await done;
  await cdp.detach();
  return { loadWall, requests, bytes, urls, ...web, ...summarise(events, url) };
}

// ---- trace summary ---------------------------------------------------------------------

function summarise(ev, url) {
  const threads = new Map();
  const procs = new Map();
  for (const e of ev) {
    if (e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name);
    if (e.name === 'process_name') procs.set(e.pid, e.args.name);
  }
  // The page's renderer: the one whose main thread committed the Netflix navigation.
  const nav = ev.filter((e) => e.name === 'navigationStart' && e.args?.data?.documentLoaderURL?.startsWith(url.split('?')[0].replace(/\/$/, '')) && e.args?.data?.isLoadingMainFrame);
  const navStart = nav.at(-1);
  const mainKey = navStart ? `${navStart.pid}:${navStart.tid}` : null;
  const t0 = navStart?.ts ?? Math.min(...ev.filter((e) => e.ts > 0).map((e) => e.ts));
  const busyByProc = {};
  let mainBusy = 0;
  let longCount = 0;
  let longMs = 0;
  let tbt = 0;
  const top = {};
  for (const e of ev) {
    if (e.ph !== 'X' || e.ts < t0) continue;
    const key = `${e.pid}:${e.tid}`;
    if (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') {
      if (e.name !== 'RunTask') continue;
      const pname = procs.get(e.pid) || 'unknown';
      busyByProc[pname] = (busyByProc[pname] || 0) + e.dur / 1000;
      if (key === mainKey) {
        mainBusy += e.dur / 1000;
        if (e.dur > 50_000) {
          longCount++;
          longMs += e.dur / 1000;
          tbt += (e.dur - 50_000) / 1000;
        }
      }
    } else if (key === mainKey && ['EvaluateScript', 'v8.compile', 'v8.compileModule', 'FunctionCall', 'EventDispatch', 'TimerFire', 'FireAnimationFrame',
      'ParseHTML', 'UpdateLayoutTree', 'Layout', 'Paint', 'PrePaint', 'Layerize', 'MajorGC', 'MinorGC', 'V8.GC_SCAVENGER', 'RunMicrotasks', 'XHRReadyStateChange', 'ParseAuthorStyleSheet'].includes(e.name)) {
      const k = e.name;
      top[k] = (top[k] || 0) + e.dur / 1000;
    }
  }
  // Compile work and whether V8's code cache was used for the big bundles.
  const compiles = ev.filter((e) => e.name === 'v8.compile' && e.ph === 'X' && `${e.pid}:${e.tid}` === mainKey);
  const compileMs = compiles.reduce((s, e) => s + e.dur / 1000, 0);
  const cacheHits = compiles.filter((e) => e.args?.data?.consumedCacheSize > 0 && !e.args?.data?.cacheRejected).length;
  const mark = (name) => {
    const e = ev.find((x) => x.name === name && `${x.pid}:${x.tid}` === mainKey);
    return e ? (e.ts - t0) / 1000 : null;
  };
  return { found: !!mainKey, mainBusy, longCount, longMs, tbt, compileMs, compiles: compiles.length, cacheHits, busyByProc, top, markLoad: mark('MarkLoad'), owners: PROFILE ? owners(ev, mainKey, t0) : null };
}

// --profile: JavaScript time on the page's main thread by whose code it was
// (sampled; a function's time goes to the script it was defined in).
function owners(ev, mainKey, t0) {
  const profiles = new Map();
  for (const e of ev) {
    if (e.name !== 'Profile' && e.name !== 'ProfileChunk') continue;
    if (String(e.pid) !== mainKey?.split(':')[0]) continue; // chunks are logged from the profiler's thread
    const p = profiles.get(e.id) || profiles.set(e.id, { nodes: new Map(), samples: [], deltas: [], start: 0 }).get(e.id);
    if (e.name === 'Profile') p.start = e.args.data.startTime;
    for (const n of e.args.data.cpuProfile?.nodes || []) p.nodes.set(n.id, n);
    p.samples.push(...(e.args.data.cpuProfile?.samples || []));
    p.deltas.push(...(e.args.data.timeDeltas || []));
  }
  const ours = new Set(Object.values(EXTS).map(unpackedId));
  const out = {};
  for (const p of profiles.values()) {
    const parent = new Map();
    for (const n of p.nodes.values()) for (const c of n.children || []) parent.set(c, n.id);
    let t = p.start;
    p.samples.forEach((id, i) => {
      const dt = p.deltas[i] || 0;
      t += dt;
      const n = p.nodes.get(id);
      const fn = n?.callFrame.functionName;
      if (t < t0 || !n || ['(idle)', '(program)', '(root)'].includes(fn)) return;
      let url = n.callFrame.url || '';
      for (let k = id; !url && parent.has(k);) url = p.nodes.get((k = parent.get(k)))?.callFrame.url || '';
      let who = 'other';
      if (fn === '(garbage collector)') who = 'gc';
      else if (url.startsWith('chrome-extension://')) who = ours.has(url.split('/')[2]) ? 'cleancut' : 'other extensions';
      else if (/nflxext\.com|netflix\.com|nflxso\.net/.test(url)) who = 'netflix';
      else if (url) who = 'third party';
      out[who] = (out[who] || 0) + dt / 1000;
    });
  }
  return out;
}

// ---- logged-in player traffic, emulated on the real page --------------------------------
//
// What only a signed-in viewer's pages do, and so cannot be loaded here: the
// player (cadmium) prefetches manifests for titles on the browse page
// (billboard, previews, Continue Watching; reqName=prefetch/licensedManifest)
// and the UI fetches episode metadata. This replays that traffic inside the
// real title page (real Netflix scripts, real third-party listeners), with
// synthetic but realistically sized responses, then navigates the single-page
// app to /watch/<one of those titles> the way Netflix does. The page's trailer
// <video> stands in for the player.

const LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar', 'he', 'tr', 'pl', 'nl', 'sv', 'da', 'fi', 'nb', 'cs', 'hu', 'ro', 'el', 'th', 'id', 'vi', 'ms', 'hi', 'uk', 'ru', 'hr'];
const OCA = 'https://ipv4-c001-emu.1.oca.nflxvideo.net';
const fakeManifest = (id) => JSON.stringify({ result: {
  movieId: id,
  video_tracks: [{ streams: Array.from({ length: 40 }, (_, i) => ({ bitrate: 100 * i, content_profile: 'playready-h264hpl40-dash', urls: Array.from({ length: 6 }, (_, c) => ({ cdn_id: c, url: `${OCA}/range/?o=1&v=${i}&c=${c}&t=${'x'.repeat(60)}` })), moreInfo: 'y'.repeat(300) })) }],
  audio_tracks: LANGS.map((l) => ({ language: l, streams: Array.from({ length: 4 }, (_, i) => ({ urls: [{ url: `${OCA}/?o=1&a=${i}&t=${'a'.repeat(60)}` }] })) })),
  timedtexttracks: LANGS.flatMap((l) => [false, true].map((cc) => ({ language: l, trackType: cc ? 'CLOSEDCAPTIONS' : 'SUBTITLES', ttDownloadables: Object.fromEntries(['dfxp-ls-sdh', 'imsc1.1', 'webvtt-lssdh-ios8'].map((f) => [f, { urls: [{ cdn_id: 1, url: `${OCA}/?o=1&v=${id}&lang=${l}&cc=${cc}&f=${f}` }] }])) }))),
} }); // ≈ 330 KB
const fakeDfxp = `<?xml version="1.0" encoding="utf-8"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000" xml:lang="en"><body><div>${
  Array.from({ length: 900 }, (_, i) => `<p begin="${i * 50000000}t" end="${i * 50000000 + 30000000}t">${i % 60 === 7 ? 'What the fuck is that?' : i % 90 === 11 ? '[woman moaning]' : `Line number ${i} of the dialogue, long enough to be realistic.`}</p>`).join('')
}</div></body></tt>`; // ≈ 75 KB; real episodes are 100–500 KB
const PREFETCHED = 12; // manifests a browse page prefetches in the background (a modest guess)
const firstId = 81000001;

async function trafficRun(ctx, page, url) {
  const subtitleDownloads = [];
  await ctx.route(/\/playapi\/cadmium\/licensedmanifest/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fakeManifest(Number(new URL(r.request().url()).searchParams.get('movieid'))) }));
  await ctx.route(/\/memberapi\/[^/]+\/metadata/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ video: { type: 'show', id: 1, title: 'Emulated Show', seasons: [{ seq: 1, episodes: Array.from({ length: PREFETCHED }, (_, i) => ({ id: firstId + i, seq: i + 1, title: `Episode ${i + 1}`, synopsis: 's'.repeat(400), runtime: 3000 })) }] } }) }));
  await ctx.route((u) => u.href.startsWith(`${OCA}/?o=1&v=`), (r) => {
    subtitleDownloads.push(r.request().url());
    return r.fulfill({ status: 200, contentType: 'text/xml', headers: { 'access-control-allow-origin': '*' }, body: fakeDfxp });
  });
  await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForTimeout(3000);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await page.evaluate(() => {
    window.__cc = { messages: 0 };
    window.addEventListener('message', (e) => { if (e.data?.__cleancut) window.__cc.messages++; });
  });
  await cdp.send('HeapProfiler.collectGarbage');
  const m0 = await metrics();
  // Browse: background manifest prefetches, metadata, and setImmediate-style
  // window messages (RxJS's asap scheduler in Netflix's bundles posts these).
  await page.evaluate(async ({ n, first }) => {
    for (let i = 0; i < n; i++) {
      const r = await fetch(`/playapi/cadmium/licensedmanifest/1?reqName=prefetch/licensedManifest&movieid=${first + i}`, { method: 'POST', body: '{}' });
      await r.json();
      if (i % 4 === 0) await (await fetch(`/nq/website/memberapi/release/metadata?movieid=${first + i}`)).json();
    }
    await new Promise((done) => {
      const key = `setImmediate$${Math.random()}$`;
      let i = 0;
      const on = (e) => {
        if (e.source !== window || typeof e.data !== 'string' || !e.data.startsWith(key)) return;
        if (++i < 3000) window.postMessage(key + i, '*');
        else { window.removeEventListener('message', on); done(); }
      };
      window.addEventListener('message', on);
      window.postMessage(`${key}0`, '*');
    });
  }, { n: PREFETCHED, first: firstId });
  await page.waitForTimeout(2500); // let the extension finish whatever it started
  await cdp.send('HeapProfiler.collectGarbage');
  const m1 = await metrics();
  const browseDownloads = subtitleDownloads.length;
  // Watch: single-page navigation to one of the prefetched titles.
  const watchId = firstId + 3;
  await page.evaluate((id) => history.pushState({}, '', `/watch/${id}`), watchId);
  const scanned = await page.waitForFunction(() => /Scanned ahead/.test(document.querySelector('cleancut-overlay')?.shadowRoot?.textContent || ''), null, { timeout: 12_000 }).then(() => true, () => false);
  const cc = await page.evaluate(() => window.__cc);
  await cdp.detach();
  await ctx.unrouteAll({ behavior: 'ignoreErrors' });
  return {
    browseTaskMs: (m1.TaskDuration - m0.TaskDuration) * 1000,
    browseScriptMs: (m1.ScriptDuration - m0.ScriptDuration) * 1000,
    heapGrowthMB: (m1.JSHeapUsedSize - m0.JSHeapUsedSize) / 1e6,
    browseDownloads,
    watchDownloads: subtitleDownloads.length - browseDownloads,
    watchedTrack: subtitleDownloads.slice(browseDownloads).some((u) => u.includes(`v=${watchId}&`)),
    windowMessages: cc.messages,
    scanned,
  };
}

// ---- runs ----------------------------------------------------------------------------------

const results = []; // { variant, page, loadNo, ...metrics }
const traffic = []; // { variant, run, ...trafficRun() }
const t00 = Date.now();
for (let run = 0; run < RUNS; run++) {
  for (const path of PAGES) {
    // Rotate the order each run so no variant always goes first.
    const order = VARIANTS.map((_, i) => VARIANTS[(i + run) % VARIANTS.length]);
    for (const variant of order) {
      const url = new URL(path, 'https://www.netflix.com').href;
      let b;
      try {
        b = await launch(variant);
        for (let load = 1; load <= LOADS; load++) {
          const cpu0 = processCpu(b.dir);
          const r = await traceLoad(b.ctx, b.page, url);
          const cpu1 = processCpu(b.dir);
          const cpu = Object.fromEntries(Object.keys(cpu1).map((k) => [k, (cpu1[k] - (cpu0[k] || 0)) * 1000]));
          results.push({ ...r, variant, page: path, loadNo: load, run, cpu });
          if (DUMP) writeFileSync(`${DUMP}-${variant}-${run}-${load}.txt`, r.urls.join('\n'));
          if (VERBOSE) console.log(variant.padEnd(8), path.padEnd(16), `load ${load}`, `main ${r.mainBusy.toFixed(0)} ms`, `tbt ${r.tbt.toFixed(0)}`, `lcp ${r.lcp?.toFixed(0)}`, `load ${r.load?.toFixed(0)}`, `req ${r.requests}`, `${r.visible} ${r.fps}fps`, `cpu ${JSON.stringify(Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, Math.round(v)])))}`, r.hooked ? 'hooked' : '', r.overlay ? 'overlay' : '');
        }
        if (TRAFFIC && path.startsWith('/title/')) {
          const t = await trafficRun(b.ctx, b.page, url);
          traffic.push({ variant, run, ...t });
          if (VERBOSE) console.log(variant.padEnd(8), 'traffic', JSON.stringify(t));
        }
      } catch (e) {
        console.log(`  ${variant} ${path} run ${run}: ${e.message.split('\n')[0]}`);
      } finally {
        await b?.ctx.close().catch(() => {});
        if (b) rmSync(b.dir, { recursive: true, force: true });
      }
    }
  }
  console.log(`run ${run + 1}/${RUNS} done (${((Date.now() - t00) / 60000).toFixed(1)} min)`);
}

// ---- report ----------------------------------------------------------------------------------

if (OUT) writeFileSync(OUT, JSON.stringify({ loads: results.map(({ urls, ...r }) => r), traffic }, null, 1));

const median = (a) => {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return NaN;
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const spread = (a) => {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return s.length ? `${Math.round(s[0])}–${Math.round(s.at(-1))}` : '-';
};
const COLS = [
  ['main ms', (r) => r.mainBusy],
  ['TBT', (r) => r.tbt],
  ['long', (r) => r.longCount],
  ['compile', (r) => r.compileMs],
  ['script', (r) => (r.top.EvaluateScript || 0) + (r.top.FunctionCall || 0) + (r.top.EventDispatch || 0) + (r.top.TimerFire || 0)],
  ['style+lay', (r) => (r.top.UpdateLayoutTree || 0) + (r.top.Layout || 0)],
  ['FCP', (r) => r.fcp],
  ['LCP', (r) => r.lcp],
  ['DCL', (r) => r.dcl],
  ['load', (r) => r.load],
  ['req', (r) => r.requests],
  ['rend cpu', (r) => r.cpu.renderer],
  ['ext cpu', (r) => r.cpu.extension],
  ['brw cpu', (r) => r.cpu.browser],
  ['gpu cpu', (r) => r.cpu['gpu-process']],
  ['all cpu', (r) => Object.values(r.cpu).reduce((s, v) => s + v, 0)],
  ...(PROFILE ? [['js:nflx', (r) => r.owners?.netflix || 0], ['js:cc', (r) => r.owners?.cleancut || 0], ['js:oext', (r) => r.owners?.['other extensions'] || 0], ['js:gc', (r) => r.owners?.gc || 0]] : []),
];
console.log(`\nReal Netflix pages, ${RUNS} runs × ${LOADS} loads per variant, ${SETTLE_MS} ms after load traced. Medians (ms; req = count).`);
console.log(`Builds: ${Object.entries(EXTS).map(([k, v]) => `${k || 'default'}=${v}`).join(', ')}${WITH.length ? `\nAlso loaded in every variant: ${WITH.join(', ')}` : ''}\n`);
for (const path of PAGES) {
  for (const phase of ['cold', 'warm']) {
    console.log(`${path} — ${phase === 'cold' ? 'cold load (load 1)' : `warm loads (2–${LOADS})`}`);
    console.log('variant'.padEnd(13), ...COLS.map(([n]) => n.padStart(9)));
    for (const variant of VARIANTS) {
      const rows = results.filter((r) => r.page === path && r.variant === variant && (phase === 'cold' ? r.loadNo === 1 : r.loadNo > 1));
      if (!rows.length) continue;
      console.log(variant.padEnd(13), ...COLS.map(([, f]) => String(Math.round(median(rows.map(f)))).padStart(9)), `  n=${rows.length}`);
      if (VERBOSE) console.log(''.padEnd(13), ...COLS.map(([, f]) => spread(rows.map(f)).padStart(9)));
    }
    console.log('');
  }
}

if (traffic.length) {
  console.log(`Emulated signed-in traffic on the title page: ${PREFETCHED} manifest prefetches + metadata + 3000 window messages while browsing, then /watch/<one of them>.`);
  console.log('Medians; downloads and messages are counts.\n');
  const TCOLS = [
    ['task ms', (r) => r.browseTaskMs],
    ['script ms', (r) => r.browseScriptMs],
    ['heap +MB', (r) => r.heapGrowthMB],
    ['subs dl', (r) => r.browseDownloads],
    ['win msgs', (r) => r.windowMessages],
    ['watch dl', (r) => r.watchDownloads],
  ];
  console.log('variant'.padEnd(13), ...TCOLS.map(([n]) => n.padStart(10)), '  scanned on /watch');
  for (const variant of VARIANTS) {
    const rows = traffic.filter((r) => r.variant === variant);
    if (!rows.length) continue;
    console.log(variant.padEnd(13), ...TCOLS.map(([, f]) => median(rows.map(f)).toFixed(1).padStart(10)), `  ${rows.filter((r) => r.scanned).length}/${rows.length}`, `  n=${rows.length}`);
    if (VERBOSE) console.log(''.padEnd(13), ...TCOLS.map(([, f]) => spread(rows.map(f)).padStart(10)));
  }
  console.log('\nWhile browsing: main-thread task/script time, JS heap growth (after GC), subtitle tracks the extension downloaded,');
  console.log('CleanCut window messages seen by page listeners. watch dl: tracks downloaded after navigating to /watch.');
}
