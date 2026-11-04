// Every streaming adapter in a real browser, on its site's real watch-page
// address, against a small fixture of the player markup it reads: which
// adapter the host gets, the title id from the address, metadata from the
// player / JSON-LD / document title, the video it picks (never an autoplay
// preview), and ad detection. Offline: every request is answered locally.
//
//   npm run test:adapters
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { ensureDemoVideo, explainLaunchError, loadChromium, root } from '../support/browser.mjs';
import { steps } from '../support/extension.mjs';

const VIDEO = readFileSync(ensureDemoVideo()); // 90 s: long enough for a title, short enough to be a trailer where that matters
const bundle = (await esbuild.build({
  entryPoints: [join(root, 'extension/src/content/adapters.js')],
  bundle: true, format: 'iife', globalName: 'CleanCutAdapters', write: false, target: ['chrome111'],
})).outputFiles[0].text;

// Shadow roots for the players that use web components (Disney+).
const SHADOW_HELPER = `<script>
  function shadowed(host, html) { const root = host.attachShadow({ mode: 'open' }); root.innerHTML = html; return root; }
</script>`;
const video = '<video src="/fixture/video.webm" preload="auto" muted></video>';

const CASES = [
  {
    name: 'Disney+: shadow-DOM player and title bug; ad badge',
    url: 'https://www.disneyplus.com/play/2d8f0a4e-1d8a-4b5e-8e3f-0a1b2c3d4e5f',
    html: `${SHADOW_HELPER}<title>Disney+</title><disney-web-player id="p"></disney-web-player><main-app-controls-overlay id="o"></main-app-controls-overlay><div id="ad"></div>
      <script>
        shadowed(document.getElementById('p'), '${video.replace(/'/g, "\\'")}');
        const bug = shadowed(document.getElementById('o'), '<title-bug id="b"></title-bug>').getElementById('b');
        shadowed(bug, '<div class="title-field">The Mandalorian</div><div class="subtitle-field"><span>S1:E2 Chapter 2: The Child</span></div>');
        window.startAd = () => shadowed(document.getElementById('ad').appendChild(document.createElement('ad-badge-overlay')), '<span class="ad-badge-overlay__content--time-display">0:15</span>');
      </script>`,
    expect: { platform: 'disney', platformId: '2d8f0a4e-1d8a-4b5e-8e3f-0a1b2c3d4e5f', meta: { series: 'The Mandalorian', season: 1, episode: 2, name: 'Chapter 2: The Child' }, canonicalKey: 'the-mandalorian/s01e02', video: true, seeks: true },
    ad: true,
  },
  {
    name: 'Disney+ browse page: an autoplay preview is not the title',
    url: 'https://www.disneyplus.com/browse/entity-2d8f0a4e-1d8a-4b5e-8e3f-0a1b2c3d4e5f',
    html: `<title>Disney+</title>${video}`,
    expect: { platform: 'disney', identify: null, video: false },
  },
  {
    name: 'HBO Max: player-ux test ids; seeking covered (mute + hide)',
    url: 'https://play.hbomax.com/video/watch/1f7a7d2b-2c3d-4e5f-8a9b-0c1d2e3f4a5b/3c0f1b5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
    html: `<title>HBO Max</title>${video}<div data-testid="player-ux-asset-title">The Last of Us</div><div data-testid="player-ux-season-episode">S1 E3</div><div data-testid="player-ux-asset-subtitle">Long, Long Time</div><div id="slot"></div>
      <script>window.startAd = () => { document.getElementById('slot').innerHTML = '<span data-testid="player-ux-ad-badge">Ad 1 of 2</span>'; };</script>`,
    expect: { platform: 'max', platformId: '1f7a7d2b-2c3d-4e5f-8a9b-0c1d2e3f4a5b', meta: { series: 'The Last of Us', season: 1, episode: 3, name: 'Long, Long Time' }, video: true, seeks: false },
    ad: true,
  },
  {
    name: 'Hulu: PlayerMetadata title and subtitle',
    url: 'https://www.hulu.com/watch/7f0c2a43-5c0e-4d9e-9a3c-2b1f8e0d6a11',
    html: `<title>Watch The Bear - Hulu</title>${video}<div class="PlayerMetadata__titleText">The Bear</div><div class="PlayerMetadata__subTitle">S2 E7 - Forks</div>`,
    expect: { platform: 'hulu', platformId: '7f0c2a43-5c0e-4d9e-9a3c-2b1f8e0d6a11', meta: { series: 'The Bear', season: 2, episode: 7, name: 'Forks' }, video: true, seeks: false },
  },
  {
    name: 'Apple TV: the movie page\'s trailer (under 5 min) is not the movie; name from the document title',
    url: 'https://tv.apple.com/us/movie/interstellar/umc.cmc.1vrwat5k1ucm5k42q97ioqyq3',
    html: `<title>Interstellar - Apple TV</title>${video}`,
    expect: { platform: 'appletv', platformId: 'umc.cmc.1vrwat5k1ucm5k42q97ioqyq3', meta: { name: 'Interstellar' }, video: false },
  },
  {
    name: 'Paramount+: id from /shows/video/<id>; ad countdown',
    url: 'https://www.paramountplus.com/shows/video/x6mVfBkzhQnVAbSc_X3bWyWkgCK8lsoh/',
    html: `<title>Star Trek: Strange New Worlds - S1 E1 - Strange New Worlds | Paramount Plus</title>${video}<div id="slot"></div>
      <script>window.startAd = () => { document.getElementById('slot').innerHTML = '<div class="ad-info-manager-circular-loader-copy">30</div>'; };</script>`,
    expect: { platform: 'paramount', platformId: 'x6mVfBkzhQnVAbSc_X3bWyWkgCK8lsoh', video: true, seeks: true },
    ad: true,
  },
  {
    name: 'Peacock: playback header',
    url: 'https://www.peacocktv.com/watch/playback/vod/GMO_00000000224510_02_HDSDR/e0d1fe74-6f5c-3c1a-9a7e-6b5c0d4e3f21',
    html: `<title>Peacock</title>${video}<div class="playback-header__title">The Office</div><div class="playback-header__subtitle">S2 E1 The Dundies</div>`,
    expect: { platform: 'peacock', platformId: 'GMO_00000000224510_02_HDSDR', meta: { series: 'The Office', season: 2, episode: 1, name: 'The Dundies' }, canonicalKey: 'the-office/s02e01', video: true, seeks: false },
  },
  {
    name: 'Crunchyroll: episode from the page\'s JSON-LD',
    url: 'https://www.crunchyroll.com/watch/G4VUQ1ZKW/cruelty',
    html: `<title>Cruelty - Demon Slayer - Watch on Crunchyroll</title>${video}
      <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'TVEpisode', url: 'https://www.crunchyroll.com/watch/G4VUQ1ZKW/cruelty', name: 'Cruelty', episodeNumber: 1, partOfSeason: { '@type': 'TVSeason', seasonNumber: 1 }, partOfSeries: { '@type': 'TVSeries', name: 'Demon Slayer: Kimetsu no Yaiba' } })}</script>`,
    expect: { platform: 'crunchyroll', platformId: 'G4VUQ1ZKW', meta: { type: 'episode', series: 'Demon Slayer: Kimetsu no Yaiba', season: 1, episode: 1, name: 'Cruelty' }, canonicalKey: 'demon-slayer-kimetsu-no-yaiba/s01e01', video: true, seeks: false },
  },
  {
    name: 'Tubi: film from JSON-LD (as tubitv.com publishes it); a 90 s preview is not the film',
    url: 'https://tubitv.com/movies/594084/i-am-legend',
    html: `<title>Watch I Am Legend (2007) - Free Movies | Tubi</title>${video}
      <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', url: 'https://tubitv.com/movies/594084/i-am-legend', name: 'I Am Legend (2007)' }, { '@type': 'Movie', '@id': 'https://tubitv.com/movies/594084/i-am-legend#video', name: 'I Am Legend', url: 'https://tubitv.com/movies/594084/i-am-legend', dateCreated: '2007-12-14' }] })}</script>`,
    expect: { platform: 'tubi', platformId: '594084', meta: { type: 'movie', name: 'I Am Legend', year: 2007 }, canonicalKey: 'i-am-legend-2007', video: false },
  },
  {
    name: 'Pluto TV: on-demand episode from the address; live TV ignored',
    url: 'https://pluto.tv/us/on-demand/series/hells-kitchen/season/3/episode/hells-kitchen-3-1',
    html: `<title>Watch Hell's Kitchen S3 E1 | Pluto TV</title>${video}`,
    expect: { platform: 'pluto', platformId: 'hells-kitchen/3/hells-kitchen-3-1', meta: { series: "Hell's Kitchen", season: 3, episode: 1 }, video: false },
  },
  {
    name: 'The Roku Channel: /watch/<id>',
    url: 'https://therokuchannel.roku.com/watch/4a14dcd7c845df1ca6cb4b792cb77ae0',
    html: `<title>Zoey's Extraordinary Christmas | The Roku Channel</title>${video}`,
    expect: { platform: 'roku', platformId: '4a14dcd7c845df1ca6cb4b792cb77ae0', meta: { name: "Zoey's Extraordinary Christmas" }, video: true, seeks: false },
  },
  {
    name: 'Plex: library item from the hash route',
    url: 'https://app.plex.tv/desktop/#!/server/0123456789abcdef0123456789abcdef01234567/details?key=%2Flibrary%2Fmetadata%2F4242',
    html: `<title>Plex</title>${video}`,
    expect: { platform: 'plex', platformId: '0123456789ab:4242', video: true, seeks: false },
  },
  {
    name: 'Vimeo embed: player.vimeo.com fills its frame',
    url: 'https://player.vimeo.com/video/76979871?h=8272103f6e',
    html: `<title>The New Vimeo Player on Vimeo</title><div class="vp-video-wrapper"><div class="vp-video"><div class="vp-telecine">${video}</div></div></div><div class="vp-title"><a>The New Vimeo Player (You Know, For Videos)</a></div>`,
    expect: { platform: 'vimeo', platformId: '76979871', meta: { name: 'The New Vimeo Player (You Know, For Videos)' }, video: true, seeks: true, fillsViewport: true },
  },
  {
    name: 'YouTube home page: no video id, nothing taken',
    url: 'https://www.youtube.com/',
    html: `<title>YouTube</title><div id="movie_player" class="html5-video-player">${video.replace('<video', '<video class="html5-main-video"')}</div>`,
    expect: { platform: 'youtube', identify: null, video: false },
  },
  {
    name: 'any other site: the generic adapter',
    url: 'https://videos.example.org/clip/1',
    html: `<title>A clip</title>${video}`,
    expect: { platform: 'web', video: true, seeks: true },
  },
];

const run = steps();
let browser;
try {
  browser = await loadChromium().launch({ channel: 'chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] }).catch(explainLaunchError);
  const context = await browser.newContext();
  let html = '';
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/fixture/video.webm') return route.fulfill({ status: 200, contentType: 'video/webm', body: VIDEO });
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>` });
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await context.newPage();
  console.log('CleanCut adapters (fixtures at each site\'s real addresses)');
  for (const c of CASES) {
    await run.step(c.name, async () => {
      html = c.html;
      await page.goto(c.url);
      await page.addScriptTag({ content: bundle });
      if (c.html.includes('<video')) await page.waitForFunction(() => [...document.querySelectorAll('video'), ...[...document.querySelectorAll('*')].flatMap((e) => (e.shadowRoot ? [...e.shadowRoot.querySelectorAll('video')] : []))].some((v) => v.readyState >= 1));
      const got = await page.evaluate(() => {
        const a = window.CleanCutAdapters.detectAdapter({ seek: async () => false });
        const ident = a.identify();
        return { platform: a.platform, ident, video: !!a.findVideo(), ad: a.isAdPlaying ? a.isAdPlaying() : null, fillsViewport: !!a.fillsViewport, seekType: String(a.seek).includes('currentTime') };
      });
      const e = c.expect;
      assert.equal(got.platform, e.platform);
      if ('identify' in e) assert.equal(got.ident, e.identify);
      if (e.platformId) assert.equal(got.ident?.platformId, e.platformId);
      if (e.meta) for (const [k, v] of Object.entries(e.meta)) assert.equal(got.ident?.meta?.[k], v, `meta.${k}`);
      if (e.canonicalKey) assert.equal(got.ident?.canonicalKey, e.canonicalKey);
      assert.equal(got.video, e.video, 'findVideo');
      if ('seeks' in e) assert.equal(got.seekType, e.seeks, 'seeks by currentTime');
      if ('fillsViewport' in e) assert.equal(got.fillsViewport, e.fillsViewport);
      if (c.ad) {
        assert.equal(got.ad, false, 'no ad yet');
        const during = await page.evaluate(() => {
          window.startAd();
          return window.CleanCutAdapters.detectAdapter({}).isAdPlaying();
        });
        assert.equal(during, true, 'ad detected');
      }
    });
  }
} catch (e) {
  console.error(e);
  run.results.push({ name: 'setup', ok: false });
} finally {
  await browser?.close();
}
process.exit(run.summary() ? 1 : 0);
