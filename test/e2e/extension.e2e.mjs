// End-to-end: loads the built extension into Chromium, serves the demo
// "episode" and a copy of the catalog locally, plays it and checks that scenes
// are really skipped, muted and hidden, that tags timed on another service are
// synced from subtitle timing, and that sharing produces a submission the
// catalog bot accepts.
//
//   npm run test:e2e
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { ensureDemoVideo, explainLaunchError, loadChromium } from '../support/browser.mjs';
import { buildIndex, formatCatalogJson } from '../../shared/catalog.js';

const chromium = loadChromium();

const root = fileURLToPath(new URL('../../', import.meta.url));
const ext = join(root, 'extension/dist/chrome');
const PORT = 8787;
const BASE = `http://localhost:${PORT}`;
const XPLAT = `http://localhost:${PORT + 1}`;
const tmp = mkdtempSync(join(tmpdir(), 'cleancut-e2e-'));

ensureDemoVideo();

// A copy of the repository's catalog, and a variant in which the demo
// episode's tags were timed on "Netflix" 5 s later and the demo page is not
// listed at all: the extension has to find it by title and sync from subtitles.
const catalogDir = join(tmp, 'catalog');
cpSync(join(root, 'catalog'), catalogDir, { recursive: true });
const xplatDir = join(tmp, 'catalog-xplat');
cpSync(join(root, 'catalog'), xplatDir, { recursive: true });
{
  const file = join(xplatDir, 'shows/cleancut-demo/s01e01.json');
  const ep = JSON.parse(readFileSync(file, 'utf8'));
  ep.timeline = 'netflix';
  ep.platforms = { netflix: { id: '80000099', offset: 0, speed: 1 } };
  ep.sync.cues = ep.sync.cues.map((c) => c + 5);
  ep.segments = ep.segments.map((x) => ({ ...x, on: 'netflix', start: x.start + 5, end: x.end + 5 }));
  writeFileSync(file, formatCatalogJson(ep));
  const read = (f) => JSON.parse(readFileSync(join(xplatDir, f), 'utf8'));
  writeFileSync(join(xplatDir, 'index.json'), formatCatalogJson(buildIndex({
    shows: { 'cleancut-demo': read('shows/cleancut-demo/show.json') },
    episodes: [ep],
    lists: [read('lists/family-night.json'), read('lists/teen-friendly.json')],
  })));
}
const devServer = (port, dir) => spawn(process.execPath, [join(root, 'scripts/dev-server.mjs')], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CATALOG_DIR: dir },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const servers = [devServer(PORT, catalogDir), devServer(PORT + 1, xplatDir)];
let context;
const results = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok  ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
}

async function waitFor(fn, { timeout = 10_000, interval = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${what}`);
}

try {
  for (const base of [BASE, XPLAT]) {
    await waitFor(() => fetch(`${base}/catalog/index.json`).then((r) => r.ok, () => false), { what: `dev server ${base}` });
  }

  // ---- browser with the extension ----------------------------------------------
  context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
  }).catch(explainLaunchError);
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const setSettings = (patch) => worker.evaluate(async (p) => {
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...settings, ...p, profile: { ...settings.profile, ...(p.profile || {}) } } });
  }, patch);
  await waitFor(() => worker.evaluate(() => chrome.storage.sync.get('settings').then((s) => !!s.settings?.profile)), { what: 'default settings' });
  const useCatalog = async (base) => {
    await setSettings({ catalogBase: `${base}/catalog/` });
    await worker.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('cat:') || k === 'catalogIndex'));
    });
  };
  await useCatalog(BASE);
  // Sharing opens github.com; keep the test offline and just read the link.
  const githubRequests = [];
  await context.route('https://github.com/**', (r) => {
    githubRequests.push(r.request().url());
    r.abort();
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  async function openDemo(query = '') {
    await page.goto(`${BASE}/demo${query}`);
    await page.waitForSelector('cleancut-overlay', { state: 'attached', timeout: 10_000 });
    await page.waitForFunction(() => document.getElementById('v').readyState >= 2);
  }
  const playFrom = (t) => page.evaluate(async (t) => {
    const v = document.getElementById('v');
    window.cleancutDemoEvents.length = 0;
    v.currentTime = t;
    await v.play();
  }, t);
  const events = () => page.evaluate(() => window.cleancutDemoEvents.map(({ type, from, to }) => ({ type, from, to })));
  const badge = () => page.evaluate(() => document.querySelector('cleancut-overlay').shadowRoot.querySelector('.badge').textContent);
  const autoSeeks = async () => (await events()).filter((e) => e.type === 'seek').slice(1); // [0] is our own playFrom seek

  console.log('CleanCut e2e');
  await openDemo();

  await step('finds the title in the catalog and builds a PG-13 plan from tags + subtitle scan', async () => {
    const text = await waitFor(async () => {
      const b = await badge();
      return /4 cuts/.test(b) && b;
    }, { what: 'badge with 4 cuts' });
    assert.match(text, /PG-13/);
  });

  await step('skips a catalog-tagged violent scene (0:20–0:30)', async () => {
    await playFrom(17.5);
    const seek = await waitFor(async () => (await autoSeeks()).find((s) => s.to >= 29.9), { what: 'skip past 0:30' });
    assert.ok(seek.from < 20.5, `skipped from ${seek.from}`);
    assert.ok(seek.to < 31, `landed at ${seek.to}`);
  });

  await step('skips an untagged sex scene found by scan-ahead SDH analysis (0:44–0:52)', async () => {
    await playFrom(40);
    const seek = await waitFor(async () => (await autoSeeks()).find((s) => s.to >= 51.5), { what: 'skip past 0:51' });
    assert.ok(seek.from < 44, `skipped from ${seek.from}`);
  });

  await step('mutes strong language found in subtitles (1:00–1:02), then unmutes', async () => {
    await playFrom(58.5);
    await waitFor(async () => (await events()).some((e) => e.type === 'muted'), { what: 'mute' });
    await waitFor(async () => (await events()).some((e) => e.type === 'unmuted'), { what: 'unmute' });
    assert.equal(await page.evaluate(() => document.getElementById('v').muted), false);
  });

  await step('skips tagged gore (1:10–1:15)', async () => {
    await playFrom(68);
    await waitFor(async () => (await autoSeeks()).find((s) => s.to >= 74.9), { what: 'skip past 1:15' });
  });

  await step('"hide picture" action hides instead of skipping', async () => {
    await setSettings({ profile: { actions: { violence: 'blur' } } });
    await page.waitForTimeout(300);
    await playFrom(19);
    await waitFor(async () => (await events()).some((e) => e.type === 'blurred'), { what: 'blur' });
    assert.equal((await autoSeeks()).length, 0, 'should not seek when blurring');
    await waitFor(async () => (await events()).some((e) => e.type === 'unblurred'), { timeout: 15_000, what: 'unblur after 0:30' });
    await setSettings({ profile: { actions: { violence: 'skip' } } });
  });

  await step('stricter and looser ratings change the cut', async () => {
    await setSettings({ profile: { preset: 'unfiltered' } });
    await waitFor(async () => /0 cuts/.test(await badge()), { what: 'unfiltered → 0 cuts' });
    await setSettings({ profile: { preset: 'R' } });
    // R keeps the violence and the language but cuts strong sex and gore.
    await waitFor(async () => /2 cuts/.test(await badge()), { what: 'R → 2 cuts' });
    await setSettings({ profile: { preset: 'PG-13' } });
    await waitFor(async () => /4 cuts/.test(await badge()), { what: 'back to 4 cuts' });
  });

  await step('Undo lets a skipped scene play', async () => {
    await playFrom(17.5);
    await waitFor(async () => (await autoSeeks()).find((s) => s.to >= 29.9), { what: 'skip' });
    await page.locator('cleancut-overlay .toast button', { hasText: 'Undo' }).first().click();
    const back = await waitFor(async () => (await autoSeeks()).find((s) => s.to < 21 && s.from > 25), { what: 'seek back to 0:20' });
    assert.ok(back);
    await page.waitForTimeout(1500);
    const t = await page.evaluate(() => document.getElementById('v').currentTime);
    assert.ok(t > 20 && t < 29, `now playing inside the scene at ${t}`);
  });

  await step('a skip list from the catalog can be adopted', async () => {
    const list = JSON.parse(readFileSync(join(catalogDir, 'lists/family-night.json'), 'utf8'));
    // Store the list exactly as the popup's "Use" button does (background useList).
    await worker.evaluate(async (profile) => {
      const { activeLists = {} } = await chrome.storage.local.get('activeLists');
      activeLists['web:demo-episode-1'] = { id: profile.id, name: profile.name, settings: profile.settings, overrides: profile.overrides, scope: 'this title' };
      await chrome.storage.local.set({ activeLists });
    }, list);
    await waitFor(async () => /Family movie night · 4 cuts/.test(await badge()), { what: 'list applied' });
    await worker.evaluate(() => chrome.storage.local.remove('activeLists'));
    await waitFor(async () => /4 cuts/.test(await badge()), { what: 'list removed' });
  });

  // ---- flagging scenes on the player -------------------------------------------------
  const overlayEl = (sel, o) => page.locator(`cleancut-overlay ${sel}`, o);
  const localTags = () => worker.evaluate(() => chrome.storage.local.get('localTags').then((r) => r.localTags?.['web:demo-episode-1']?.segments || []));
  const paused = () => page.evaluate(() => document.getElementById('v').paused);
  const overVideo = async () => {
    const v = await page.locator('#v').boundingBox();
    await page.mouse.move(v.x + v.width / 3, v.y + v.height / 3);
  };

  await step('flagging by mouse: Flag → Done → category → Save applies at once, and Undo removes it', async () => {
    await playFrom(33);
    await overVideo();
    await overlayEl('.flag-start').click();
    await page.waitForTimeout(1500);
    await overlayEl('.flag-done').click();
    const picker = overlayEl('.picker');
    await picker.waitFor();
    assert.equal(await paused(), true, 'paused while picking');
    assert.equal(await picker.locator('.save').isDisabled(), true, 'Save waits for a category');
    await picker.getByRole('radio', { name: 'Nudity' }).click();
    await picker.locator('.save').click();
    const toast = overlayEl('.toast', { hasText: 'Flagged nudity (moderate)' });
    await toast.waitFor();
    await waitFor(async () => /5 cuts/.test(await badge()), { what: 'mouse flag in the plan' });
    assert.equal(await paused(), false, 'playback resumes after saving');
    const [seg] = await localTags();
    assert.equal(seg.category, 'nudity');
    assert.equal(seg.severity, 2);
    assert.ok(seg.start >= 32 && seg.start <= 34 && seg.end - seg.start >= 1 && seg.end <= 38, JSON.stringify(seg));
    await toast.locator('button', { hasText: 'Undo' }).click();
    await waitFor(async () => /4 cuts/.test(await badge()), { what: 'Undo removes the flag from the plan' });
    assert.deepEqual(await localTags(), []);
  });

  await step('"Last 10 s" opens the picker on what just played, nudges ±1 s, and Escape cancels', async () => {
    await playFrom(12);
    await page.waitForTimeout(1500);
    await overVideo();
    await overlayEl('.flag-last').click();
    const picker = overlayEl('.picker');
    await picker.waitFor();
    const secs = async (sel) => {
      const [m, s] = (await picker.locator(sel).textContent()).split(':').map(Number);
      return m * 60 + s;
    };
    const end = await secs('.val.end');
    const start = await secs('.val.start');
    assert.ok(end >= 13 && end <= 15 && [10, 11].includes(end - start), `range ${start}–${end}`); // whole seconds, rounded outward
    assert.equal(await picker.locator('.len').textContent(), `${end - start} s`);
    const earlier = picker.getByRole('button', { name: 'Start 1 second earlier' });
    await picker.getByRole('button', { name: 'End 1 second later' }).click();
    for (let i = 0; i < start; i++) await earlier.click();
    await waitFor(async () => (await secs('.val.start')) === 0 && (await secs('.val.end')) === end + 1, { what: 'nudged to 0:00–end+1' });
    assert.equal(await earlier.isDisabled(), true, 'cannot start before 0:00');
    await page.keyboard.press('Escape');
    await picker.waitFor({ state: 'hidden' });
    assert.equal(await paused(), false, 'playback resumes after cancelling');
    await overlayEl('.flag-start').waitFor(); // back to the idle control
    assert.deepEqual(await localTags(), []);
  });

  await step('tagging with Alt+[ / Alt+] saves a local tag that is applied immediately', async () => {
    await playFrom(4);
    await page.waitForTimeout(400);
    await page.keyboard.press('Alt+BracketLeft');
    await overlayEl('.dock.recording').waitFor(); // the recording pill shows without moving the mouse
    await page.waitForTimeout(1200);
    await page.keyboard.press('Alt+BracketRight');
    const picker = overlayEl('.picker');
    await picker.waitFor();
    // From a shortcut, focus is in the categories: arrows pick, Tab moves on.
    await waitFor(() => page.evaluate(() => document.querySelector('cleancut-overlay').shadowRoot.activeElement?.textContent === 'Nudity'), { what: 'focus on the first category' });
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    // DOM writes land in the next animation frame (slow in a headless, idle page).
    await waitFor(async () => (await picker.getByRole('radio', { name: 'Drugs & alcohol' }).getAttribute('aria-checked')) === 'true', { what: 'arrows select Drugs & alcohol' });
    await page.keyboard.press('Tab'); // severity (Moderate)
    await page.keyboard.press('ArrowRight'); // Strong
    await waitFor(async () => (await picker.getByRole('radio', { name: 'Strong' }).getAttribute('aria-checked')) === 'true', { what: 'Strong selected' });
    await page.keyboard.press('Tab'); // + Add a note
    await page.keyboard.press('Enter');
    await picker.locator('.note').waitFor();
    await page.keyboard.type('e2e tag');
    await page.keyboard.press('Enter'); // Enter in the note saves
    await overlayEl('.toast', { hasText: 'Flagged drugs & alcohol (strong)' }).waitFor();
    const tags = await worker.evaluate(() => chrome.storage.local.get('localTags').then((r) => r.localTags));
    const seg = tags['web:demo-episode-1'].segments[0];
    assert.equal(seg.category, 'drugs');
    assert.equal(seg.severity, 3);
    assert.equal(seg.note, 'e2e tag');
    assert.ok(seg.start >= 3.5 && seg.end > seg.start, JSON.stringify(seg));
    await waitFor(async () => /5 cuts/.test(await badge()), { what: 'new tag in plan' });
  });

  await step('"Share on GitHub" opens a prefilled issue the catalog bot accepts', async () => {
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost/*' }))[0].id);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
    const share = popup.locator('#share');
    await share.waitFor();
    assert.match(await share.textContent(), /Share 1 tag on GitHub/);
    await share.click();
    const url = new URL(await waitFor(() => githubRequests.find((u) => u.includes('/issues/new')), { what: 'GitHub issue link' }));
    if (process.env.DEBUG_E2E) console.log('      link:', githubRequests.map((u) => u.slice(0, 300)));
    for (const p of context.pages()) if (p !== page && p !== popup) await p.close();
    await popup.close();
    assert.equal(url.hostname, 'github.com');
    assert.equal(url.searchParams.get('template'), 'submit-to-catalog.yml');
    const submission = JSON.parse(url.searchParams.get('submission'));
    assert.deepEqual(submission.title.platform, 'web');
    assert.deepEqual(submission.title.platformId, 'demo-episode-1');
    assert.equal(submission.title.series, 'CleanCut Demo');
    assert.equal(submission.segments.length, 1);
    assert.equal(submission.segments[0].category, 'drugs');
    assert.ok(submission.sync.length >= 20, 'includes subtitle timing');
    // What the GitHub Action does with the issue body:
    const body = `### Submission\n\n\`\`\`json\n${JSON.stringify(submission, null, 1)}\n\`\`\`\n`;
    writeFileSync(join(tmp, 'issue.md'), body);
    const r = spawnSync(process.execPath, [join(root, 'scripts/catalog.mjs'), 'ingest', join(tmp, 'issue.md'), '--dir', catalogDir, '--author', 'e2e-user'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const ep = JSON.parse(readFileSync(join(catalogDir, 'shows/cleancut-demo/s01e01.json'), 'utf8'));
    assert.equal(ep.segments.length, 3);
    assert.equal(ep.segments.find((x) => x.category === 'drugs').by, 'e2e-user');
    // Shared tags are marked, so the button does not offer them again.
    const tags = await worker.evaluate(() => chrome.storage.local.get('localTags').then((x) => x.localTags));
    assert.ok(tags['web:demo-episode-1'].segments[0].sharedAt);
  });

  await step('page hook finds the subtitle track from player JSON (Prime-style) and scans it', async () => {
    await worker.evaluate(() => chrome.storage.local.remove('localTags'));
    await openDemo('?mode=hook');
    assert.equal(await page.evaluate(() => document.querySelectorAll('track').length), 0);
    await waitFor(async () => /4 cuts/.test(await badge()), { what: 'badge with 4 cuts via hook' });
    await playFrom(58.5);
    await waitFor(async () => (await events()).some((e) => e.type === 'muted'), { what: 'mute from hooked subtitles' });
  });

  await step('tags timed on another service are synced from subtitle timing', async () => {
    await useCatalog(XPLAT);
    await openDemo();
    await page.locator('cleancut-overlay .toast', { hasText: 'Synced 2 tags' }).waitFor({ timeout: 10_000 });
    await waitFor(async () => /4 cuts/.test(await badge()), { what: 'badge with 4 cuts after sync' });
    await playFrom(17.5);
    const seek = await waitFor(async () => (await autoSeeks()).find((x) => x.to >= 29.9), { what: 'synced skip past 0:30' });
    assert.ok(seek.from < 20.5 && seek.to < 31, JSON.stringify(seek));
    await useCatalog(BASE);
  });

  await step('the popup\'s openFlagger message shows the flag control, or says there is no video', async () => {
    await openDemo();
    await page.mouse.move(2, 2);
    await overlayEl('.flag-start').waitFor({ state: 'hidden', timeout: 6000 });
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => /\/demo/.test(t.url || ''))?.id);
    const send = (message) => worker.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [tabId, message]);
    assert.deepEqual(await send({ type: 'openFlagger' }), { ok: true });
    await overlayEl('.flag-start').waitFor({ timeout: 2000 }); // shown without any mouse movement
    await page.waitForTimeout(3000);
    assert.equal(await overlayEl('.flag-start').isVisible(), true, 'stays up longer than a normal reveal');
    await page.evaluate(() => document.getElementById('v').remove());
    const res = await waitFor(async () => {
      const r = await send({ type: 'openFlagger' });
      return r?.error && r;
    }, { what: 'openFlagger error without a video' });
    assert.match(res.error, /no video/);
    await openDemo();
  });

  await step('popup renders without errors', async () => {
    const popup = await context.newPage();
    const perrs = [];
    popup.on('pageerror', (e) => perrs.push(e.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForSelector('#presets button');
    assert.equal(await popup.locator('#presets button').count(), 6);
    await popup.locator('#presets button', { hasText: 'Custom' }).click();
    await popup.waitForSelector('#custom .cat-row');
    assert.equal(await popup.locator('#custom .cat-row').count(), 7);
    // Pointed at the demo tab: no skip list is made for this title (the catalog's
    // lists are for all titles), so the Community skip lists card stays hidden.
    const demoTab = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => /\/demo/.test(t.url || ''))?.id);
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${demoTab}`);
    await popup.locator('#now-title', { hasText: /\S/ }).waitFor();
    await popup.waitForTimeout(300);
    assert.equal(await popup.locator('#upcoming-card').isHidden(), false, 'title cards shown');
    assert.equal(await popup.locator('#lists-card').isHidden(), true, 'no skip lists card without a list for this title');
    const options = await context.newPage();
    options.on('pageerror', (e) => perrs.push(e.message));
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator('#catalog-status', { hasText: 'Connected' }).waitFor();
    assert.deepEqual(perrs, []);
    await popup.close();
    await options.close();
  });

  await step('no page errors', async () => assert.deepEqual(errors, []));
} catch (e) {
  console.error(e);
  results.push({ name: 'setup', ok: false });
} finally {
  await context?.close();
  for (const s of servers) s.kill();
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
