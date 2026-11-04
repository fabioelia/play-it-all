// Screenshots of every popup state and the options page, in light and dark,
// taken from the built extension in Chromium. Real states come from the demo
// page; the rest (Netflix, offline, unsynced…) feed the popup a snapshot by
// standing in for the content script's answer to getState.
//
//   npm run build && node test/e2e/ui-screenshots.mjs [outDir]    (default docs/ui)
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureDemoVideo, explainLaunchError, loadChromium } from '../support/browser.mjs';

const chromium = loadChromium();
const root = fileURLToPath(new URL('../../', import.meta.url));
const ext = join(root, 'extension/dist/chrome');
const out = resolve(process.argv[2] || join(root, 'docs/ui'));
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const PORT = Number(process.env.PORT) || 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://localhost:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), 'cleancut-ui-'));
mkdirSync(out, { recursive: true });
ensureDemoVideo();

const catalogDir = join(tmp, 'catalog');
cpSync(join(root, 'catalog'), catalogDir, { recursive: true });
const server = spawn(process.execPath, [join(root, 'scripts/dev-server.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CATALOG_DIR: catalogDir },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitFor(fn, { timeout = 10_000, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let context;
try {
  await waitFor(() => fetch(`${BASE}/catalog/index.json`).then((r) => r.ok), { what: 'dev server' });
  context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 360, height: 560 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
  }).catch(explainLaunchError);
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  await waitFor(() => worker.evaluate(() => chrome.storage.sync.get('settings').then((s) => !!s.settings?.profile)), { what: 'settings' });
  const setSettings = (patch) => worker.evaluate(async (p) => {
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...settings, ...p, profile: { ...settings.profile, ...(p.profile || {}) } } });
  }, patch);
  await setSettings({ catalogBase: `${BASE}/catalog/` });
  await context.route('https://raw.githubusercontent.com/cleancut-ui/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>News</title><h1>An article</h1>' }));

  // Tabs the popup can point at.
  const demo = await context.newPage();
  await demo.goto(`${BASE}/demo`);
  await demo.waitForSelector('cleancut-overlay', { state: 'attached' });
  await demo.evaluate(async () => {
    const v = document.getElementById('v');
    v.currentTime = 33;
    await v.play();
    v.pause();
  });
  const article = await context.newPage();
  await article.goto('https://raw.githubusercontent.com/cleancut-ui/article');
  const blank = await context.newPage();
  await blank.goto(`${BASE}/nothing-here`);
  const tabId = (pattern) => worker.evaluate(async (p) => (await chrome.tabs.query({})).find((t) => new RegExp(p).test(t.url || ''))?.id, pattern);
  const tabs = { demo: await tabId('/demo'), article: await tabId('cleancut-ui/article'), blank: await tabId('nothing-here') };
  await waitFor(() => worker.evaluate((t) => chrome.tabs.sendMessage(t, { type: 'getState' }).then((s) => s?.actions?.length >= 4), tabs.demo), { what: 'demo plan' });
  const real = await worker.evaluate((t) => chrome.tabs.sendMessage(t, { type: 'getState' }), tabs.demo);

  // ---- fixtures, derived from the real demo snapshot --------------------------------------
  const netflix = {
    ...real,
    platform: 'netflix',
    title: 'Harbor Lights S1:E3 · The Night of the Storm',
    titleKey: 'netflix:80000003',
    ident: { ...real.ident, platform: 'netflix', platformId: '80000003' },
    catalog: { ...real.catalog, key: 'harbor-lights/s01e03', via: 'id', timing: 'native', timeline: 'netflix' },
    diag: { hook: true, manifests: 2, decrypted: 1, available: 3, dehydrated: 0, tracks: 1, download: 'done' },
  };
  const fx = {
    identifying: { ...real, ident: null, title: null, actions: [], flagged: [], catalog: null },
    'no-hit': {
      ...netflix,
      catalog: null,
      counts: { community: 0, local: 0, subtitles: 1 },
      actions: real.actions.filter((a) => a.reasons.some((r) => r.category === 'language')),
      skipped: 0,
    },
    'no-tags': { ...netflix, title: 'The Quiet Hour', catalog: null, counts: { community: 0, local: 0, subtitles: 0 }, subtitle: null, actions: [], flagged: [], skipped: 0 },
    unsynced: { ...netflix, platform: 'prime', catalog: { ...netflix.catalog, timing: 'unsynced', timeline: 'netflix' }, subtitle: null },
    aligned: { ...netflix, platform: 'prime', catalog: { ...netflix.catalog, timing: 'aligned', alignment: { offset: 5.2 }, timeline: 'netflix' } },
    offline: { ...netflix, online: false, lookupError: 'catalog did not respond' },
    'long-title': { ...netflix, title: 'The Extraordinarily Long-Named Anthology Series With a Subtitle S12:E104 · Part Two: The Return of the Episode Whose Name Never Ends' },
    lists: {
      ...netflix,
      unshared: 2,
      activeList: { id: 'family-night', name: 'Family movie night', scope: 'harbor-lights' },
      profiles: [
        { id: 'family-night', name: 'Family movie night', author: 'mara', scope: 'harbor-lights', settings: { preset: 'PG' }, description: 'Keeps the scares, drops the gore.' },
        { id: 'teen-cut', name: 'Teen cut', author: 'jo', scope: 'harbor-lights/s01e03', settings: { preset: 'PG-13' } },
      ],
    },
  };

  async function shot(name, { tab, fixture, setup, flagger, tabUrl } = {}) {
    if (only && !only.test(name)) return;
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // The real popup sees the tab's address (activeTab); a page opened here does not.
    // The demo is labelled with the dev server's usual port rather than this run's.
    if (!tabUrl && tab === tabs.demo) tabUrl = 'http://localhost:8787/demo';
    if (tabUrl) {
      await page.addInitScript((url) => {
        const get = chrome.tabs.get.bind(chrome.tabs);
        chrome.tabs.get = async (id) => ({ ...(await get(id)), url });
      }, tabUrl);
    }
    if (fixture) {
      await page.addInitScript(({ state, flagger }) => {
        let current = state;
        chrome.tabs.sendMessage = async (_tab, msg) => {
          if (msg.type === 'openFlagger') return flagger === 'none' ? undefined : flagger;
          if (msg.type === 'toggleRegion') {
            const off = new Set(current.disabled);
            off.has(msg.key) ? off.delete(msg.key) : off.add(msg.key);
            current = { ...current, disabled: [...off] };
          }
          return current;
        };
      }, { state: fixture, flagger: flagger ?? 'none' });
    }
    await page.goto(`chrome-extension://${id}/popup.html${tab ? `?tab=${tab}` : ''}`);
    await page.waitForTimeout(700);
    if (setup) await setup(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) console.log(`  ${name}: ${overflow}px horizontal overflow`);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(80);
      await page.screenshot({ path: join(out, `popup-${name}-${scheme}.png`), fullPage: true });
    }
    if (errors.length) console.log(`  ${name}: page errors`, errors);
    await page.close();
    console.log(`  popup-${name}`);
  }

  console.log(`Screenshots → ${out}`);
  await shot('not-supported', { tab: tabs.article, tabUrl: 'https://news.example/story' });
  await shot('no-player', {});
  await shot('no-video', { tab: tabs.blank, tabUrl: 'http://localhost:8787/' });
  await shot('identifying', { tab: tabs.demo, fixture: fx.identifying });
  await shot('playing', { tab: tabs.demo });
  await shot('netflix', { tab: tabs.demo, fixture: netflix });
  await shot('no-catalog-hit', { tab: tabs.demo, fixture: fx['no-hit'] });
  await shot('no-tags', { tab: tabs.demo, fixture: fx['no-tags'] });
  await shot('unsynced', { tab: tabs.demo, fixture: fx.unsynced });
  await shot('aligned', { tab: tabs.demo, fixture: fx.aligned });
  await shot('offline', { tab: tabs.demo, fixture: fx.offline });
  await shot('long-title', { tab: tabs.demo, fixture: fx['long-title'] });
  await shot('skip-lists', {
    tab: tabs.demo,
    fixture: fx.lists,
    setup: async (p) => { await p.locator('#lists-card summary').click().catch(() => {}); },
  });
  await shot('flag-error', {
    tab: tabs.demo,
    fixture: { ...netflix, unshared: 1 },
    setup: async (p) => { await p.locator('#flag').click(); await p.waitForTimeout(200); },
  });
  await shot('custom', {
    tab: tabs.demo,
    setup: async (p) => {
      await p.locator('#presets button', { hasText: 'Custom' }).click();
      await p.waitForTimeout(300);
      await p.locator('#advanced summary').click().catch(() => {});
    },
  });
  await setSettings({ profile: { preset: 'PG-13' } });
  await shot('troubleshooting', {
    tab: tabs.demo,
    fixture: netflix,
    setup: async (p) => {
      await p.locator('#troubleshooting summary').click().catch(() => {});
      await p.locator('#troubleshooting').scrollIntoViewIfNeeded().catch(() => {});
    },
  });
  await shot('publish-dialog', {
    tab: tabs.demo,
    fixture: netflix,
    setup: async (p) => {
      // The real popup is as tall as its content, so the backdrop covers all of it.
      await p.setViewportSize({ width: 360, height: await p.evaluate(() => document.documentElement.scrollHeight) });
      await p.locator('#publish').click();
    },
  });
  await shot('keyboard-focus', {
    tab: tabs.demo,
    fixture: netflix,
    setup: async (p) => {
      await p.keyboard.press('Tab');
      await p.keyboard.press('Tab');
    },
  });
  await setSettings({ enabled: false });
  await shot('disabled', { tab: tabs.demo });
  await setSettings({ enabled: true });

  if (!only || only.test('options')) {
    const options = await context.newPage();
    await options.setViewportSize({ width: 800, height: 900 });
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.locator('#catalog-status', { hasText: /\S/ }).waitFor();
    await options.waitForTimeout(400);
    console.log('  options status:', await options.locator('#catalog-status').textContent());
    for (const scheme of ['light', 'dark']) {
      await options.emulateMedia({ colorScheme: scheme });
      await options.waitForTimeout(80);
      await options.screenshot({ path: join(out, `options-${scheme}.png`), fullPage: true });
    }
    await options.close();
    console.log('  options');
  }
} finally {
  await context?.close();
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}
