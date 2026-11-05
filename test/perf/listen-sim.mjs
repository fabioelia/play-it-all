// Listening ahead: does it cost the page anything? Plays the MSE demo
// (demo/listen.html: 720p VP9 + Opus, buffering 30 s ahead in 5 s segments,
// like YouTube) while the mouse moves over the player, and compares
//
//   no extension | CleanCut, listening off (the default) | CleanCut, listening on
//
// on the page's main thread (script ms/s, task ms/s, long tasks, style and
// layout per second, janky animation frames, the time the player's own
// appendBuffer calls take) and on the video (dropped frames), plus CPU time
// in every browser process (the speech model runs in the extension's
// process, not the page's) and, listening on, the model's real-time factor.
//
//   npm run bench:listen                 (SECONDS=30 RUNS=1)
// Downloads once (cached outside the repo): the speech model, the TTS model.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { explainLaunchError, loadChromium, root } from '../support/browser.mjs';
import { extensionDir, waitFor } from '../support/extension.mjs';
import { startModelMirror } from '../support/model-mirror.mjs';
import { ensureBenchVideo, makeListenDemo } from '../../scripts/make-listen-demo.mjs';

const chromium = loadChromium();
const SECONDS = Number(process.env.SECONDS || 30);
const RUNS = Number(process.env.RUNS || 1);
const PORT = 8792;
const URL_ = `http://localhost:${PORT}/demo/listen?video=720`;
const tmp = mkdtempSync(join(tmpdir(), 'cleancut-listen-bench-'));

const demo = await makeListenDemo();
ensureBenchVideo(demo.dir);
const mirror = await startModelMirror({ port: 8793 });
const server = spawn(process.execPath, [join(root, 'scripts/dev-server.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LISTEN_MEDIA_DIR: demo.dir },
  stdio: ['ignore', 'ignore', 'inherit'],
});
await waitFor(() => fetch(`http://localhost:${PORT}/listen-media/index.json`).then((r) => r.ok, () => false), { what: 'dev server' });

const STATS = `(() => {
  const s = window.__stats = { frames: 0, jank25: 0, jank50: 0, longTasks: 0, longTaskMs: 0 };
  let last = performance.now();
  const frame = (now) => { const d = now - last; last = now; s.frames++; if (d > 25) s.jank25++; if (d > 50) s.jank50++; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { s.longTasks++; s.longTaskMs += e.duration; } }).observe({ type: 'longtask' });
})();`;

async function run(label, { ext = false, listen = false } = {}) {
  const args = ['--autoplay-policy=no-user-gesture-required'];
  if (ext) args.push(`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`);
  else args.push('--disable-extensions');
  const ctx = await chromium.launchPersistentContext(join(tmp, label.replace(/\W/g, '_')), { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, args }).catch(explainLaunchError);
  let worker = null;
  if (ext) {
    worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
    await waitFor(() => worker.evaluate(() => chrome.storage.sync.get('settings').then((s) => !!s.settings?.profile)), { what: 'default settings' });
    if (listen) {
      await worker.evaluate((host) => chrome.storage.local.set({ listenModelHost: host }), mirror.url);
      const opt = await ctx.newPage();
      await opt.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
      await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'listenDownload' }));
      await waitFor(() => worker.evaluate(() => chrome.storage.local.get('listening').then((r) => r.listening?.on === true)), { timeout: 60_000, what: 'model downloaded' });
      await opt.close();
    }
  }
  const p = await ctx.newPage();
  await p.waitForTimeout(500);
  for (const other of ctx.pages()) if (other !== p) await other.close();
  await p.bringToFront();
  await p.addInitScript(STATS);
  await p.goto(URL_);
  if (listen) {
    // The site's flag is set on the first visit; the hook reads it on the next load.
    await p.waitForFunction(() => window.cleancutDemoReady, null, { timeout: 20_000 });
    await p.waitForTimeout(1500);
    await p.reload();
  }
  await p.waitForFunction(() => window.cleancutDemoReady, null, { timeout: 20_000 });
  await p.evaluate(() => document.getElementById('v').play());
  await p.waitForTimeout(2000); // warm-up: page start-up is not what is measured

  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Performance.enable');
  const browserCdp = await ctx.browser()?.newBrowserCDPSession?.().catch(() => null);
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  // CPU seconds per process (browser, renderers, GPU, utility), from the browser target.
  const cpu = async () => {
    try {
      const s = browserCdp || (await ctx.newCDPSession(p));
      const { processInfo } = await s.send('SystemInfo.getProcessInfo');
      return processInfo.reduce((n, x) => n + x.cpuTime, 0);
    } catch {
      return NaN;
    }
  };
  const snap = () => p.evaluate(() => {
    const q = document.getElementById('v').getVideoPlaybackQuality();
    return { ...window.__stats, append: { ...window.cleancutDemoAppend }, dropped: q.droppedVideoFrames, total: q.totalVideoFrames, t: document.getElementById('v').currentTime };
  });
  const s0 = await snap();
  const m0 = await metric();
  const c0 = await cpu();
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < SECONDS * 1000) {
    await p.mouse.move(200 + ((i * 97) % 880), 200 + ((i * 53) % 400), { steps: 4 });
    await p.waitForTimeout(50);
    i++;
  }
  const wall = (Date.now() - t0) / 1000;
  const m1 = await metric();
  const c1 = await cpu();
  const s1 = await snap();
  let listening = null;
  if (worker) {
    listening = await worker.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).find((t) => /\/demo\/listen/.test(t.url || ''));
      const st = tab && (await chrome.tabs.sendMessage(tab.id, { type: 'getState' }).catch(() => null));
      return st ? { ...st.listening, found: st.counts.listening } : null;
    });
  }
  await ctx.close();
  const windows = (listening?.windows || []).filter((w) => !w.cancelled && w.ms);
  const audioS = windows.reduce((n, w) => n + (w.end - w.from), 0);
  return {
    label,
    script: ((m1.ScriptDuration - m0.ScriptDuration) * 1000) / wall,
    task: ((m1.TaskDuration - m0.TaskDuration) * 1000) / wall,
    style: (m1.RecalcStyleCount - m0.RecalcStyleCount) / wall,
    layout: (m1.LayoutCount - m0.LayoutCount) / wall,
    longTasks: s1.longTasks - s0.longTasks,
    longTaskMs: s1.longTaskMs - s0.longTaskMs,
    jank25: s1.jank25 - s0.jank25,
    jank50: s1.jank50 - s0.jank50,
    frames: s1.frames - s0.frames,
    dropped: s1.dropped - s0.dropped,
    decoded: s1.total - s0.total,
    appendMs: (s1.append.ms - s0.append.ms) / Math.max(1, s1.append.n - s0.append.n),
    appends: s1.append.n - s0.append.n,
    cpu: (c1 - c0) / wall,
    played: s1.t - s0.t,
    listening,
    rtf: windows.length ? windows.reduce((n, w) => n + w.ms, 0) / 1000 / audioS : null,
    windows: windows.length,
  };
}

const results = [];
try {
  for (let r = 0; r < RUNS; r++) {
    results.push(await run(`no extension ${r}`));
    results.push(await run(`listening off ${r}`, { ext: true }));
    results.push(await run(`listening on ${r}`, { ext: true, listen: true }));
  }
} finally {
  server.kill();
  mirror.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nMSE demo, 720p VP9 + Opus, ${SECONDS}s of playback with mouse movement, headless Chromium, ${navigatorCores()} cores\n`);
const cols = [['run', 18], ['script ms/s', 12], ['task ms/s', 10], ['long tasks', 11], ['(ms)', 6], ['janky>25', 9], ['>50', 5], ['frames', 7], ['dropped', 9], ['append ms', 10], ['style/s', 8], ['layout/s', 9], ['CPU cores', 10]];
console.log(cols.map(([n, w], i) => (i ? n.padStart(w) : n.padEnd(w))).join(''));
for (const x of results) {
  const v = [x.label, x.script.toFixed(1), x.task.toFixed(1), x.longTasks, x.longTaskMs.toFixed(0), x.jank25, x.jank50, x.frames, `${x.dropped}/${x.decoded}`, x.appendMs.toFixed(3), x.style.toFixed(1), x.layout.toFixed(1), x.cpu.toFixed(2)];
  console.log(v.map((s, i) => (i ? String(s).padStart(cols[i][1]) : String(s).padEnd(cols[i][1]))).join(''));
}
for (const x of results.filter((r) => r.listening?.on)) {
  const l = x.listening;
  console.log(`  ${x.label}: ${l.state}, heard to ${l.heardTo?.toFixed(1)} s, ${l.found} found; ${x.windows} windows, model real-time factor ${x.rtf?.toFixed(3)} (1 thread); page relay ${l.relayMs.toFixed(1)} ms for ${l.appends} appends (${(l.bytes / 1024).toFixed(0)} KB)`);
}

function navigatorCores() {
  return (globalThis.navigator?.hardwareConcurrency) || 'n';
}
