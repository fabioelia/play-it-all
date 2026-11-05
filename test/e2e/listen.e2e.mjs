// End-to-end: listening ahead, in the built extension, on the MSE demo
// (demo/listen.html: no captions, the player keeps 30 s buffered ahead,
// speech by a local TTS model with swearing at known times).
//
// Checks that, with the feature off, nothing at all happens (no wrapper on
// the page, no copies, no offscreen document); that turning it on asks for
// consent and downloads the model once (from a local copy of Hugging Face,
// with the same digests); that a swear is found before the playhead reaches
// it and muted at the right moment, also after a seek; that pausing idles
// the worker; that captions win; that encrypted audio is refused; and that
// switching it off for the site, and deleting the model, undo everything.
//
//   npm run test:e2e:listen      (downloads, once, cached outside the repo:
//                                 the 44 MB speech model and the 92 MB TTS model)
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { ensureDemoVideo, root } from '../support/browser.mjs';
import { launchWithExtension, steps, waitFor } from '../support/extension.mjs';
import { startModelMirror } from '../support/model-mirror.mjs';
import { makeListenDemo } from '../../scripts/make-listen-demo.mjs';

const PORT = 8789;
const BASE = `http://localhost:${PORT}`;
console.log('CleanCut listening e2e');
ensureDemoVideo();
const demo = await makeListenDemo();
const [swear1, , , swear2] = demo.words; // "fuck" ≈ 23.7 s, "fuck" ≈ 66.6 s
const mirror = await startModelMirror();
const server = spawn(process.execPath, [join(root, 'scripts/dev-server.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LISTEN_MEDIA_DIR: demo.dir },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const { step, summary } = steps();
let ext;
try {
  await waitFor(() => fetch(`${BASE}/catalog/index.json`).then((r) => r.ok, () => false), { what: 'dev server' });
  ext = await launchWithExtension();
  await ext.setSettings({ catalogBase: `${BASE}/catalog/` });
  await ext.worker.evaluate((host) => chrome.storage.local.set({ listenModelHost: host }), mirror.url);
  const page = await ext.context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const open = async (query = '') => {
    await page.goto(`${BASE}/demo/listen${query}`);
    await page.waitForFunction(() => window.cleancutDemoReady, null, { timeout: 20_000 });
    await page.waitForSelector('cleancut-overlay', { state: 'attached', timeout: 10_000 });
  };
  const state = () => ext.state(`${BASE}/demo`);
  const playFrom = (t) => page.evaluate(async (t) => {
    const v = document.getElementById('v');
    window.cleancutDemoEvents.length = 0;
    v.currentTime = t;
    await v.play();
  }, t);
  const now = () => page.evaluate(() => document.getElementById('v').currentTime);
  const events = (type) => page.evaluate((type) => window.cleancutDemoEvents.filter((e) => e.type === type), type);
  const heardSegment = async (word) => (await state())?.flagged.find((f) => f.source === 'listening' && f.category === 'language' && f.start <= word.end && f.end >= word.start);
  const offscreen = () => ext.worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
  const tabId = () => ext.worker.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => (t.url || '').startsWith(u))?.id, `${BASE}/demo`);
  const popupFor = async () => {
    const popup = await ext.context.newPage();
    popup.on('pageerror', (e) => errors.push(`popup: ${e.message}`));
    await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=${await tabId()}`);
    await popup.locator('#now-title', { hasText: /\S/ }).waitFor();
    return popup;
  };

  await step('off by default: nothing on the page, no copies, no offscreen document, no mute', async () => {
    await open();
    const page0 = await page.evaluate(() => ({
      append: SourceBuffer.prototype.appendBuffer.toString(),
      add: MediaSource.prototype.addSourceBuffer.toString(),
      flag: localStorage.getItem('cleancut:listen'),
    }));
    assert.match(page0.append, /\[native code\]/, 'appendBuffer is the browser’s own');
    assert.match(page0.add, /\[native code\]/, 'addSourceBuffer is the browser’s own');
    assert.equal(page0.flag, null);
    await playFrom(swear1.start - 2.5);
    await waitFor(async () => (await now()) > swear1.end + 0.5, { timeout: 8000, what: 'playing past the word' });
    assert.deepEqual(await events('muted'), [], 'no mute');
    const s = await state();
    assert.equal(s.listening.state, 'off');
    assert.equal(s.listening.appends, 0);
    assert.equal(s.counts.listening, 0);
    assert.equal(await offscreen(), 0, 'no offscreen document');
    const st = await ext.worker.evaluate(() => caches.keys());
    assert.deepEqual(st, [], 'no model on disk');
  });

  await step('turning it on asks first (size, source, on this computer), then downloads the model once and turns on', async () => {
    const popup = await popupFor();
    await popup.locator('#advanced summary').click();
    await popup.locator('#listen-on').check();
    const consent = popup.locator('#listen-consent');
    await consent.waitFor();
    const text = await consent.textContent();
    assert.match(text, /44 MB/);
    assert.match(text, /Hugging Face/);
    assert.match(text, /never leaves/i);
    assert.equal(mirror.requests.length, 0, 'nothing downloaded before consent');
    await popup.locator('#listen-download').click();
    await waitFor(() => ext.worker.evaluate(() => chrome.storage.local.get('listening').then((r) => r.listening?.on === true)), { timeout: 60_000, what: 'download complete, listening on' });
    assert.ok(mirror.requests.includes('onnx/encoder_model_quantized.onnx') && mirror.requests.includes('onnx/decoder_model_merged_quantized.onnx'));
    // This page loaded before listening was on here: it asks for a reload.
    await popup.locator('#listen-status', { hasText: /Reload/ }).waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('cleancut:listen')), '1', 'the site’s flag is set for the next load');
    await popup.close();
  });

  await step('paused, the speech worker idles; playing, it starts', async () => {
    await open();
    assert.doesNotMatch(await page.evaluate(() => SourceBuffer.prototype.appendBuffer.toString()), /\[native code\]/, 'the hook copies appends now');
    // The player has buffered 30 s, but nothing plays: nothing is transcribed.
    await page.waitForTimeout(4000);
    const s = await state();
    assert.ok(s.listening.appends >= 2, `audio forwarded (${s.listening.appends} appends)`);
    assert.equal(s.listening.windows?.length || 0, 0, 'no window transcribed while paused');
    await page.evaluate(() => document.getElementById('v').play());
    await waitFor(async () => (await state()).listening.windows?.length > 0, { timeout: 15_000, what: 'a window once playing' });
    await page.evaluate(() => document.getElementById('v').pause());
  });

  let foundAt = null;
  await step('listening finds a swear in the buffered audio before the playhead reaches it', async () => {
    await open();
    await playFrom(0);
    const seg = await waitFor(() => heardSegment(swear1), { timeout: 30_000, interval: 250, what: `a listening segment at ${swear1.start}s` });
    foundAt = await now();
    assert.ok(foundAt < swear1.start - 3, `found at playhead ${foundAt.toFixed(1)}s, the word is at ${swear1.start}s`);
    assert.equal(seg.decision, 'filter', 'a strong word is cut at PG-13');
    assert.ok(seg.start <= swear1.start && seg.end >= swear1.end - 0.15, `segment ${seg.start.toFixed(2)}–${seg.end.toFixed(2)} covers the word ${swear1.start}–${swear1.end}`);
  });

  await step('the mute starts just before the word and ends just after it', async () => {
    await playFrom(swear1.start - 3);
    const [muted] = await waitFor(() => events('muted').then((e) => e.length && e), { timeout: 8000, what: 'mute' });
    const [unmuted] = await waitFor(() => events('unmuted').then((e) => e.length && e), { timeout: 5000, what: 'unmute' });
    assert.ok(muted.at > swear1.start - 0.9 && muted.at <= swear1.start, `muted at ${muted.at.toFixed(2)}, word at ${swear1.start}`);
    assert.ok(unmuted.at >= swear1.end && unmuted.at < swear1.end + 0.9, `unmuted at ${unmuted.at.toFixed(2)}, word ends ${swear1.end}`);
    assert.equal(await page.evaluate(() => document.getElementById('v').muted), false);
  });

  await step('after a seek, the new stretch is heard first, and its swear muted in time', async () => {
    const target = swear2.start - 12;
    const before = JSON.stringify((await state()).listening.windows || []);
    await playFrom(target);
    const seg = await waitFor(() => heardSegment(swear2), { timeout: 20_000, interval: 200, what: `a listening segment at ${swear2.start}s` });
    const at = await now();
    assert.ok(at < swear2.start - 0.5, `found at playhead ${at.toFixed(1)}s, the word is at ${swear2.start}s`);
    assert.equal(seg.decision, 'filter');
    // The first window heard after the seek began at the new place (not where listening had got to).
    const seen = new Set(JSON.parse(before).map((w) => JSON.stringify(w)));
    const after = (await state()).listening.windows.filter((w) => !seen.has(JSON.stringify(w)) && !w.cancelled);
    assert.ok(after.length && after[0].start <= target + 1 && after[0].start >= target - 2, `first window after the seek: ${JSON.stringify(after[0])}`);
    const [muted] = await waitFor(() => events('muted').then((e) => e.length && e), { timeout: 10_000, what: 'mute after the seek' });
    assert.ok(muted.at > swear2.start - 0.9 && muted.at <= swear2.start, `muted at ${muted.at.toFixed(2)}, word at ${swear2.start}`);
  });

  await step('the popup says how far it has listened, and counts what it found', async () => {
    const popup = await popupFor();
    await popup.locator('#now-listen', { hasText: /Listening ahead · (paused, )?transcribed to \d+:\d\d/ }).waitFor({ timeout: 5000 });
    assert.match(await popup.locator('#now-sources').textContent(), /\d+ from listening/);
    await popup.locator('#advanced summary').click();
    await popup.locator('#listen-status', { hasText: /Listening ahead/ }).waitFor({ timeout: 3000 });
    await popup.close();
  });

  await step('captions win: on the captioned demo, nothing is listened to', async () => {
    await page.goto(`${BASE}/demo`);
    await page.waitForSelector('cleancut-overlay', { state: 'attached', timeout: 10_000 });
    const s = await waitFor(async () => {
      const x = await state();
      return x?.subtitle && x;
    }, { what: 'captions scanned' });
    await waitFor(async () => (await state()).listening.state === 'captions', { what: 'listening stands aside' });
    assert.equal(s.counts.listening, 0);
  });

  await step('encrypted audio (EME, CENC) is refused, with a plain message', async () => {
    await open('?audio=enc');
    await page.evaluate(() => document.getElementById('v').play());
    await waitFor(async () => (await state())?.listening.state === 'encrypted', { timeout: 10_000, what: 'encrypted state' });
    const popup = await popupFor();
    await popup.locator('#now-warning', { hasText: 'This service encrypts its audio, so CleanCut can’t listen ahead here' }).waitFor({ timeout: 5000 });
    assert.match(await popup.locator('#listen-status').textContent(), /Encrypted here, can’t listen/);
    await popup.close();
    await page.waitForTimeout(1500);
    assert.equal((await state()).counts.listening, 0);
  });

  await step('off for this site: the flag is removed, and after a reload nothing is touched', async () => {
    await open();
    const popup = await popupFor();
    await popup.locator('#advanced summary').click();
    await popup.locator('#listen-site').click();
    await waitFor(() => page.evaluate(() => localStorage.getItem('cleancut:listen') === null), { what: 'flag removed' });
    await popup.close();
    await open();
    assert.match(await page.evaluate(() => SourceBuffer.prototype.appendBuffer.toString()), /\[native code\]/);
    assert.equal((await state()).listening.state, 'site-off');
  });

  await step('Options shows the model and deletes it; listening turns off', async () => {
    const options = await ext.context.newPage();
    options.on('pageerror', (e) => errors.push(`options: ${e.message}`));
    await options.goto(`chrome-extension://${ext.extensionId}/options.html`);
    await options.locator('#listen-model', { hasText: /Whisper tiny\.en.*44 MB.*downloaded/s }).waitFor({ timeout: 5000 });
    await options.locator('#listen-delete').click();
    await options.locator('#listen-model', { hasText: /not downloaded/ }).waitFor({ timeout: 5000 });
    assert.deepEqual(await ext.worker.evaluate(() => caches.keys()), []);
    assert.equal(await ext.worker.evaluate(() => chrome.storage.local.get('listening').then((r) => r.listening.on)), false);
    await options.close();
  });

  await step('no page errors', async () => assert.deepEqual(errors, []));
} catch (e) {
  console.error(e);
} finally {
  await ext?.close();
  server.kill();
  mirror.close();
}
process.exit(summary() ? 1 : 0);
