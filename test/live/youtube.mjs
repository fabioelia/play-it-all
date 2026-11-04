// Live check of the YouTube adapter on the real site: the built extension in
// Chromium on a public video with English captions. Shows that the video is
// identified, its captions are found and scanned ahead, the overlay timeline
// renders, a tagged scene is skipped, and nothing happens during an ad.
// Needs network access to www.youtube.com, *.googlevideo.com and *.ytimg.com;
// HTTPS_PROXY is used when set (as in test/perf/netflix-real.mjs).
//
//   npm run test:live:youtube
//   npm run test:live:youtube -- --video eRsGyueVLvQ --tag-at 120
//
// Exit codes: 0 all passed, 1 a check failed, 2 YouTube would not play the
// video to this browser (a consent wall it could not pass, "Sign in to
// confirm you're not a bot", or the video is unavailable here). The script
// accepts YouTube's consent page like a viewer would and goes no further: it
// does not try to get around YouTube's bot checks.
import assert from 'node:assert/strict';

import { launchWithExtension, steps, waitFor } from '../support/extension.mjs';

const opt = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
// Sintel (Blender Foundation open movie): public, subtitled in English.
const VIDEO = opt('video', 'eRsGyueVLvQ');
const TAG_AT = Number(opt('tag-at', 120)); // a 10 s tag from here
const KEY = `youtube:${VIDEO}`;
const WATCH = `https://www.youtube.com/watch?v=${VIDEO}`;

const run = steps();
let ext;
let code = 0;
try {
  ext = await launchWithExtension({ proxy: process.env.HTTPS_PROXY || process.env.https_proxy });
  const { context } = ext;
  await ext.setDebug(true); // the content script's debug log, printed if something fails
  await ext.addLocalTag(KEY, { platform: 'youtube', platformId: VIDEO }, { start: TAG_AT, end: TAG_AT + 10, category: 'violence', severity: 3 });

  const page = await context.newPage();
  console.log(`CleanCut live check: ${WATCH}`);
  await page.goto(WATCH, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // EU consent page: answer it as a viewer would.
  if (/consent\.(youtube|google)\./.test(page.url()) || (await page.locator('ytd-consent-bump-v2-lightbox').count())) {
    const button = page.getByRole('button', { name: /reject all|accept all/i }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await page.waitForURL(/youtube\.com\/watch/, { timeout: 30_000 }).catch(() => {});
      console.log('  (answered the consent page)');
    }
  }
  await page.waitForSelector('#movie_player', { state: 'attached', timeout: 30_000 }).catch(() => {});

  // Does YouTube play this video to this browser at all?
  const playability = await waitFor(() => page.evaluate(() => {
    const pr = document.getElementById('movie_player')?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
    return pr?.playabilityStatus && { status: pr.playabilityStatus.status, reason: pr.playabilityStatus.reason || '' };
  }), { what: 'player response', timeout: 30_000 }).catch(() => (/google\.[a-z.]+\/sorry\//.test(page.url())
    ? { status: 'UNUSUAL_TRAFFIC', reason: 'Google\'s "unusual traffic" page (a CAPTCHA) instead of the video' }
    : { status: 'UNKNOWN', reason: 'no player response' }));
  if (playability.status !== 'OK') {
    console.log(`\nBLOCKED: YouTube will not play this video to this browser: ${playability.status} "${playability.reason}"`);
    console.log(`  page: ${page.url()} · "${await page.title().catch(() => '?')}"`);
    const s = await ext.state('https://www.youtube.com/');
    console.log(`  what CleanCut saw: platform ${s?.platform ?? '(no answer from the content script)'}, video ${s?.hasVideo ? 'found' : 'not found'}, ${s?.ident ? `identified as ${s.titleKey}` : 'not identified'}, page hook ${s?.diag?.hook ? 'connected' : 'not connected'}`);
    const shot = opt('screenshot', '');
    if (shot) await page.screenshot({ path: shot });
    code = 2;
  } else {
    // Muted, so autoplay needs no gesture; CleanCut's own mutes are still visible to the recorder.
    await page.evaluate(() => {
      const v = document.querySelector('#movie_player video');
      window.cleancutEvents = [];
      let last = 0;
      const ad = () => document.getElementById('movie_player').classList.contains('ad-showing');
      v.addEventListener('timeupdate', () => (last = v.currentTime));
      v.addEventListener('seeking', () => window.cleancutEvents.push({ type: 'seek', from: +last.toFixed(2), to: +v.currentTime.toFixed(2), ad: ad() }));
      v.muted = true;
      v.play().catch(() => {});
    });
    const state = () => ext.state('https://www.youtube.com/');
    const adShowing = () => page.evaluate(() => document.getElementById('movie_player').classList.contains('ad-showing'));
    const waitForAdsToEnd = async () => {
      if (!(await adShowing())) return;
      console.log('  (an ad is playing: waiting for it to end)');
      await waitFor(async () => !(await adShowing()), { what: 'the ad to end', timeout: 120_000 });
    };

    await run.step('identifies the video by its id, with title and channel', async () => {
      const s = await waitFor(async () => (await state())?.ident && (await state()), { what: 'identified', timeout: 30_000 });
      assert.equal(s.titleKey, KEY);
      assert.ok(s.ident.meta.name, 'title');
      console.log(`       ${s.title} · ${s.ident.meta.channel || '?'}`);
    });

    await run.step('finds the English captions and scans them ahead', async () => {
      let s = await waitFor(async () => {
        const x = await state();
        return (x?.subtitle || /empty|not a subtitle/.test(x?.diag?.download || '')) && x;
      }, { what: 'caption download', timeout: 30_000 }).catch(() => null);
      if (!s?.subtitle) {
        // The direct download needs a token only the player has: turn captions
        // on once (the "c" shortcut), as CleanCut's toast asks the viewer to.
        console.log(`       direct download: ${s?.diag?.download || 'none'}; turning captions on`);
        await page.locator('#movie_player').focus().catch(() => {});
        await page.keyboard.press('c');
        s = await waitFor(async () => (await state())?.subtitle && (await state()), { what: 'captions scanned', timeout: 30_000 });
      }
      assert.ok(s.subtitle.cues >= 10, `cues: ${s.subtitle.cues}`);
      console.log(`       ${s.subtitle.cues} cues${s.subtitle.sdh ? ' (with sound descriptions)' : ''} · ${s.counts.subtitles} found · download ${s.diag.download}`);
    });

    await run.step('the overlay timeline renders over the video', async () => {
      const box = await page.locator('#movie_player video').boundingBox();
      await page.mouse.move(box.x + 50, box.y + 50);
      await page.mouse.move(box.x + 90, box.y + 70);
      const t = await waitFor(() => page.evaluate(() => {
        const root = document.querySelector('cleancut-overlay')?.shadowRoot;
        const tl = root?.querySelector('.timeline');
        return tl?.classList.contains('show') && { marks: tl.querySelectorAll('.mark').length, width: root.querySelector('.root').style.width };
      }), { what: 'timeline shown' });
      assert.ok(t.marks >= 1, `marks: ${t.marks}`);
      console.log(`       ${t.marks} marks over a ${t.width} video`);
    });

    await run.step(`skips the tagged scene (${TAG_AT}–${TAG_AT + 10} s)`, async () => {
      await waitForAdsToEnd();
      await page.evaluate((t) => {
        window.cleancutEvents.length = 0;
        document.querySelector('#movie_player video').currentTime = t;
      }, TAG_AT - 3);
      const seek = await waitFor(() => page.evaluate((end) => window.cleancutEvents.find((e) => e.to >= end - 0.2 && !e.ad), TAG_AT + 10), { what: 'skip', timeout: 20_000 });
      console.log(`       ${seek.from} → ${seek.to}`);
    });

    await run.step('does nothing while an ad plays', async () => {
      const seeksDuringAds = await page.evaluate(() => window.cleancutEvents.filter((e) => e.ad && e.type === 'seek').length);
      assert.equal(seeksDuringAds, 0, 'CleanCut seeked during a real ad');
      // Then with the player in its ad state (the class YouTube sets) inside the tagged scene.
      await waitForAdsToEnd();
      await page.evaluate((t) => {
        const v = document.querySelector('#movie_player video');
        document.getElementById('movie_player').classList.add('ad-showing');
        window.cleancutEvents.length = 0;
        v.currentTime = t;
      }, TAG_AT - 1);
      await page.waitForTimeout(5000);
      const seeks = await page.evaluate((end) => window.cleancutEvents.filter((e) => e.to >= end - 0.2).length, TAG_AT + 10);
      await page.evaluate(() => document.getElementById('movie_player').classList.remove('ad-showing'));
      assert.equal(seeks, 0, 'skipped while the player was in its ad state');
    });

    if (run.results.some((r) => !r.ok)) {
      const log = await ext.debugLog('https://www.youtube.com/');
      console.log('\nDebug log (last events):');
      for (const e of (log?.events || []).slice(-40)) console.log(`  ${JSON.stringify(e).slice(0, 220)}`);
    }
  }
} catch (e) {
  console.error(e);
  run.results.push({ name: 'setup', ok: false });
} finally {
  await Promise.race([ext?.close(), new Promise((r) => setTimeout(r, 10_000))]);
}
const failed = run.summary();
process.exit(failed ? 1 : code);
