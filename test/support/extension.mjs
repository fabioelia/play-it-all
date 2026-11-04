// Chromium with the built extension, plus the few things the browser tests
// ask of it: the content script's state for a tab (what the popup shows),
// settings, local tags and the debug log.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { explainLaunchError, loadChromium, root } from './browser.mjs';

export const extensionDir = join(root, 'extension/dist/chrome');

/**
 * @param {{ proxy?: string, args?: string[] }} [o] proxy: e.g. process.env.HTTPS_PROXY
 *   (the browser then trusts the proxy's certificates, as test/perf/netflix-real.mjs does)
 */
export async function launchWithExtension({ proxy, args = [] } = {}) {
  const chromium = loadChromium();
  const dir = mkdtempSync(join(tmpdir(), 'cleancut-browser-'));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    ...(proxy ? { proxy: { server: proxy }, ignoreHTTPSErrors: true } : {}),
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--autoplay-policy=no-user-gesture-required',
      ...(proxy ? ['--ignore-certificate-errors'] : []),
      ...args,
    ],
  }).catch(explainLaunchError);
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  await waitFor(() => worker.evaluate(() => chrome.storage.sync.get('settings').then((s) => !!s.settings?.profile)), { what: 'default settings' });
  // The options page opens on install; the page under test should be the only tab.
  for (const p of context.pages()) if (p.url().startsWith('chrome-extension://')) await p.close().catch(() => {});

  const ext = {
    context,
    worker,
    extensionId,
    /** What the popup would show for the tab whose URL matches (content script getState). */
    state: (urlPrefix) => worker.evaluate(async (prefix) => {
      const tab = (await chrome.tabs.query({})).find((t) => (t.url || '').startsWith(prefix));
      if (!tab) return null;
      try {
        return await chrome.tabs.sendMessage(tab.id, { type: 'getState' });
      } catch {
        return null;
      }
    }, urlPrefix),
    /**
     * State of whichever tab plays this title. For pages on sites the extension
     * has no permission for (an embed's host page), tabs.query does not reveal
     * the URL; every tab is asked instead.
     */
    stateOf: (titleKey) => worker.evaluate(async (key) => {
      for (const tab of await chrome.tabs.query({})) {
        const s = await chrome.tabs.sendMessage(tab.id, { type: 'getState' }).catch(() => null);
        if (s?.titleKey === key) return s;
      }
      return null;
    }, titleKey),
    debugLog: (urlPrefix) => worker.evaluate(async (prefix) => {
      const tab = (await chrome.tabs.query({})).find((t) => (t.url || '').startsWith(prefix));
      return tab ? chrome.tabs.sendMessage(tab.id, { type: 'getDebugLog' }).catch((e) => ({ error: String(e) })) : null;
    }, urlPrefix),
    setSettings: (patch) => worker.evaluate(async (p) => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({ settings: { ...settings, ...p, profile: { ...settings.profile, ...(p.profile || {}) } } });
    }, patch),
    /** A tag as if the viewer had made it (Alt+[ … Alt+]) on this title. */
    addLocalTag: (titleKey, title, segment) => worker.evaluate(async ({ titleKey: key, title: t, segment: s }) => {
      const { localTags = {} } = await chrome.storage.local.get('localTags');
      const entry = localTags[key] || { title: t, segments: [] };
      entry.segments.push({ id: `local:test${entry.segments.length}`, source: 'local', createdAt: Date.now(), ...s });
      localTags[key] = entry;
      await chrome.storage.local.set({ localTags });
    }, { titleKey, title, segment }),
    setDebug: (on) => worker.evaluate((v) => chrome.storage.local.set({ debug: v }), on),
    async close() {
      await context.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return ext;
}

export async function waitFor(fn, { timeout = 10_000, interval = 150, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
    } catch {
      last = null;
    }
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A tiny test runner: named steps, a summary, an exit code. */
export function steps() {
  const results = [];
  return {
    results,
    async step(name, fn) {
      const t0 = Date.now();
      try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  ok  ${name} (${Date.now() - t0} ms)`);
      } catch (e) {
        results.push({ name, ok: false, error: e.message });
        console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`);
      }
    },
    summary() {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n${results.length - failed}/${results.length} passed`);
      return failed;
    },
  };
}
