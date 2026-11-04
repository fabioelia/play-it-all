// Screenshots of the on-player UI (badge, flag control, picker, toasts,
// timeline) as a viewer sees it: on the demo page, and on copies of Netflix's,
// Prime Video's and YouTube's watch pages with their own controls drawn where
// those sites put them, over a bright and a dark frame, windowed and in
// fullscreen. The sites' pages are served at their real addresses (routed
// locally), so the built extension runs its real adapters on them.
//
//   npm run build && node test/e2e/player-screenshots.mjs [outDir]   (default docs)
//   writes outDir/flagging/*.png, outDir/youtube/*.png and outDir/overlay.png
//   (the README's); ONLY=<regex> picks shots (demo, overlay, netflix, prime, youtube)
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ensureDemoVideo, root } from '../support/browser.mjs';
import { launchWithExtension, waitFor } from '../support/extension.mjs';

const out = resolve(process.argv[2] || join(root, 'docs'));
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const want = (name) => !only || only.test(name);
for (const d of ['flagging', 'youtube']) mkdirSync(join(out, d), { recursive: true });
const VIDEO = readFileSync(ensureDemoVideo());
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://localhost:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), 'cleancut-player-'));
cpSync(join(root, 'catalog'), join(tmp, 'catalog'), { recursive: true });
const server = spawn(process.execPath, [join(root, 'scripts/dev-server.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CATALOG_DIR: join(tmp, 'catalog') },
  stdio: ['ignore', 'ignore', 'inherit'],
});

// ---- frames and icons ----------------------------------------------------------------------
// A bright frame (a sunlit sky: the hardest case for light text) and a dark one
// (a night scene, as in a dark room), laid over the video like a picture.
const FRAMES = {
  bright: 'radial-gradient(ellipse at 72% 28%, #ffffff 0%, #eef6ff 30%, #cfe3f8 62%, #a9c8e8 100%)',
  dark: 'radial-gradient(ellipse at 30% 20%, #26324f 0%, #182238 45%, #0b0f19 100%)',
};
const icon = (d, { size = 32, fill = false } = {}) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  back: '<path d="M20 12H5M11 5l-7 7 7 7"/>',
  flag: '<path d="M6 21V4h11l-2.5 4.5L17 13H6"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor"/>',
  pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor" stroke="none"/>',
  rew: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui">10</text>',
  fwd: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui">10</text>',
  vol: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/>',
  next: '<path d="M5 4l11 8-11 8z" fill="currentColor"/><path d="M19 4v16"/>',
  episodes: '<rect x="3" y="7" width="14" height="13" rx="1"/><path d="M7 4h14v13"/>',
  cc: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M7 12h4M13 12h4M7 15h7"/>',
  speed: '<circle cx="12" cy="13" r="8"/><path d="M12 13l3-4M10 2h4"/>',
  full: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  mini: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="12" width="7" height="5" fill="currentColor" stroke="none"/>',
  theater: '<rect x="2" y="7" width="20" height="10" rx="1.5"/>',
};
const SUBTITLE = 'I told you we’d make it out of here.';

// ---- Netflix -------------------------------------------------------------------------------
// The watch page: back arrow top left, "report a problem" flag top right, the
// scrubber and a row of buttons along the bottom, captions above them.
function netflixPage(frame) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Netflix</title><style>
  body { margin: 0; background: #000; overflow: hidden; font-family: system-ui, sans-serif; color: #fff; }
  .watch-video { position: relative; width: 100vw; height: 100vh; }
  video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .frame { position: absolute; inset: 0; background: ${FRAMES[frame]}; }
  .player-timedtext { position: absolute; left: 0; right: 0; bottom: 19%; text-align: center; font-size: 30px; font-weight: 500; text-shadow: 0 0 6px #000, 0 2px 2px #000; }
  .chrome { position: absolute; inset: 0; opacity: 0; transition: opacity .2s; }
  .chrome.show { opacity: 1; }
  .top { position: absolute; left: 0; right: 0; top: 0; height: 120px; background: linear-gradient(rgba(0,0,0,.55), transparent); }
  .bottom { position: absolute; left: 0; right: 0; bottom: 0; height: 170px; background: linear-gradient(transparent, rgba(0,0,0,.75)); }
  .ico { position: absolute; display: grid; place-items: center; width: 44px; height: 44px; }
  .scrub { position: absolute; left: 32px; right: 100px; bottom: 90px; height: 4px; background: rgba(255,255,255,.35); }
  .scrub .fill { position: absolute; inset: 0 58% 0 0; background: #e50914; }
  .scrub .knob { position: absolute; left: 42%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; background: #e50914; }
  .remaining { position: absolute; right: 32px; bottom: 82px; font-size: 15px; }
  .row { position: absolute; left: 24px; right: 24px; bottom: 22px; height: 44px; display: flex; align-items: center; gap: 18px; }
  .row .spacer { flex: 1; }
  [data-uia="video-title"] { position: absolute; left: 0; right: 0; bottom: 33px; text-align: center; font-size: 17px; }
  [data-uia="video-title"] h4 { display: inline; margin: 0 6px 0 0; font-size: 17px; }
  [data-uia="video-title"] span { color: #ddd; margin-left: 4px; }
  .watch-video:fullscreen { width: 100vw; height: 100vh; }
</style></head><body>
<div class="watch-video" id="player">
  <video id="v" src="/fixture/video.webm" autoplay muted playsinline></video>
  <div class="frame"></div>
  <div class="player-timedtext">${SUBTITLE}</div>
  <div class="chrome" id="chrome">
    <div class="top"></div><div class="bottom"></div>
    <div class="ico" style="left:16px;top:16px">${icon(I.back)}</div>
    <div class="ico" title="Report a problem" style="right:16px;top:16px">${icon(I.flag)}</div>
    <div class="scrub"><div class="fill"></div><div class="knob"></div></div>
    <div class="remaining">38:12</div>
    <div class="row">${[I.pause, I.rew, I.fwd, I.vol].map((d) => icon(d, { size: 34 })).join('')}<span class="spacer"></span>${[I.next, I.episodes, I.cc, I.speed, I.full].map((d) => icon(d, { size: 34 })).join('')}</div>
    <div data-uia="video-title"><h4>Simulated Show</h4><span>S1:E1</span><span>Pilot</span></div>
  </div>
</div>
<script>
  const v = document.getElementById('v');
  const chrome_ = document.getElementById('chrome');
  let hide = 0;
  // Like Netflix: the controls come up on mouse movement and go after 3 s.
  window.showControls = (on = true) => { chrome_.classList.toggle('show', on); clearTimeout(hide); if (on) hide = setTimeout(() => chrome_.classList.remove('show'), 3000); };
  document.addEventListener('mousemove', () => showControls(true));
  // The player API CleanCut seeks through on Netflix.
  window.netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
    getAllPlayerSessionIds: () => ['watch-1'],
    getVideoPlayerBySessionId: () => ({ seek: (ms) => { v.currentTime = ms / 1000; } }),
  } }) } } } };
</script></body></html>`;
}

// ---- Prime Video ----------------------------------------------------------------------------
// Prime's player keeps its main buttons in the top right corner (subtitles,
// settings, fullscreen, close) and the title centred along the top.
function primePage(frame) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Prime Video: Simulated Show</title><style>
  body { margin: 0; background: #000; overflow: hidden; font-family: system-ui, sans-serif; color: #fff; }
  .webPlayerSDKContainer { position: relative; width: 100vw; height: 100vh; }
  video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .frame { position: absolute; inset: 0; background: ${FRAMES[frame]}; }
  .atvwebplayersdk-captions-overlay { position: absolute; left: 0; right: 0; bottom: 17%; text-align: center; font-size: 28px; }
  .atvwebplayersdk-captions-overlay span { background: rgba(0,0,0,.75); padding: 2px 8px; }
  .chrome { position: absolute; inset: 0; opacity: 0; transition: opacity .2s; }
  .chrome.show { opacity: 1; }
  .shade { position: absolute; inset: 0; background: linear-gradient(rgba(0,0,0,.6), transparent 22%, transparent 70%, rgba(0,0,0,.7)); }
  .titles { position: absolute; left: 0; right: 0; top: 22px; text-align: center; }
  .atvwebplayersdk-title-text { font-size: 22px; font-weight: 700; }
  .atvwebplayersdk-subtitle-text { font-size: 15px; color: #ccc; margin-top: 4px; }
  .tr { position: absolute; right: 20px; top: 20px; display: flex; gap: 14px; }
  .mid { position: absolute; left: 50%; bottom: 86px; transform: translateX(-50%); display: flex; gap: 40px; }
  .seek { position: absolute; left: 32px; right: 32px; bottom: 56px; height: 4px; background: rgba(255,255,255,.3); }
  .seek div { position: absolute; inset: 0 60% 0 0; background: #1a98ff; }
  .atvwebplayersdk-timeindicator-text { position: absolute; left: 32px; bottom: 24px; font-size: 14px; }
</style></head><body>
<div class="webPlayerSDKContainer" id="player">
  <video id="v" src="/fixture/video.webm" autoplay muted playsinline></video>
  <div class="frame"></div>
  <div class="atvwebplayersdk-captions-overlay"><span>${SUBTITLE}</span></div>
  <div class="chrome" id="chrome">
    <div class="shade"></div>
    <div class="titles"><div class="atvwebplayersdk-title-text">Simulated Show</div><div class="atvwebplayersdk-subtitle-text">Season 1, Ep. 1 Pilot</div></div>
    <div class="tr">${[I.cc, I.gear, I.vol, I.full, I.close].map((d) => icon(d, { size: 30 })).join('')}</div>
    <div class="mid">${[I.rew, I.pause, I.fwd].map((d) => icon(d, { size: 40 })).join('')}</div>
    <div class="seek"><div></div></div>
    <div class="atvwebplayersdk-timeindicator-text" id="clock">0:00 / 1:30</div>
  </div>
</div>
<script>
  const v = document.getElementById('v');
  const chrome_ = document.getElementById('chrome');
  const fmt = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  v.addEventListener('timeupdate', () => { document.getElementById('clock').textContent = fmt(v.currentTime) + ' / ' + fmt(v.duration || 90); });
  let hide = 0;
  window.showControls = (on = true) => { chrome_.classList.toggle('show', on); clearTimeout(hide); if (on) hide = setTimeout(() => chrome_.classList.remove('show'), 3000); };
  document.addEventListener('mousemove', () => showControls(true));
</script></body></html>`;
}

// ---- YouTube --------------------------------------------------------------------------------
// The watch page in its default and theater layouts (fullscreen is the
// player's own button): the player's bottom bar with a chaptered progress bar,
// and the ad UI ("Sponsored", the countdown, Skip) while .ad-showing.
const YT_ID = 'eRsGyueVLvQ';
const ytPlayerResponse = {
  playabilityStatus: { status: 'OK' },
  videoDetails: { videoId: YT_ID, title: 'Sintel - Open Movie by Blender Foundation', author: 'Blender', lengthSeconds: '90', isLiveContent: false },
};
function youtubePage(frame, view) {
  const theater = view === 'theater';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${ytPlayerResponse.videoDetails.title} - YouTube</title><style>
  body { margin: 0; background: #0f0f0f; color: #f1f1f1; font-family: Roboto, Arial, system-ui, sans-serif; }
  #masthead { height: 56px; display: flex; align-items: center; padding: 0 16px; gap: 16px; }
  #masthead .logo { font-weight: 700; font-size: 18px; } #masthead .search { margin: 0 auto; width: 480px; height: 38px; border: 1px solid #303030; border-radius: 20px; }
  ytd-watch-flexy { display: block; padding: ${theater ? '0' : '24px 24px 0'}; }
  .columns { display: flex; gap: 24px; }
  #player-container { position: relative; flex: none; width: ${theater ? '100vw' : '854px'}; height: ${theater ? 'min(56.25vw, calc(100vh - 169px))' : '480px'}; background: #000; ${theater ? '' : 'border-radius: 12px; overflow: hidden;'} }
  #movie_player { position: absolute; inset: 0; overflow: hidden; }
  .html5-video-container { position: absolute; inset: 0; }
  video.html5-main-video { position: absolute; object-fit: fill; }
  .frame { position: absolute; background: ${FRAMES[frame]}; pointer-events: none; }
  .ytp-caption-window-container { position: absolute; left: 0; right: 0; bottom: 64px; text-align: center; }
  .ytp-caption-window-container span { background: rgba(8,8,8,.75); font-size: 20px; padding: 2px 6px; }
  .ytp-chrome-bottom { position: absolute; left: 12px; right: 12px; bottom: 0; height: 52px; opacity: 0; transition: opacity .1s; }
  .ytp-gradient-bottom { position: absolute; left: 0; right: 0; bottom: 0; height: 120px; background: linear-gradient(transparent, rgba(0,0,0,.65)); opacity: 0; }
  #movie_player.show .ytp-chrome-bottom, #movie_player.show .ytp-gradient-bottom, #movie_player.show .ytp-chrome-top { opacity: 1; }
  .ytp-progress-bar { position: absolute; left: 0; right: 0; top: 0; height: 3px; display: flex; gap: 2px; }
  .ytp-progress-bar .ch { height: 100%; background: rgba(255,255,255,.3); position: relative; }
  .ytp-progress-bar .ch .play { position: absolute; inset: 0 auto 0 0; background: #f00; }
  .ytp-scrubber { position: absolute; top: -5px; width: 13px; height: 13px; border-radius: 50%; background: #f00; }
  .ytp-controls { position: absolute; left: 0; right: 0; bottom: 0; height: 48px; display: flex; align-items: center; gap: 14px; font-size: 13px; }
  .ytp-controls .spacer { flex: 1; }
  .ytp-autonav { width: 36px; height: 14px; border-radius: 7px; background: rgba(255,255,255,.3); position: relative; }
  .ytp-autonav::after { content: ''; position: absolute; left: 0; top: -3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; }
  .ytp-chrome-top { position: absolute; left: 12px; right: 12px; top: 10px; display: none; align-items: center; gap: 10px; font-size: 18px; opacity: 0; }
  .ytp-chrome-top .avatar { width: 36px; height: 36px; border-radius: 50%; background: #e8b04a; }
  #movie_player.fs .ytp-chrome-top { display: flex; }
  /* ads */
  .ytp-ad-module { display: none; }
  #movie_player.ad-showing .ytp-ad-module { display: block; }
  #movie_player.ad-showing .ytp-progress-bar .ch .play, #movie_player.ad-showing .ytp-scrubber { background: #fc0; }
  .ytp-ad-badge { position: absolute; left: 12px; bottom: 60px; display: flex; gap: 8px; align-items: center; font-size: 13px; }
  .ytp-ad-badge b { background: #fc0; color: #000; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .ytp-ad-visit { position: absolute; left: 12px; bottom: 90px; padding: 8px 14px; border-radius: 18px; background: rgba(0,0,0,.6); font-size: 13px; }
  .ytp-ad-skip-button { position: absolute; right: 0; bottom: 70px; padding: 10px 18px; background: rgba(0,0,0,.7); border: 1px solid rgba(255,255,255,.5); border-right: 0; font-size: 15px; }
  .meta { padding: 12px 0; } .meta h1 { font-size: 20px; margin: 0 0 8px; }
  #secondary { flex: 1; display: grid; gap: 8px; } #secondary div { height: 94px; border-radius: 8px; background: #272727; }
  ytd-app:fullscreen #player-container { position: fixed; inset: 0; width: 100vw; height: 100vh; border-radius: 0; z-index: 10; }
</style></head><body>
<ytd-app>
  <div id="masthead"><span class="logo">YouTube</span><span class="search"></span></div>
  <ytd-watch-flexy video-id="${YT_ID}" ${theater ? 'theater' : ''}>
    <div class="columns">
      <div>
        <div id="player-container"><div id="movie_player" class="html5-video-player">
          <div class="html5-video-container"><video class="video-stream html5-main-video" src="/fixture/video.webm" autoplay muted playsinline></video><div class="frame"></div></div>
          <div class="ytp-caption-window-container"><span>${SUBTITLE}</span></div>
          <div class="ytp-ad-module"><div class="ytp-ad-visit">Visit advertiser</div><div class="ytp-ad-badge"><b>Sponsored</b> 1 of 2 · 0:05</div><div class="ytp-ad-skip-button">Skip ▸</div></div>
          <div class="ytp-gradient-bottom"></div>
          <div class="ytp-chrome-top"><span class="avatar"></span>${ytPlayerResponse.videoDetails.title}</div>
          <div class="ytp-chrome-bottom">
            <div class="ytp-progress-bar"><div class="ch" style="width:22%"><div class="play" style="width:100%"></div></div><div class="ch" style="width:30%"><div class="play" style="width:55%"></div></div><div class="ch" style="width:28%"></div><div class="ch" style="flex:1"></div><span class="ytp-scrubber" style="left:38%"></span></div>
            <div class="ytp-controls">${[I.pause, I.next, I.vol].map((d) => icon(d, { size: 24 })).join('')}<span>0:33 / 1:30 · The dragon ›</span><span class="spacer"></span><span class="ytp-autonav"></span>${[I.cc, I.gear, I.mini, I.theater, I.full].map((d) => icon(d, { size: 24 })).join('')}</div>
          </div>
        </div></div>
        ${theater ? '' : `<div class="meta"><h1>${ytPlayerResponse.videoDetails.title}</h1><div>Blender · 1.2M subscribers</div></div>`}
      </div>
      ${theater ? '' : '<div id="secondary"><div></div><div></div><div></div><div></div></div>'}
    </div>
  </ytd-watch-flexy>
</ytd-app>
<script>var ytInitialPlayerResponse = ${JSON.stringify(ytPlayerResponse)};</script>
<script>
  const mp = document.getElementById('movie_player');
  const v = mp.querySelector('video');
  const frame = mp.querySelector('.frame');
  // YouTube sizes the <video> to the picture inside the player, letterboxed.
  function layout() {
    const box = document.getElementById('player-container').getBoundingClientRect();
    const w = Math.min(box.width, box.height * 16 / 9);
    const h = w * 9 / 16;
    const s = { width: w + 'px', height: h + 'px', left: (box.width - w) / 2 + 'px', top: (box.height - h) / 2 + 'px' };
    Object.assign(v.style, s);
    Object.assign(frame.style, s);
    mp.classList.toggle('fs', !!document.fullscreenElement);
  }
  layout();
  addEventListener('resize', layout);
  document.addEventListener('fullscreenchange', () => requestAnimationFrame(layout));
  let hide = 0;
  window.showControls = (on = true) => { mp.classList.toggle('show', on); clearTimeout(hide); if (on) hide = setTimeout(() => mp.classList.remove('show'), 3000); };
  mp.addEventListener('mousemove', () => showControls(true));
  window.fullscreen = () => document.querySelector('ytd-app').requestFullscreen();
</script></body></html>`;
}

function fulfillVideo(route) {
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
  if (!range) return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes' }, body: VIDEO });
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), VIDEO.length - 1) : VIDEO.length - 1;
  return route.fulfill({ status: 206, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${VIDEO.length}` }, body: VIDEO.subarray(start, end + 1) });
}

// ---- driving the page ---------------------------------------------------------------------------
const shadowQuery = (sel) => `document.querySelector('cleancut-overlay')?.shadowRoot?.querySelector(${JSON.stringify(sel)})`;
const settle = (page, ms = 450) => page.waitForTimeout(ms); // DOM writes land in the next frame; fades take .25 s

async function playFrom(page, t, sel = 'video') {
  await page.evaluate(async ([t, sel]) => {
    const v = document.querySelector(sel);
    v.currentTime = t;
    await v.play().catch(() => {});
  }, [t, sel]);
}
const pause = (page, sel = 'video') => page.evaluate((sel) => document.querySelector(sel).pause(), sel);
/** A viewer nudging the mouse: the site's controls and CleanCut's rail come up together. */
async function wiggle(page, x = 640, y = 300) {
  await page.mouse.move(x, y);
  await page.mouse.move(x + 6, y + 4);
}
async function snap(page, dir, name, clip) {
  if (!want(name)) return;
  await page.screenshot({ path: join(out, dir, `${name}.png`), ...(clip ? { clip } : {}) });
  console.log(`  ${dir}/${name}.png`);
}
const toastWith = (page, text) => page.locator('cleancut-overlay .toast', { hasText: text }).first().waitFor({ timeout: 15_000 });
const badgeReady = (page) => waitFor(() => page.evaluate(`!!${shadowQuery('.badge')}?.textContent`), { what: 'CleanCut badge', timeout: 15_000 });

let ext;
try {
  await waitFor(() => fetch(`${BASE}/catalog/index.json`).then((r) => r.ok, () => false), { what: 'dev server' });
  ext = await launchWithExtension();
  const { context, worker } = ext;
  await ext.setSettings({ catalogBase: `${BASE}/catalog/` });

  // Tags the viewer made earlier on each title: a violent scene at 0:20–0:30, strong language at 1:00–1:02.
  const tags = [{ start: 20, end: 30, category: 'violence', severity: 3 }, { start: 60, end: 62, category: 'language', severity: 3 }, { start: 74, end: 80, category: 'frightening', severity: 3 }];
  const keys = {
    netflix: ['netflix:80000001', { platform: 'netflix', platformId: '80000001', series: 'Simulated Show', season: 1, episode: 1, name: 'Pilot' }],
    prime: ['prime:ck:simulated-show/s01e01', { platform: 'prime', platformId: 'ck:simulated-show/s01e01', series: 'Simulated Show', season: 1, episode: 1, name: 'Pilot' }],
    youtube: [`youtube:${YT_ID}`, { platform: 'youtube', platformId: YT_ID, name: 'Sintel' }],
  };
  for (const [key, title] of Object.values(keys)) for (const t of tags) await ext.addLocalTag(key, title, t);

  const frameParam = (u) => new URL(u).searchParams.get('frame') || 'dark';
  await context.route('https://www.netflix.com/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/fixture/video.webm') return fulfillVideo(route);
    if (u.pathname.startsWith('/watch/')) return route.fulfill({ contentType: 'text/html', body: netflixPage(frameParam(u)) });
    return route.fulfill({ status: 204, body: '' });
  });
  await context.route('https://www.primevideo.com/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/fixture/video.webm') return fulfillVideo(route);
    if (u.pathname.startsWith('/detail/')) return route.fulfill({ contentType: 'text/html', body: primePage(frameParam(u)) });
    return route.fulfill({ status: 204, body: '' });
  });
  await context.route('https://www.youtube.com/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/fixture/video.webm') return fulfillVideo(route);
    if (u.pathname === '/watch') return route.fulfill({ contentType: 'text/html', body: youtubePage(frameParam(u), u.searchParams.get('view') || 'default') });
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ---- the demo page -----------------------------------------------------------------------------
  console.log(`Screenshots → ${out}`);
  if (want('demo')) {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`${BASE}/demo`);
    await page.waitForSelector('cleancut-overlay', { state: 'attached' });
    await page.waitForFunction(() => document.getElementById('v').readyState >= 2);
    await badgeReady(page);
    const box = await page.locator('#v').boundingBox();
    const clip = { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 };
    const over = (fx, fy) => page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => /\/demo/.test(t.url || ''))?.id);

    await playFrom(page, 36, '#v');
    await page.waitForTimeout(600);
    await pause(page, '#v');
    await page.mouse.move(2, 2);
    await page.waitForTimeout(3200); // let the rail hide
    await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'openFlagger' }), tabId);
    await settle(page, 250);
    await snap(page, 'flagging', 'demo-0-open-from-popup', clip);
    await over(0.4, 0.4);
    await settle(page);
    await snap(page, 'flagging', 'demo-1-idle', clip);
    await page.locator('cleancut-overlay .flag-start').hover();
    await page.waitForTimeout(700);
    await snap(page, 'flagging', 'demo-2-shortcut-tooltip', clip);
    await over(0.4, 0.4);
    await playFrom(page, 33, '#v');
    await page.locator('cleancut-overlay .flag-start').click();
    await page.waitForTimeout(3300);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(3000);
    await snap(page, 'flagging', 'demo-3-recording', clip);
    await page.locator('cleancut-overlay .flag-done').click();
    await page.locator('cleancut-overlay .picker').waitFor();
    await page.locator('cleancut-overlay .cat', { hasText: 'Violence' }).click();
    await settle(page);
    await snap(page, 'flagging', 'demo-4-picker', clip);
    await page.locator('cleancut-overlay .save').click();
    await toastWith(page, 'Flagged');
    await playFrom(page, 18.6, '#v');
    await toastWith(page, 'Skipped');
    await over(0.4, 0.4);
    await settle(page);
    await snap(page, 'flagging', 'demo-5-saved', clip);
    await pause(page, '#v');
    await page.mouse.move(2, 2);
    await page.waitForTimeout(5200);
    await page.keyboard.press('Alt+BracketRight');
    await page.locator('cleancut-overlay .picker').waitFor();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Tab');
    await settle(page);
    await snap(page, 'flagging', 'demo-6-keyboard', clip);
    await page.keyboard.press('Escape');
    await worker.evaluate(() => chrome.storage.local.get('localTags').then(({ localTags }) => {
      delete localTags['web:demo-episode-1'];
      return chrome.storage.local.set({ localTags });
    }));
  }
  // The README's picture of the overlay: the demo page as a whole, just after a skip.
  if (want('overlay')) {
    await page.setViewportSize({ width: 1100, height: 620 });
    await page.goto(`${BASE}/demo`);
    await page.waitForSelector('cleancut-overlay', { state: 'attached' });
    await page.waitForFunction(() => document.getElementById('v').readyState >= 2);
    await badgeReady(page);
    await page.waitForTimeout(4500);
    await playFrom(page, 18.6, '#v');
    await toastWith(page, 'Skipped');
    const box = await page.locator('#v').boundingBox();
    await wiggle(page, box.x + box.width * 0.4, box.y + box.height * 0.4);
    await settle(page);
    await page.screenshot({ path: join(out, 'overlay.png') });
    console.log('  overlay.png');
  }

  // ---- Netflix ------------------------------------------------------------------------------------
  await page.setViewportSize({ width: 1280, height: 720 });
  const site = async (url) => {
    await page.goto(url);
    await page.waitForSelector('cleancut-overlay', { state: 'attached', timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    await badgeReady(page);
    await page.waitForTimeout(4500); // the title toast has come and gone
  };
  if (want('netflix')) {
    await site('https://www.netflix.com/watch/80000001?frame=bright');
    await playFrom(page, 33);
    await wiggle(page);
    await settle(page);
    await snap(page, 'flagging', 'netflix-1-idle-bright');
    await page.mouse.move(640, 300);
    await page.waitForTimeout(3500);
    await playFrom(page, 18.6);
    await toastWith(page, 'Skipped');
    await settle(page, 300);
    await snap(page, 'flagging', 'netflix-2-skip-toast-bright');
    await wiggle(page);
    await settle(page);
    await snap(page, 'flagging', 'netflix-3-skip-toast-controls-bright');

    await site('https://www.netflix.com/watch/80000001?frame=dark');
    await playFrom(page, 34);
    await page.keyboard.press('Alt+BracketLeft');
    await page.waitForTimeout(4300);
    await snap(page, 'flagging', 'netflix-4-recording-dark');
    await page.locator('cleancut-overlay .flag-done').click();
    await page.locator('cleancut-overlay .picker').waitFor();
    await page.locator('cleancut-overlay .cat', { hasText: 'Language' }).click();
    await page.locator('cleancut-overlay .sev button', { hasText: 'Strong' }).click();
    await settle(page);
    await snap(page, 'flagging', 'netflix-5-picker-dark');
    await page.locator('cleancut-overlay .save').click();
    await toastWith(page, 'Flagged');
    await wiggle(page);
    await settle(page);
    await snap(page, 'flagging', 'netflix-6-saved-dark');
    await page.evaluate(() => document.getElementById('player').requestFullscreen());
    await page.waitForTimeout(600);
    await page.locator('cleancut-overlay .flag-last').click();
    await page.locator('cleancut-overlay .picker').waitFor();
    await page.keyboard.press('Tab'); // from the panel, Tab starts at the categories
    await settle(page);
    await snap(page, 'flagging', 'netflix-7-fullscreen-picker-keyboard');
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.exitFullscreen().catch(() => {}));
  }

  // ---- Prime Video --------------------------------------------------------------------------------
  if (want('prime')) {
    await site('https://www.primevideo.com/detail/0SIMULATED/?frame=bright');
    await playFrom(page, 18.6);
    await toastWith(page, 'Skipped');
    await wiggle(page);
    await settle(page);
    await snap(page, 'flagging', 'prime-1-skip-toast-controls-bright');
    await site('https://www.primevideo.com/detail/0SIMULATED/?frame=dark');
    await playFrom(page, 40);
    await wiggle(page);
    await page.locator('cleancut-overlay .flag-last').click();
    await page.locator('cleancut-overlay .picker').waitFor();
    await page.locator('cleancut-overlay .cat', { hasText: 'Violence' }).click();
    await wiggle(page);
    await settle(page);
    await snap(page, 'flagging', 'prime-2-picker-controls-dark');
    await page.keyboard.press('Escape');
  }

  // ---- YouTube ------------------------------------------------------------------------------------
  if (want('youtube')) {
    await page.setViewportSize({ width: 1280, height: 800 });
    const yt = async (frame, view) => {
      await site(`https://www.youtube.com/watch?v=${YT_ID}&frame=${frame}&view=${view}`);
    };
    const player = async () => page.locator('#player-container').boundingBox();
    const hoverPlayer = async () => {
      const b = await player();
      await wiggle(page, b.x + b.width * 0.45, b.y + b.height * 0.45);
    };
    await yt('bright', 'default');
    await playFrom(page, 33);
    await hoverPlayer();
    await settle(page);
    await snap(page, 'youtube', 'youtube-1-default-bright');
    await page.mouse.move(1, 1);
    await page.waitForTimeout(3500);
    await playFrom(page, 18.6);
    await toastWith(page, 'Skipped');
    await hoverPlayer();
    await settle(page);
    await snap(page, 'youtube', 'youtube-2-default-skip-toast-bright');

    await yt('dark', 'theater');
    await playFrom(page, 40);
    await hoverPlayer();
    await page.locator('cleancut-overlay .flag-last').click();
    await page.locator('cleancut-overlay .picker').waitFor();
    await page.locator('cleancut-overlay .cat', { hasText: 'Frightening' }).click();
    await hoverPlayer();
    await settle(page);
    await snap(page, 'youtube', 'youtube-3-theater-picker-dark');
    await page.keyboard.press('Escape');

    await yt('dark', 'default');
    await page.evaluate(() => window.fullscreen());
    await page.waitForTimeout(700);
    await playFrom(page, 18.6);
    await toastWith(page, 'Skipped');
    await wiggle(page, 640, 360);
    await settle(page);
    await snap(page, 'youtube', 'youtube-4-fullscreen-skip-toast-dark');
    await page.keyboard.press('Alt+BracketLeft');
    await page.mouse.move(1, 1);
    await page.waitForTimeout(3600);
    await snap(page, 'youtube', 'youtube-5-fullscreen-recording-dark');
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.exitFullscreen().catch(() => {}));

    await yt('bright', 'default');
    await page.evaluate(() => document.getElementById('movie_player').classList.add('ad-showing'));
    await playFrom(page, 5);
    await page.waitForTimeout(400);
    await hoverPlayer();
    await settle(page);
    await snap(page, 'youtube', 'youtube-6-ad-playing-bright');
  }
  if (errors.length) console.log('page errors:', errors);
} finally {
  await ext?.close();
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}
