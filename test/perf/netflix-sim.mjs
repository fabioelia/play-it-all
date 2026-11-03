// Performance benchmark: how much main-thread time does the extension add on
// a Netflix-like page?
//
// Serves a fake https://www.netflix.com/watch/<id> locally (DNS mapped to
// 127.0.0.1, self-signed cert) with a playing video and traffic shaped like
// Netflix's: large JSON API responses, binary media segments over XHR and
// fetch, logging beacons, plus the metadata / manifest / subtitle responses
// CleanCut actually needs. Then compares runs without the extension and with
// one or more extension builds.
//
//   node test/perf/netflix-sim.mjs [extDir ...]     (default: extension/dist/chrome)
//   SECONDS=15 node test/perf/netflix-sim.mjs
import { createRequire } from 'node:module';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'cleancut-perf-'));
const SECONDS = Number(process.env.SECONDS || 15);
const PORT = 8443;
const VIDEO_ID = '80000001';

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=www.netflix.com',
  '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem')], { stdio: 'ignore' });

// ---- fake Netflix ------------------------------------------------------------
const video = readFileSync(join(root, 'server/public/demo.webm'));
const bigJson = JSON.stringify({ jsonGraph: { videos: Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [80000000 + i, {
  title: { value: `Title ${i}` }, synopsis: { value: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(2) },
  boxart: { value: { url: `https://example.invalid/${i}.jpg`, w: 342, h: 192 } }, userRating: { value: { matchScore: 97 } },
}])) } }); // ≈ 400 KB, like a browse/GraphQL response
const segment = Buffer.alloc(1_500_000, 7); // a media segment
const dfxp = `<?xml version="1.0" encoding="utf-8"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000" xml:lang="en"><body><div>${
  Array.from({ length: 600 }, (_, i) => `<p begin="${i * 50000000}t" end="${i * 50000000 + 30000000}t">${i % 50 === 7 ? 'What the fuck is that?' : i % 80 === 11 ? '[woman moaning]' : `Line number ${i} of the dialogue.`}</p>`).join('')
}</div></body></tt>`;
const metadata = JSON.stringify({ video: { type: 'show', title: 'Simulated Show', seasons: [{ seq: 1, episodes: [{ id: Number(VIDEO_ID), seq: 1, title: 'Pilot', runtime: 3000 }] }] } });
const manifest = JSON.stringify({ result: { movieId: Number(VIDEO_ID), timedtexttracks: [{ language: 'en', trackType: 'CLOSEDCAPTIONS', ttDownloadables: { 'dfxp-ls-sdh': { urls: [{ url: `https://www.netflix.com/nflx/sub?o=1&v=${VIDEO_ID}` }] } } }] } });

const page = `<!doctype html><html><head><title>Netflix</title></head><body style="margin:0;background:#000">
<div class="watch-video"><div data-uia="video-title"><h4>Simulated Show</h4><span>S1:E1</span><span>Pilot</span></div>
<video id="v" src="/nflx/video.webm" muted loop autoplay style="width:100vw;height:56vw"></video></div>
<script>
  const stats = window.__stats = { longTasks: 0, longTaskMs: 0, requests: 0 };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { stats.longTasks++; stats.longTaskMs += e.duration; } }).observe({ type: 'longtask', buffered: true });
  // What the player itself needs at start.
  fetch('/nflx/metadata?movieid=${VIDEO_ID}').then((r) => r.json());
  fetch('/playapi/cadmium/licensedmanifest/1', { method: 'POST', body: '{}' }).then((r) => r.json());
  // Ongoing traffic. The page parses its own JSON, as the real one does.
  setInterval(() => { stats.requests++; fetch('/nq/graphql?q=' + Math.random()).then((r) => r.json()); }, 250);
  setInterval(() => {
    stats.requests++;
    const x = new XMLHttpRequest(); x.open('GET', '/nflx/range/0-1499999?o=1&v=5&e=' + Math.random()); x.responseType = 'arraybuffer'; x.send();
  }, 250);
  setInterval(() => { stats.requests++; fetch('/nflx/range/seg?o=1&f=' + Math.random()).then((r) => r.arrayBuffer()); }, 500);
  setInterval(() => {
    stats.requests++;
    const x = new XMLHttpRequest(); x.open('POST', '/playapi/cadmium/event/1?playbackcontextid=' + Math.random()); x.send('{"event":"heartbeat"}');
  }, 100);
</script></body></html>`;

const server = createServer({ key: readFileSync(join(tmp, 'key.pem')), cert: readFileSync(join(tmp, 'cert.pem')) }, (req, res) => {
  const u = new URL(req.url, 'https://www.netflix.com');
  const send = (type, body, extra = {}) => { res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra }); res.end(body); };
  if (u.pathname.startsWith('/watch/')) return send('text/html', page);
  if (u.pathname === '/nflx/video.webm') {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!m) return send('video/webm', video, { 'Accept-Ranges': 'bytes' });
    const s = Number(m[1]); const e = m[2] ? Number(m[2]) : video.length - 1;
    res.writeHead(206, { 'Content-Type': 'video/webm', 'Content-Range': `bytes ${s}-${e}/${video.length}`, 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes' });
    return res.end(video.subarray(s, e + 1));
  }
  if (u.pathname === '/nflx/metadata') return send('application/json', metadata);
  if (u.pathname.includes('licensedmanifest')) return send('application/json', manifest);
  if (u.pathname === '/nflx/sub') return send('text/xml', dfxp);
  if (u.pathname === '/nq/graphql') return send('application/json', bigJson);
  // Netflix's CDN serves segments with a generic or missing media type.
  if (u.pathname.startsWith('/nflx/range')) return send('application/x-binary', segment);
  if (u.pathname.includes('/event/')) return send('application/json', '{"ok":true}');
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1');

// ---- runs ------------------------------------------------------------------------
async function run(label, ext) {
  const args = ['--no-proxy-server', '--host-resolver-rules=MAP www.netflix.com 127.0.0.1:' + PORT, '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'];
  if (ext) args.push(`--disable-extensions-except=${ext}`, `--load-extension=${ext}`);
  else args.push('--disable-extensions');
  const ctx = await chromium.launchPersistentContext(join(tmp, `p-${label}`), { channel: 'chromium', headless: true, viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true, args });
  const p = await ctx.newPage();
  await p.goto(`https://www.netflix.com/watch/${VIDEO_ID}`);
  await p.waitForFunction(() => document.getElementById('v').currentTime > 0.5, null, { timeout: 15000 });
  await p.waitForTimeout(2000); // warm-up: startup work is not what we measure
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Performance.enable');
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const quality = () => { const q = document.getElementById('v').getVideoPlaybackQuality(); return { dropped: q.droppedVideoFrames, total: q.totalVideoFrames }; };
  const q0 = await p.evaluate((f) => ({ ...window.__stats, q: eval(f)() }), `(${quality})`);
  if (process.env.PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
  const m0 = await metric();
  await p.waitForTimeout(SECONDS * 1000);
  const m1 = await metric();
  if (process.env.PROFILE) {
    const { profile } = await cdp.send('Profiler.stop');
    const dt = (profile.endTime - profile.startTime) / profile.samples.length / 1000;
    const self = new Map();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    for (const id of profile.samples) {
      const f = byId.get(id).callFrame;
      if (['(idle)', '(program)', '(root)'].includes(f.functionName)) continue;
      const k = `${f.functionName || '(anon)'}  ${f.url.replace(/^.*\//, '')}:${f.lineNumber + 1}`;
      self.set(k, (self.get(k) || 0) + dt);
    }
    console.log(`\n[${label}] top self time (ms over ${SECONDS}s)`);
    for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(v.toFixed(1).padStart(8), k);
  }
  const q1 = await p.evaluate((f) => ({ ...window.__stats, q: eval(f)(), badge: document.querySelector('cleancut-overlay')?.shadowRoot?.querySelector('.badge')?.textContent || null }), `(${quality})`);
  await ctx.close();
  return {
    label,
    scriptMsPerSec: ((m1.ScriptDuration - m0.ScriptDuration) * 1000) / SECONDS,
    taskMsPerSec: ((m1.TaskDuration - m0.TaskDuration) * 1000) / SECONDS,
    heapMB: m1.JSHeapUsedSize / 1e6,
    longTasks: q1.longTasks - q0.longTasks,
    longTaskMs: q1.longTaskMs - q0.longTaskMs,
    droppedFrames: q1.q.dropped - q0.q.dropped,
    totalFrames: q1.q.total - q0.q.total,
    stylePerSec: (m1.RecalcStyleCount - m0.RecalcStyleCount) / SECONDS,
    layoutPerSec: (m1.LayoutCount - m0.LayoutCount) / SECONDS,
    badge: q1.badge,
  };
}

const exts = process.argv.slice(2).length ? process.argv.slice(2).map((e) => resolve(e)) : [join(root, 'extension/dist/chrome')];
const results = [await run('no extension', null)];
for (const e of exts) results.push(await run(e.replace(/.*\/(?=[^/]+\/[^/]+$)/, ''), e));
server.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\nNetflix-like page, ${SECONDS}s measured after warm-up (main thread of the tab)\n`);
console.log('run'.padEnd(24), 'script ms/s', ' task ms/s', ' style/s', ' layout/s', ' long tasks', ' (ms)', '  dropped/frames', ' heap MB', '  CleanCut badge');
for (const r of results) {
  console.log(r.label.padEnd(24), r.scriptMsPerSec.toFixed(1).padStart(11), r.taskMsPerSec.toFixed(1).padStart(10), r.stylePerSec.toFixed(1).padStart(8), r.layoutPerSec.toFixed(1).padStart(9), String(r.longTasks).padStart(11),
    r.longTaskMs.toFixed(0).padStart(6), `${r.droppedFrames}/${r.totalFrames}`.padStart(16), r.heapMB.toFixed(1).padStart(8), ' ', r.badge ?? '-');
}
