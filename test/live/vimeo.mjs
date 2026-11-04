// Live check of the Vimeo adapter on the real embedded player
// (player.vimeo.com in an iframe on another site, the way most viewers meet
// Vimeo). Needs network access to player.vimeo.com, *.vimeocdn.com and
// captions.vimeo.com; HTTPS_PROXY is used when set.
//
//   npm run test:live:vimeo
//   npm run test:live:vimeo -- --video 76979871     a public video with English subtitles
//
// vimeo.com's own pages may answer a headless browser with a "Verify to
// continue" check; this script does not try to get past it and uses the embed.
import assert from 'node:assert/strict';

import { launchWithExtension, steps, waitFor } from '../support/extension.mjs';

const opt = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const VIDEO = opt('video', '76979871'); // "The New Vimeo Player (You Know, For Videos)": 62 s, English subtitles
const KEY = `vimeo:${VIDEO}`;

const run = steps();
let ext;
try {
  ext = await launchWithExtension({ proxy: process.env.HTTPS_PROXY || process.env.https_proxy });
  const { context } = ext;
  await context.route('https://embedder.example/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>A blog</title><h1>A blog post with a video</h1>
      <iframe src="https://player.vimeo.com/video/${VIDEO}" width="854" height="480" allow="autoplay; fullscreen" style="border:0"></iframe>`,
  }));
  // A tag the viewer made earlier: 0:20–0:30.
  await ext.addLocalTag(KEY, { platform: 'vimeo', platformId: VIDEO }, { start: 20, end: 30, category: 'violence', severity: 3 });

  const page = await context.newPage();
  console.log(`CleanCut live check: Vimeo embed ${VIDEO}`);
  await page.goto('https://embedder.example/post', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const frame = await waitFor(() => page.frames().find((f) => f.url().startsWith('https://player.vimeo.com/video/')), { what: 'player frame', timeout: 30_000 });
  await frame.waitForSelector('video', { state: 'attached', timeout: 30_000 });
  // Record what the player does (seeks), from inside its frame.
  await frame.evaluate(() => {
    const v = document.querySelector('video');
    window.cleancutEvents = [];
    let last = 0;
    v.addEventListener('timeupdate', () => (last = v.currentTime));
    v.addEventListener('seeking', () => window.cleancutEvents.push({ type: 'seek', from: +last.toFixed(2), to: +v.currentTime.toFixed(2) }));
  });
  // Start playback the way a viewer does (the player loads its media on the
  // first click), then jump with the media element as the test needs.
  const playButton = frame.locator('button.play, [data-play-button], .vp-controls button[aria-label*="Play" i]').first();
  if (await playButton.isVisible().catch(() => false)) await playButton.click();
  else await page.locator('iframe').click();
  // Vimeo serves H.264 only, which Playwright's open-source Chromium cannot
  // decode ("Unable to play video"): then identification, scan-ahead and the
  // overlay are still checked, and skipping is reported as not testable here.
  const playable = await frame.waitForFunction(() => document.querySelector('video').readyState >= 2, null, { timeout: 20_000 }).then(() => true, () => false);
  if (!playable) console.log(`  (the player says: ${await frame.locator('.vp-title, [class*="error"]').first().textContent().catch(() => '?')}; this browser cannot decode the video)`);
  const play = (t) => frame.evaluate(async (t) => {
    const v = document.querySelector('video');
    if (t != null) v.currentTime = t;
    if (v.paused) await Promise.race([v.play(), new Promise((r) => setTimeout(r, 3000))]);
    window.cleancutEvents.length = 0;
  }, t);
  const state = () => ext.stateOf(KEY);

  await run.step('identifies the video (id from the address, title and owner from the player config)', async () => {
    const s = await waitFor(state, { what: 'identified', timeout: 20_000 });
    assert.equal(s.platform, 'vimeo');
    assert.ok(s.ident.meta.name, 'has a title');
    console.log(`       ${s.title} · ${s.ident.meta.channel || ''}`);
  });

  await run.step('finds the English subtitle track and scans it ahead', async () => {
    const s = await waitFor(async () => (await state())?.subtitle && (await state()), { what: 'subtitles scanned', timeout: 30_000 });
    assert.ok(s.subtitle.cues >= 5, `cues: ${s.subtitle.cues}`);
    console.log(`       ${s.subtitle.cues} cues · download ${s.diag.download}`);
  });

  await run.step('the overlay renders over the player, with the tag on its timeline', async () => {
    const box = await frame.locator('video').boundingBox();
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.move(box.x + 140, box.y + 120);
    const t = await waitFor(() => frame.evaluate(() => {
      const tl = document.querySelector('cleancut-overlay')?.shadowRoot?.querySelector('.timeline');
      return tl?.classList.contains('show') && tl.querySelectorAll('.mark').length;
    }), { what: 'timeline shown' });
    assert.ok(t >= 1);
  });

  if (!playable) console.log('  skip  skips the tagged scene: not testable in a browser without H.264 (run with a Chrome build that has it)');
  else await run.step('skips the tagged scene (0:20–0:30)', async () => {
    await play(17);
    const seek = await waitFor(() => frame.evaluate(() => window.cleancutEvents.find((e) => e.type === 'seek' && e.to >= 29.9)), { what: 'skip past 0:30', timeout: 15_000 });
    assert.ok(seek.from < 21, JSON.stringify(seek));
  });
} catch (e) {
  console.error(e);
  run.results.push({ name: 'setup', ok: false });
} finally {
  await Promise.race([ext?.close(), new Promise((r) => setTimeout(r, 10_000))]);
}
process.exit(run.summary() ? 1 : 0);
