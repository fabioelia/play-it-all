// Playback smoothness benchmark: does the extension make video stutter or
// controls feel slow on a Netflix-like watch page?
//
// Serves a fake https://www.netflix.com/watch/<id> with a 1080p video, a mock
// control bar that behaves like Netflix's (appears on mouse move, scrubber
// follows playback), a fake Netflix player API (so skips go through the same
// seek bridge as on Netflix), and a subtitle track that gives CleanCut a mute
// and a skip on every loop. While it plays, the mouse moves over the player and
// the play/pause button is clicked, like a viewer using the controls.
//
// Reports per run:
//   janky frames    animation frames that took > 25 ms (visible stutter)
//   input delay     Event Timing durations for pointer/click events (slow controls)
//   dropped         decoder-reported dropped video frames
//   script / style / layout  main-thread work per second
//
//   node test/perf/playback-sim.mjs [extDir ...]        (default: extension/dist/chrome)
//   SECONDS=20 BROKEN_API=1 node test/perf/playback-sim.mjs   (simulate Netflix's seek API missing)
import { createRequire } from 'node:module';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'cleancut-play-'));
const SECONDS = Number(process.env.SECONDS || 20);
const BROKEN_API = !!process.env.BROKEN_API;
const PORT = 8444;
const VIDEO_ID = '80000002';

// ---- assets ------------------------------------------------------------------------
const cacheDir = join(root, 'node_modules/.cache/cleancut-bench');
const videoFile = join(cacheDir, 'playback-1080p.webm');
if (!existsSync(videoFile)) {
  mkdirSync(cacheDir, { recursive: true });
  console.log('generating 1080p test video (once)…');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=30',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=30',
    '-c:v', 'libvpx', '-b:v', '4M', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', videoFile]);
}
const video = readFileSync(videoFile);
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=www.netflix.com',
  '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem')], { stdio: 'ignore' });

// Cues every 2 s; strong language at 6 s and 18 s (mute), SDH sex hints at
// 11–14 s (one scene, ~83% confidence → skipped at PG-13).
const cue = (i, text) => `<p begin="${i * 20000000}t" end="${i * 20000000 + 15000000}t">${text}</p>`;
const lines = Array.from({ length: 15 }, (_, i) => (
  i === 3 || i === 9 ? 'What the fuck is that?' : i === 5 || i === 6 ? '[woman moaning]' : i === 7 ? '[bed creaking]' : `Ordinary line ${i}.`
));
const dfxp = `<?xml version="1.0" encoding="utf-8"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000" xml:lang="en"><body><div>${lines.map((t, i) => cue(i, t)).join('')}</div></body></tt>`;
const metadata = JSON.stringify({ video: { type: 'show', title: 'Simulated Show', seasons: [{ seq: 1, episodes: [{ id: Number(VIDEO_ID), seq: 1, title: 'Pilot', runtime: 30 }] }] } });
const manifest = JSON.stringify({ result: { movieId: Number(VIDEO_ID), timedtexttracks: [{ language: 'en', trackType: 'CLOSEDCAPTIONS', ttDownloadables: { 'dfxp-ls-sdh': { urls: [{ url: `https://www.netflix.com/nflx/sub?o=1` }] } } }] } });

const page = `<!doctype html><html><head><title>Netflix</title><style>
  body { margin: 0; background: #000; font: 14px system-ui; color: #fff; overflow: hidden; }
  .watch-video { position: relative; width: 100vw; height: 100vh; }
  video { width: 100%; height: 100%; object-fit: contain; }
  .controls { position: absolute; left: 0; right: 0; bottom: 0; padding: 16px 24px; background: linear-gradient(transparent, rgba(0,0,0,.8));
    opacity: 0; transition: opacity .2s; display: flex; gap: 16px; align-items: center; }
  .controls.show { opacity: 1; }
  .scrub { flex: 1; height: 6px; background: #555; border-radius: 3px; position: relative; }
  .scrub .fill { position: absolute; inset: 0 auto 0 0; background: #e50914; border-radius: 3px; }
  button { font: inherit; color: #fff; background: #333; border: 0; padding: 8px 14px; border-radius: 4px; }
  button:hover { background: #555; }
  [data-uia="video-title"] { position: absolute; top: 16px; left: 24px; }
</style></head><body>
<div class="watch-video">
  <video id="v" src="/nflx/video.webm" loop autoplay></video>
  <div data-uia="video-title"><h4>Simulated Show</h4><span>S1:E1</span><span>Pilot</span></div>
  <div class="controls" id="controls"><button id="play">Pause</button><div class="scrub"><div class="fill" id="fill"></div></div><span id="time">0:00</span></div>
</div>
<script>
  const v = document.getElementById('v');
  const s = window.__stats = { frames: 0, jank25: 0, jank50: 0, worstFrame: 0, events: [], longTasks: 0, longTaskMs: 0 };
  // Frame pacing.
  let last = performance.now();
  (function frame(now) { const d = now - last; last = now; s.frames++; if (d > 25) s.jank25++; if (d > 50) s.jank50++; s.worstFrame = Math.max(s.worstFrame, d); requestAnimationFrame(frame); })(last);
  // Input responsiveness (Event Timing API).
  new PerformanceObserver((l) => { for (const e of l.getEntries()) s.events.push({ name: e.name, duration: e.duration }); })
    .observe({ type: 'event', durationThreshold: 16, buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { s.longTasks++; s.longTaskMs += e.duration; } }).observe({ type: 'longtask' });
  // Controls that behave like Netflix's: shown on mouse move, scrubber follows playback.
  const controls = document.getElementById('controls');
  let hide;
  document.addEventListener('mousemove', () => { controls.classList.add('show'); clearTimeout(hide); hide = setTimeout(() => controls.classList.remove('show'), 3000); });
  v.addEventListener('timeupdate', () => {
    document.getElementById('fill').style.width = (v.currentTime / v.duration * 100) + '%';
    document.getElementById('time').textContent = Math.floor(v.currentTime) + 's';
  });
  document.getElementById('play').addEventListener('click', () => { if (v.paused) { v.play(); } else { v.pause(); } document.getElementById('play').textContent = v.paused ? 'Play' : 'Pause'; });
  // Fake Netflix player API, as used by CleanCut's seek bridge.
  ${BROKEN_API ? '' : `window.netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
    getAllPlayerSessionIds: () => ['watch-1'],
    getVideoPlayerBySessionId: () => ({ seek: (ms) => { s.seeks = (s.seeks || 0) + 1; v.currentTime = ms / 1000; } }),
  } }) } } } };`}
  fetch('/nflx/metadata?movieid=${VIDEO_ID}').then((r) => r.json());
  fetch('/playapi/cadmium/licensedmanifest/1', { method: 'POST', body: '{}' }).then((r) => r.json());
  v.addEventListener('volumechange', () => { s.volumeChanges = (s.volumeChanges || 0) + 1; });
</script></body></html>`;

const server = createServer({ key: readFileSync(join(tmp, 'key.pem')), cert: readFileSync(join(tmp, 'cert.pem')) }, (req, res) => {
  const u = new URL(req.url, 'https://www.netflix.com');
  const send = (type, body) => { res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }); res.end(body); };
  if (u.pathname.startsWith('/watch/')) return send('text/html', page);
  if (u.pathname === '/nflx/video.webm') {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const s = m ? Number(m[1]) : 0;
    const e = m && m[2] ? Number(m[2]) : video.length - 1;
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1, ...(m ? { 'Content-Range': `bytes ${s}-${e}/${video.length}` } : {}) });
    return res.end(video.subarray(s, e + 1));
  }
  if (u.pathname === '/nflx/metadata') return send('application/json', metadata);
  if (u.pathname.includes('licensedmanifest')) return send('application/json', manifest);
  if (u.pathname === '/nflx/sub') return send('text/xml', dfxp);
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1');

// ---- runs ------------------------------------------------------------------------
const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);

async function run(label, ext) {
  const args = ['--no-proxy-server', `--host-resolver-rules=MAP www.netflix.com 127.0.0.1:${PORT}`, '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'];
  if (ext) args.push(`--disable-extensions-except=${ext}`, `--load-extension=${ext}`);
  else args.push('--disable-extensions');
  const ctx = await chromium.launchPersistentContext(join(tmp, `p-${label.replace(/\W/g, '_')}`), { channel: 'chromium', headless: true, viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true, args });
  const p = await ctx.newPage();
  // The extension opens its options page on first install; a background tab
  // gets throttled rendering and timers, so keep ours the only, foreground tab.
  await p.waitForTimeout(500);
  for (const other of ctx.pages()) if (other !== p) await other.close();
  await p.bringToFront();
  await p.goto(`https://www.netflix.com/watch/${VIDEO_ID}`);
  await p.waitForFunction(() => document.getElementById('v').currentTime > 0.5, null, { timeout: 20000 });
  await p.waitForTimeout(2500);
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Performance.enable');
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const snap = () => p.evaluate(() => {
    const q = document.getElementById('v').getVideoPlaybackQuality();
    const s = window.__stats;
    return { ...s, events: s.events.slice(), dropped: q.droppedVideoFrames, total: q.totalVideoFrames, badge: document.querySelector('cleancut-overlay')?.shadowRoot?.querySelector('.badge')?.textContent || null };
  });
  const s0 = await snap();
  const m0 = await metric();
  if (process.env.PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }

  // A viewer using the controls: keep moving the mouse, pause/play now and then.
  const end = Date.now() + SECONDS * 1000;
  let i = 0;
  while (Date.now() < end) {
    await p.mouse.move(200 + ((i * 97) % 880), 200 + ((i * 53) % 400), { steps: 4 });
    if (i % 40 === 20) { await p.click('#play'); await p.waitForTimeout(400); await p.click('#play'); }
    await p.waitForTimeout(50);
    i++;
  }

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
    for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(v.toFixed(1).padStart(8), k);
  }
  const s1 = await snap();
  await ctx.close();
  const events = s1.events.slice(s0.events.length).map((e) => e.duration);
  return {
    label,
    jank25: s1.jank25 - s0.jank25,
    jank50: s1.jank50 - s0.jank50,
    frames: s1.frames - s0.frames,
    worstFrame: s1.worstFrame,
    slowEvents: events.length,
    p95Event: pct(events, 0.95),
    maxEvent: Math.max(0, ...events),
    dropped: s1.dropped - s0.dropped,
    decoded: s1.total - s0.total,
    seeks: (s1.seeks || 0) - (s0.seeks || 0),
    mutes: (s1.volumeChanges || 0) - (s0.volumeChanges || 0),
    script: ((m1.ScriptDuration - m0.ScriptDuration) * 1000) / SECONDS,
    style: (m1.RecalcStyleCount - m0.RecalcStyleCount) / SECONDS,
    layout: (m1.LayoutCount - m0.LayoutCount) / SECONDS,
    badge: s1.badge,
  };
}

const exts = process.argv.slice(2).length ? process.argv.slice(2).map((e) => resolve(e)) : [join(root, 'extension/dist/chrome')];
const results = [await run('no extension', null)];
for (const [i, e] of exts.entries()) results.push(await run(`${i + 1}: ${e.split('/').slice(-2).join('/')}`, e));
server.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\nPlayback on a Netflix-like page, ${SECONDS}s with mouse movement and clicks${BROKEN_API ? ' (Netflix seek API missing)' : ''}\n`);
const cols = [['run', 26], ['janky>25ms', 11], ['>50ms', 6], ['frames', 7], ['worst ms', 9], ['slow inputs', 12], ['p95 ms', 7], ['max ms', 7], ['dropped', 8], ['seeks', 6], ['mute chg', 9], ['script/s', 9], ['style/s', 8], ['layout/s', 9]];
console.log(cols.map(([n, w], i) => (i ? n.padStart(w) : n.padEnd(w))).join(''));
for (const r of results) {
  const vals = [r.label, r.jank25, r.jank50, r.frames, r.worstFrame.toFixed(0), r.slowEvents, r.p95Event.toFixed(0), r.maxEvent.toFixed(0), `${r.dropped}/${r.decoded}`, r.seeks, r.mutes, r.script.toFixed(1), r.style.toFixed(1), r.layout.toFixed(1)];
  console.log(vals.map((v, i) => (i ? String(v).padStart(cols[i][1]) : String(v).slice(0, 25).padEnd(cols[i][1]))).join(''));
}
for (const r of results.filter((x) => x.badge)) console.log(`  ${r.label}: ${r.badge}`);
