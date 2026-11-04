// The YouTube adapter end to end, offline: the built extension in Chromium on
// www.youtube.com, m.youtube.com-style and youtube-nocookie.com embed pages
// that are fixtures with the structure of the real ones (#movie_player,
// video.html5-main-video, ytd-watch-flexy[video-id], an inline
// ytInitialPlayerResponse with captionTracks, /api/timedtext json3,
// 'yt-navigate-finish' on in-app navigation, .ad-showing during ads).
// The real site: test/live/youtube.mjs.
//
//   npm run test:e2e:youtube
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { ensureDemoVideo, root } from '../support/browser.mjs';
import { launchWithExtension, steps, waitFor } from '../support/extension.mjs';
import { parseSubtitles } from '../../shared/subtitles.js';

const VIDEO = readFileSync(ensureDemoVideo());
const VTT = readFileSync(join(root, 'demo/demo.vtt'), 'utf8');
const ID1 = 'eRsGyueVLvQ';
const ID2 = 'aqz-KE-bpKQ';
const ID3 = 'YE7VzlLtp-4';

// The demo episode's captions as YouTube serves them (json3), and a version
// that needs the token only YouTube's player has (empty without it).
const json3 = JSON.stringify({ wireMagic: 'pb3', events: [{ tStartMs: 0, dDurationMs: 90000, id: 1 }, ...parseSubtitles(VTT).map((c) => ({ tStartMs: Math.round(c.start * 1000), dDurationMs: Math.round((c.end - c.start) * 1000), segs: [{ utf8: c.text }] }))] });
const playerResponse = (id, title, { kind } = {}) => ({
  playabilityStatus: { status: 'OK' },
  videoDetails: { videoId: id, title, author: 'Blender', lengthSeconds: '90', isLiveContent: false },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&caps=asr&signature=1&kind=asr&lang=en${kind ? `&mode=${kind}` : ''}`, name: { simpleText: 'English (auto-generated)' }, vssId: 'a.en', languageCode: 'en', kind: 'asr' },
    { baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&signature=2&lang=en${kind ? `&mode=${kind}` : ''}`, name: { simpleText: 'English' }, vssId: '.en', languageCode: 'en' },
    { baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&signature=3&lang=de`, name: { simpleText: 'German' }, vssId: '.de', languageCode: 'de' },
  ] } },
});

const RECORDER = `<script>
  // What the player did, for the test (like demo/demo.html).
  const events = (window.cleancutEvents = []);
  const hook = () => {
    const v = document.querySelector('#movie_player video');
    if (!v || v.__rec) return;
    v.__rec = true;
    let last = 0;
    v.addEventListener('timeupdate', () => (last = v.currentTime));
    v.addEventListener('seeking', () => events.push({ type: 'seek', from: +last.toFixed(2), to: +v.currentTime.toFixed(2) }));
    v.addEventListener('volumechange', () => events.push({ type: v.muted ? 'muted' : 'unmuted', at: v.currentTime }));
  };
  document.addEventListener('DOMContentLoaded', hook);
</script>`;

function watchPage(id, pr, { shorts = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${pr.videoDetails.title} - YouTube</title>${RECORDER}</head><body>
<ytd-app>
  <ytd-watch-flexy video-id="${id}">
    <div id="player-container"><div id="movie_player" class="html5-video-player ytp-transparent unstarted-mode">
      <div class="html5-video-container"><video class="video-stream html5-main-video" style="width:854px;height:480px" src="/fixture/video.webm" preload="auto"></video></div>
      <div class="ytp-caption-window-container"></div>
    </div></div>
    <ytd-watch-metadata><div id="title"><h1><yt-formatted-string>${pr.videoDetails.title}</yt-formatted-string></h1></div>
      <div id="owner"><ytd-channel-name><a href="/@blender">Blender</a></ytd-channel-name></div></ytd-watch-metadata>
  </ytd-watch-flexy>
  ${shorts ? '<ytd-reel-video-renderer><div id="shorts-player" class="html5-video-player"><video class="html5-main-video" src="/fixture/video.webm"></video></div></ytd-reel-video-renderer>' : ''}
</ytd-app>
<script>var ytInitialPlayerResponse = ${JSON.stringify(pr)};</script>
<script>
  // In-app navigation, as YouTube does it: new address, same player and <video>,
  // the new player response handed to 'yt-navigate-finish'.
  window.ytNavigate = (id, pr) => {
    history.pushState({}, '', '/watch?v=' + id);
    document.querySelector('ytd-watch-flexy').setAttribute('video-id', id);
    document.title = pr.videoDetails.title + ' - YouTube';
    document.dispatchEvent(new CustomEvent('yt-navigate-finish', { bubbles: true, detail: { pageType: 'watch', response: { playerResponse: pr } } }));
  };
  // What the player does when the viewer turns captions on.
  window.ytCaptionsOn = (id) => fetch('/api/timedtext?v=' + id + '&lang=en&fmt=json3&pot=TOKEN&c=WEB').then((r) => r.text());
</script>
</body></html>`;
}

function embedPage(id) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>YouTube</title>${RECORDER}</head><body style="margin:0">
<div id="movie_player" class="html5-video-player ytp-embed">
  <a class="ytp-title-link" href="https://www.youtube.com/watch?v=${id}">Big Buck Bunny (embed)</a>
  <div class="html5-video-container"><video class="video-stream html5-main-video" src="/fixture/video.webm" preload="auto"></video></div>
</div>
<script>
  // An embed fetches its player response (there is none inline).
  fetch('/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: JSON.stringify({ videoId: '${id}' }) });
</script>
</body></html>`;
}

/** Media needs byte ranges to seek. */
function fulfillVideo(route) {
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
  if (!range) return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes' }, body: VIDEO });
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), VIDEO.length - 1) : VIDEO.length - 1;
  return route.fulfill({ status: 206, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${VIDEO.length}` }, body: VIDEO.subarray(start, end + 1) });
}

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const run = steps();
const port = await freePort();
const catalog = spawn(process.execPath, [join(root, 'scripts/dev-server.mjs')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'ignore', 'inherit'] });
let ext;
const timedtextRequests = [];
const playerRequests = [];
try {
  await waitFor(() => fetch(`http://127.0.0.1:${port}/catalog/index.json`).then((r) => r.ok, () => false), { what: 'catalog server' });
  ext = await launchWithExtension();
  const { context } = ext;
  await ext.setSettings({ catalogBase: `http://127.0.0.1:${port}/catalog/` });

  const responses = { [ID1]: playerResponse(ID1, 'Sintel - Open Movie by Blender Foundation'), [ID2]: playerResponse(ID2, 'Big Buck Bunny', { kind: 'pot' }), [ID3]: playerResponse(ID3, 'Embedded film') };
  const handler = async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/fixture/video.webm') return fulfillVideo(route);
    if (u.pathname === '/watch') return route.fulfill({ contentType: 'text/html', body: watchPage(u.searchParams.get('v'), responses[u.searchParams.get('v')]) });
    if (u.pathname.startsWith('/shorts/')) return route.fulfill({ contentType: 'text/html', body: watchPage(ID1, responses[ID1], { shorts: true }).replace(`video-id="${ID1}"`, 'video-id=""') });
    if (u.pathname.startsWith('/embed/')) return route.fulfill({ contentType: 'text/html', body: embedPage(u.pathname.split('/')[2]) });
    if (u.pathname === '/youtubei/v1/player') {
      const id = JSON.parse(req.postData() || '{}').videoId;
      playerRequests.push(id);
      return route.fulfill({ contentType: 'application/json; charset=UTF-8', body: JSON.stringify(responses[id] || {}) });
    }
    if (u.pathname === '/api/timedtext') {
      timedtextRequests.push(u.search);
      const lang = u.searchParams.get('lang');
      // ID2's captions need the player's token, as YouTube now often does.
      const empty = lang !== 'en' || (u.searchParams.get('mode') === 'pot' && !u.searchParams.get('pot')) || (u.searchParams.get('v') === ID2 && !u.searchParams.get('pot'));
      return route.fulfill({ contentType: 'application/json; charset=UTF-8', headers: { 'access-control-allow-origin': '*' }, body: empty ? '' : json3 });
    }
    return route.fulfill({ status: 204, body: '' });
  };
  await context.route('https://www.youtube.com/**', handler);
  await context.route('https://www.youtube-nocookie.com/**', handler);
  await context.route('https://embedder.example/**', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><h1>A blog</h1><iframe width="854" height="480" src="https://www.youtube-nocookie.com/embed/${ID3}" allow="autoplay"></iframe>` }));

  // A tag the viewer made on this video earlier: 0:20–0:30, strong violence.
  await ext.addLocalTag(`youtube:${ID1}`, { platform: 'youtube', platformId: ID1, name: 'Sintel' }, { start: 20, end: 30, category: 'violence', severity: 3 });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const state = () => ext.state('https://www.youtube.com/');
  const events = () => page.evaluate(() => window.cleancutEvents.slice());
  const playFrom = (t) => page.evaluate(async (t) => {
    const v = document.querySelector('#movie_player video');
    window.cleancutEvents.length = 0;
    v.muted = false;
    v.currentTime = t;
    await v.play();
  }, t);
  const autoSeeks = async () => (await events()).filter((e) => e.type === 'seek').slice(1); // [0] is playFrom's own

  console.log('CleanCut YouTube e2e (fixture of the watch page)');
  await page.goto(`https://www.youtube.com/watch?v=${ID1}`);
  await page.waitForFunction(() => document.querySelector('#movie_player video').readyState >= 2);

  await run.step('identifies the video by id, with title and channel from the player data', async () => {
    const s = await waitFor(async () => (await state())?.ident && (await state()), { what: 'identified' });
    assert.equal(s.platform, 'youtube');
    assert.equal(s.titleKey, `youtube:${ID1}`);
    assert.equal(s.ident.meta.name, 'Sintel - Open Movie by Blender Foundation');
    assert.equal(s.ident.meta.channel, 'Blender');
    assert.equal(s.ident.canonicalKey, null, 'an ordinary video is never matched to the catalog by name');
    assert.ok(s.diag.hook, 'page hook connected');
  });

  await run.step('finds the English caption track (manual before automatic) and scans it ahead', async () => {
    const s = await waitFor(async () => (await state())?.subtitle && (await state()), { what: 'subtitles scanned' });
    assert.ok(s.subtitle.cues >= 20, `cues: ${s.subtitle.cues}`);
    assert.ok(s.counts.subtitles >= 1, 'scan-ahead found something');
    assert.match(s.diag.download, /^ok \(json3/);
    const asked = timedtextRequests.filter((q) => q.includes(`v=${ID1}`));
    assert.ok(asked[0].includes('signature=2') && asked[0].includes('fmt=json3'), `first request: ${asked[0]}`);
    assert.ok(!timedtextRequests.some((q) => q.includes('lang=de')), 'no German download');
  });

  await run.step('the overlay timeline renders over the video', async () => {
    await page.mouse.move(400, 300);
    await page.mouse.move(420, 310);
    const t = await waitFor(() => page.evaluate(() => {
      const root = document.querySelector('cleancut-overlay')?.shadowRoot;
      const tl = root?.querySelector('.timeline');
      const box = root?.querySelector('.root');
      // Revealed state lives on the root (it shows the timeline, badge and flag control together).
      return box?.classList.contains('revealed') && box.style.display === 'block' && { marks: tl.querySelectorAll('.mark').length, width: box.style.width, left: box.style.left };
    }), { what: 'timeline shown' });
    assert.ok(t.marks >= 2, `marks: ${t.marks}`);
    assert.equal(t.width, '854px', 'positioned over the video, not the window');
  });

  await run.step('skips a tagged scene (0:20–0:30)', async () => {
    await playFrom(17.5);
    const seek = await waitFor(async () => (await autoSeeks()).find((e) => e.to >= 29.9), { what: 'skip past 0:30' });
    assert.ok(seek.from < 20.5, JSON.stringify(seek));
  });

  await run.step('does nothing while an ad plays (#movie_player.ad-showing), acts again after', async () => {
    await page.evaluate(() => document.getElementById('movie_player').classList.add('ad-showing'));
    await playFrom(17.5);
    await page.waitForTimeout(4500); // through the whole tagged region
    assert.deepEqual(await autoSeeks(), [], 'no skip during the ad');
    await page.evaluate(() => document.getElementById('movie_player').classList.replace('ad-showing', 'ad-interrupting'));
    await playFrom(58.5); // strong language at 1:00
    await page.waitForTimeout(3000);
    assert.ok(!(await events()).some((e) => e.type === 'muted'), 'no mute during the ad');
    await page.evaluate(() => document.getElementById('movie_player').classList.remove('ad-interrupting'));
    await playFrom(17.5);
    await waitFor(async () => (await autoSeeks()).find((e) => e.to >= 29.9), { what: 'skip once the ad is over' });
  });

  await run.step('in-app navigation: new id and title from yt-navigate-finish; asks for CC when the download needs the player\'s token, then reads the player\'s own request', async () => {
    await page.evaluate(({ id, pr }) => window.ytNavigate(id, pr), { id: ID2, pr: responses[ID2] });
    const s = await waitFor(async () => (await state())?.titleKey === `youtube:${ID2}` && (await state()), { what: 'second video identified' });
    assert.equal(s.ident.meta.name, 'Big Buck Bunny');
    await page.locator('cleancut-overlay .toast', { hasText: 'turn on English subtitles' }).waitFor({ timeout: 10_000 });
    assert.equal((await state()).subtitle, null);
    await page.evaluate((id) => window.ytCaptionsOn(id), ID2);
    const after = await waitFor(async () => (await state())?.subtitle && (await state()), { what: 'captions read from the player\'s request' });
    assert.ok(after.subtitle.cues >= 20);
  });

  await run.step('Shorts are left alone (nothing added to the page)', async () => {
    const shorts = await context.newPage();
    await shorts.goto(`https://www.youtube.com/shorts/${ID1}`);
    await shorts.waitForTimeout(2500);
    assert.equal(await shorts.evaluate(() => !!document.querySelector('cleancut-overlay')), false);
    await shorts.close();
  });

  await run.step('a youtube-nocookie embed on another site is identified inside its frame', async () => {
    const blog = await context.newPage();
    await blog.goto('https://embedder.example/post');
    const frame = await waitFor(() => blog.frames().find((f) => f.url().includes('/embed/')), { what: 'embed frame' });
    await frame.waitForFunction(() => document.querySelector('#movie_player video')?.readyState >= 1);
    // The host page's address is hidden from the extension (no permission for it): ask by title.
    const s = await waitFor(() => ext.stateOf(`youtube:${ID3}`), { what: 'embed identified', timeout: 15_000 });
    assert.equal(s.titleKey, `youtube:${ID3}`);
    assert.equal(s.ident.meta.name, 'Embedded film');
    assert.ok(playerRequests.includes(ID3));
    await waitFor(async () => (await ext.stateOf(`youtube:${ID3}`))?.subtitle, { what: 'embed captions scanned' });
    assert.equal(await frame.evaluate(() => !!document.querySelector('cleancut-overlay')), true, 'overlay inside the frame');
    await blog.close();
  });

  await run.step('no page errors', async () => assert.deepEqual(pageErrors, []));
} catch (e) {
  console.error(e);
  run.results.push({ name: 'setup', ok: false });
} finally {
  await ext?.close();
  catalog.kill();
}
process.exit(run.summary() ? 1 : 0);
