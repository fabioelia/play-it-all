// The platform registry, per-site request rules and the extractors for
// YouTube and the other streaming services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FRAME_MATCHES, MATCHES, PLATFORMS, PLATFORM_IDS, platformForHost, platformName, watchIdFromUrl } from '../shared/platforms.js';
import { PLATFORMS as CATALOG_PLATFORMS } from '../shared/identity.js';
import { mergeSubmission, validateEpisode } from '../shared/catalog.js';
import {
  classifyResponse, crunchyrollPlayTracks, dashSubtitleTracks, hlsSegments, hlsSubtitleTracks, huluPlaylistTracks, isEnglish,
  looksLikeSubtitle, manifestHasText, manifestSubtitleTracks, mayMatter, metaFromJsonLd, plexMetadataInfo, tubiContentInfo,
  vimeoConfigInfo, youtubeCaptionTracks, youtubePlayerInfo, youtubeSubtitleLanguage,
} from '../shared/sources.js';
import { detectFormat, joinVttSegments, parseASS, parseJson3, parseSrv3, parseSubtitles } from '../shared/subtitles.js';
import { analyzeCues } from '../shared/analyzer.js';
import { episodeMeta } from '../extension/src/content/adapters/streaming.js';

const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const json = (f) => JSON.parse(fixture(f));

// ---- registry ---------------------------------------------------------------------------

test('registry: every platform has an id, a name, hosts, match patterns and a URL rule', () => {
  const ids = new Set();
  for (const p of PLATFORMS) {
    assert.match(p.id, /^[a-z]+$/, p.id);
    assert.ok(!ids.has(p.id), `duplicate ${p.id}`);
    ids.add(p.id);
    assert.ok(p.name, p.id);
    assert.equal(typeof p.watchId, 'function', p.id);
    if (p.id === 'web') continue;
    assert.ok(p.hosts.length && p.matches.length, p.id);
    for (const m of [...p.matches, ...(p.frames || [])]) assert.match(m, /^https:\/\/[^/]+\/.*\*$/, `${p.id}: ${m}`);
  }
  for (const id of ['netflix', 'prime', 'youtube', 'disney', 'max', 'hulu', 'appletv', 'paramount', 'peacock', 'crunchyroll', 'tubi', 'pluto', 'roku', 'plex', 'vimeo', 'web']) {
    assert.ok(PLATFORM_IDS.includes(id), id);
  }
  assert.ok(MATCHES.includes('https://www.youtube.com/*') && MATCHES.includes('https://m.youtube.com/*'));
  assert.ok(MATCHES.includes('https://www.netflix.com/*') && MATCHES.includes('https://www.amazon.co.uk/gp/video/*'));
  assert.deepEqual(FRAME_MATCHES, ['https://www.youtube.com/embed/*', 'https://www.youtube-nocookie.com/embed/*', 'https://player.vimeo.com/video/*']);
});

test('registry: hosts map to platforms; names for the popup', () => {
  const at = (h) => platformForHost(h)?.id || null;
  assert.equal(at('www.netflix.com'), 'netflix');
  assert.equal(at('www.primevideo.com'), 'prime');
  assert.equal(at('www.amazon.de'), 'prime');
  assert.equal(at('www.youtube.com'), 'youtube');
  assert.equal(at('m.youtube.com'), 'youtube');
  assert.equal(at('www.youtube-nocookie.com'), 'youtube');
  assert.equal(at('play.max.com'), 'max');
  assert.equal(at('play.hbomax.com'), 'max');
  assert.equal(at('tv.apple.com'), 'appletv');
  assert.equal(at('www.apple.com'), null);
  assert.equal(at('therokuchannel.roku.com'), 'roku');
  assert.equal(at('www.roku.com'), null);
  assert.equal(at('player.vimeo.com'), 'vimeo');
  assert.equal(at('notnetflix.com'), null);
  assert.equal(at('localhost'), null);
  assert.equal(platformName('netflix'), 'Netflix');
  assert.equal(platformName('prime'), 'Prime Video');
  assert.equal(platformName('youtube'), 'YouTube');
  assert.equal(platformName('disney'), 'Disney+');
  assert.equal(platformName('web', 'example.org'), 'example.org');
  assert.equal(platformName('web'), 'Web');
  assert.equal(platformName('something-new'), 'something-new');
});

test('the catalog accepts every registered platform', () => {
  assert.deepEqual(CATALOG_PLATFORMS, PLATFORM_IDS);
  const sub = { cleancut: 1, title: { platform: 'youtube', platformId: 'eRsGyueVLvQ', name: 'Sintel', year: 2010 }, segments: [{ start: 1, end: 2, category: 'violence', severity: 2 }] };
  const r = mergeSubmission(null, sub);
  assert.equal(r.episode.timeline, 'youtube');
  assert.deepEqual(validateEpisode(r.episode), []);
});

// ---- identify from the URL, per provider ------------------------------------------------

test('watchIdFromUrl: the title in the address, and nothing on browse pages', () => {
  const cases = [
    ['https://www.netflix.com/watch/80057281?trackId=1', '80057281'],
    ['https://www.netflix.com/browse', null],
    ['https://www.youtube.com/watch?v=eRsGyueVLvQ&t=42s', 'eRsGyueVLvQ'],
    ['https://m.youtube.com/watch?v=eRsGyueVLvQ', 'eRsGyueVLvQ'],
    ['https://www.youtube.com/embed/eRsGyueVLvQ?autoplay=1', 'eRsGyueVLvQ'],
    ['https://www.youtube-nocookie.com/embed/eRsGyueVLvQ', 'eRsGyueVLvQ'],
    ['https://www.youtube.com/live/jfKfPfyJRdk', 'jfKfPfyJRdk'],
    ['https://www.youtube.com/shorts/eRsGyueVLvQ', null],
    ['https://www.youtube.com/', null],
    ['https://www.youtube.com/watch?v=bad', null],
    ['https://www.youtube.com/@Blender', null],
    ['https://www.disneyplus.com/play/2d8f0a4e-1d8a-4b5e-8e3f-0a1b2c3d4e5f', '2d8f0a4e-1d8a-4b5e-8e3f-0a1b2c3d4e5f'],
    ['https://www.disneyplus.com/en-gb/play/2d8f0a4e-1d8a-4b5e-8e3f-0a1b2c3d4e5f', '2d8f0a4e-1d8a-4b5e-8e3f-0a1b2c3d4e5f'],
    ['https://www.disneyplus.com/video/2d8f0a4e-1d8a-4b5e-8e3f-0a1b2c3d4e5f', '2d8f0a4e-1d8a-4b5e-8e3f-0a1b2c3d4e5f'],
    ['https://www.disneyplus.com/browse/entity-2d8f0a4e-1d8a-4b5e-8e3f-0a1b2c3d4e5f', null],
    ['https://play.max.com/video/watch/1f7a7d2b-2c3d-4e5f-8a9b-0c1d2e3f4a5b/3c0f1b5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', '1f7a7d2b-2c3d-4e5f-8a9b-0c1d2e3f4a5b'],
    ['https://play.hbomax.com/video/watch/1f7a7d2b-2c3d-4e5f-8a9b-0c1d2e3f4a5b/3c0f1b5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', '1f7a7d2b-2c3d-4e5f-8a9b-0c1d2e3f4a5b'],
    ['https://play.hbomax.com/show/e8d516df-be68-42a3-8180-82a4b56ff589', null],
    ['https://www.hulu.com/watch/7f0c2a43-5c0e-4d9e-9a3c-2b1f8e0d6a11', '7f0c2a43-5c0e-4d9e-9a3c-2b1f8e0d6a11'],
    ['https://www.hulu.com/series/the-bear-05d2bf5e-5a37-4f5b-9c34-0a7f2c1e2b2f', null],
    ['https://tv.apple.com/us/episode/good-news-about-hell/umc.cmc.1srk2goyh2q2zdxcx605w8vtx?showId=umc.cmc.1sr', 'umc.cmc.1srk2goyh2q2zdxcx605w8vtx'],
    ['https://tv.apple.com/us/movie/interstellar/umc.cmc.1vrwat5k1ucm5k42q97ioqyq3?ctx_agid=1', 'umc.cmc.1vrwat5k1ucm5k42q97ioqyq3'],
    ['https://tv.apple.com/us/show/severance/umc.cmc.1srk2goyh2q2zdxcx605w8vtx', null],
    ['https://www.paramountplus.com/shows/video/x6mVfBkzhQnVAbSc_X3bWyWkgCK8lsoh/', 'x6mVfBkzhQnVAbSc_X3bWyWkgCK8lsoh'],
    ['https://www.paramountplus.com/movies/video/wjQ4RChi6BHHu4MVTncppVuCwu44uq2Q/', 'wjQ4RChi6BHHu4MVTncppVuCwu44uq2Q'],
    ['https://www.paramountplus.com/shows/star-trek/video/x6mVfBkzhQnVAbSc_X3bWyWkgCK8lsoh/pilot/', 'x6mVfBkzhQnVAbSc_X3bWyWkgCK8lsoh'],
    ['https://www.paramountplus.com/shows/', null],
    ['https://www.peacocktv.com/watch/playback/vod/GMO_00000000224510_02_HDSDR/e0d1fe74-6f5c-3c1a-9a7e-6b5c0d4e3f21', 'GMO_00000000224510_02_HDSDR'],
    ['https://www.peacocktv.com/watch/asset/tv/the-office/4902514835143843112', null],
    ['https://www.crunchyroll.com/watch/G4VUQ1ZKW/the-first-episode', 'G4VUQ1ZKW'],
    ['https://www.crunchyroll.com/fr/watch/G4VUQ1ZKW/', 'G4VUQ1ZKW'],
    ['https://www.crunchyroll.com/series/GY5P48XEY/demon-slayer', null],
    ['https://tubitv.com/movies/594084/i-am-legend', '594084'],
    ['https://tubitv.com/tv-shows/300004566/s01-e01-pilot', '300004566'],
    ['https://tubitv.com/series/300004/some-show', null],
    ['https://pluto.tv/us/on-demand/movies/64a8f2c0e8a1b2001a3b4c5d/details', '64a8f2c0e8a1b2001a3b4c5d'],
    ['https://pluto.tv/us/on-demand/series/hells-kitchen/season/3/episode/hells-kitchen-3-1', 'hells-kitchen/3/hells-kitchen-3-1'],
    ['https://pluto.tv/us/live-tv/pluto-tv-movies', null],
    ['https://therokuchannel.roku.com/watch/4a14dcd7c845df1ca6cb4b792cb77ae0', '4a14dcd7c845df1ca6cb4b792cb77ae0'],
    ['https://therokuchannel.roku.com/details/4a14dcd7c845df1ca6cb4b792cb77ae0/zoeys-extraordinary-christmas', null],
    ['https://app.plex.tv/desktop/#!/server/0123456789abcdef0123456789abcdef01234567/details?key=%2Flibrary%2Fmetadata%2F4242&context=library', '0123456789ab:4242'],
    ['https://app.plex.tv/desktop/#!/media/tv.plex.provider.vod/details?key=%2Flibrary%2Fmetadata%2F5d7768ba96b655001fdc0408', '5d7768ba96b655001fdc0408'],
    ['https://app.plex.tv/desktop/#!/', null],
    ['https://watch.plex.tv/watch/movie/the-general', 'movie/the-general'],
    ['https://vimeo.com/76979871', '76979871'],
    ['https://vimeo.com/channels/staffpicks/76979871', '76979871'],
    ['https://vimeo.com/showcase/123456/video/76979871', '76979871'],
    ['https://player.vimeo.com/video/76979871?h=8272103f6e', '76979871'],
    ['https://vimeo.com/watch', null],
    ['https://example.com/watch/123', null],
  ];
  for (const [url, id] of cases) assert.equal(watchIdFromUrl(url), id, url);
  assert.equal(watchIdFromUrl('not a url'), null);
});

// ---- which requests the page hook looks at ---------------------------------------------------

test('mayMatter per site: player data, manifests and caption files only, never media', () => {
  const yt = 'www.youtube.com';
  assert.ok(mayMatter('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', yt));
  assert.ok(mayMatter('https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=json3&pot=1', yt));
  assert.ok(mayMatter('https://www.youtube.com/api/timedtext?v=x&lang=ja&tlang=en', yt));
  assert.ok(!mayMatter('https://www.youtube.com/api/timedtext?v=x&lang=fr', yt));
  assert.ok(!mayMatter('https://www.youtube.com/youtubei/v1/player/heartbeat?alt=json', yt));
  assert.ok(!mayMatter('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', yt));
  assert.ok(!mayMatter('https://www.youtube.com/youtubei/v1/log_event?alt=json', yt));
  assert.ok(!mayMatter('https://rr4---sn-2op5q5-52.googlevideo.com/videoplayback?expire=1&mime=video%2Fmp4&caption=1', yt));
  assert.ok(!mayMatter('https://www.youtube.com/api/stats/qoe?cpn=x&subtitle=1', yt));
  assert.ok(!mayMatter('https://i.ytimg.com/vi/x/hqdefault.jpg', yt));
  assert.ok(mayMatter('https://www.youtube-nocookie.com/youtubei/v1/player?prettyPrint=false', 'www.youtube-nocookie.com'));

  const vm = 'vimeo.com';
  assert.ok(mayMatter('https://player.vimeo.com/video/76979871/config?h=1', vm));
  assert.ok(mayMatter('https://captions.vimeo.com/captions/140662.vtt?expires=1&sig=x', 'player.vimeo.com'));
  assert.ok(!mayMatter('https://vod-adaptive-ak.vimeocdn.com/exp=1/v2/range/avf/abc.mp4?r=x', vm));
  assert.ok(!mayMatter('https://vimeo.com/api/v2/video/76979871.json', vm));

  const dp = 'www.disneyplus.com';
  assert.ok(mayMatter('https://vod-l3c-na-west-1.media.dssott.com/ps01/disney/abc/ctr-all-123.m3u8?a=1', dp));
  for (const u of ['https://vod.media.dssott.com/ps01/disney/abc/r/composite_en_CC_seg_00001.vtt', 'https://vod.media.dssott.com/abc/1080/seg_001.mp4', 'https://vod.media.dssott.com/abc/a/seg_001.m4s', 'https://vod.media.dssott.com/abc/v/seg_001.ts', 'https://disney.api.edge.bamgrid.com/explore/v1.4/page/x']) {
    assert.ok(!mayMatter(u, dp), u);
  }
  assert.ok(mayMatter('https://akm.cdn.max.com/x/manifest.mpd?r=1', 'play.max.com'));
  assert.ok(!mayMatter('https://akm.cdn.max.com/x/v/seg_1.m4s', 'play.max.com'));
  assert.ok(mayMatter('https://play.hulu.com/v6/playlist', 'www.hulu.com'));
  assert.ok(mayMatter('https://assetshuluimcom-a.akamaihd.net/captions_webvtt/7f/abc_US_en_en.vtt', 'www.hulu.com'));
  assert.ok(!mayMatter('https://manifest-dp.hulustream.com/x/seg_1.mp4', 'www.hulu.com'));
  assert.ok(mayMatter('https://cr-play-service.prd.crunchyrollsvc.com/v1/G4VUQ1ZKW/web/chrome/play', 'www.crunchyroll.com'));
  assert.ok(mayMatter('https://v.vrv.co/evs3/abc/assets/en-US.ass?t=1', 'www.crunchyroll.com'));
  assert.ok(!mayMatter('https://www.crunchyroll.com/content/v2/cms/objects/G4VUQ1ZKW', 'www.crunchyroll.com'));
  assert.ok(mayMatter('https://content-cdn.production-public.tubi.io/api/v3/content?content_id=594084', 'tubitv.com'));
  assert.ok(mayMatter('https://s.adrise.tv/04d1fa97-5254-4404-8b44-1586a8932da7.srt', 'tubitv.com'));
  assert.ok(!mayMatter('https://nc-cf.tubi.video/1f9/p4fnzvwl3l.m3u8?token=x', 'tubitv.com'));
  assert.ok(mayMatter('https://service-stitcher.clusters.pluto.tv/v2/stitch/hls/episode/64a8f2c0/master.m3u8?x=1', 'pluto.tv'));
  assert.ok(!mayMatter('https://service-stitcher.clusters.pluto.tv/v2/stitch/hls/channel/5cb0/master.m3u8', 'pluto.tv'));
  assert.ok(mayMatter('https://192-168-1-2.abc.plex.direct:32400/library/metadata/4242?includeChapters=1&X-Plex-Token=t', 'app.plex.tv'));
  assert.ok(mayMatter('https://192-168-1-2.abc.plex.direct:32400/library/streams/77?X-Plex-Token=t', 'app.plex.tv'));
  assert.ok(!mayMatter('https://192-168-1-2.abc.plex.direct:32400/library/metadata/4242/children', 'app.plex.tv'));
  assert.ok(!mayMatter('https://192-168-1-2.abc.plex.direct:32400/library/parts/1/file.mkv', 'app.plex.tv'));
  for (const host of ['tv.apple.com', 'www.paramountplus.com', 'www.peacocktv.com', 'therokuchannel.roku.com']) {
    assert.ok(mayMatter('https://cdn.example.net/a/master.m3u8', host), host);
    assert.ok(!mayMatter('https://cdn.example.net/a/seg-1.ts', host), host);
    assert.ok(!mayMatter('https://cdn.example.net/a/seg-1.vtt', host), host);
  }
});

test('classifyResponse per site: kinds, and labelled media is never read', () => {
  const yt = 'www.youtube.com';
  assert.equal(classifyResponse('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', yt, { contentType: 'application/json; charset=UTF-8' }), 'json');
  assert.equal(classifyResponse('https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=json3', yt, { contentType: 'application/json; charset=UTF-8' }), 'subtitle');
  assert.equal(classifyResponse('https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=json3', yt, { contentType: 'text/html' }), null);
  assert.equal(classifyResponse('https://s.adrise.tv/abc.srt', 'tubitv.com', { contentType: 'application/octet-stream' }), 'subtitle');
  assert.equal(classifyResponse('https://cdn.example.net/a/master.m3u8', 'www.disneyplus.com', { contentType: 'application/vnd.apple.mpegurl' }), 'manifest');
  assert.equal(classifyResponse('https://cdn.example.net/a/master.m3u8', 'www.disneyplus.com', { contentType: 'video/mp2t' }), null);
  assert.equal(classifyResponse('https://cdn.example.net/a/manifest.mpd', 'play.max.com', { contentType: 'application/dash+xml' }), 'manifest');
  assert.equal(classifyResponse('https://cdn.example.net/a/manifest.mpd', 'play.max.com', { length: 9e6 }), null);
  assert.equal(classifyResponse('https://player.vimeo.com/video/1/config', 'vimeo.com', { contentType: 'application/json' }), 'json');
  // Netflix and Prime keep their own rules.
  assert.equal(classifyResponse('https://www.netflix.com/playapi/cadmium/licensedmanifest/1', 'www.netflix.com'), 'json');
  assert.equal(classifyResponse('https://atv-ps.primevideo.com/cdp/catalog/GetPlaybackResources?asin=B0', 'www.primevideo.com'), 'json');
});

test('manifestHasText keeps only manifests that list text renditions', () => {
  assert.ok(manifestHasText('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",LANGUAGE="en",URI="s.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8'));
  assert.ok(!manifestHasText('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8'));
  assert.ok(!manifestHasText('#EXTM3U\n#EXTINF:6,\nseg1.ts\n'));
  assert.ok(manifestHasText('<?xml version="1.0"?><MPD><Period><AdaptationSet contentType="text" lang="en"></AdaptationSet></Period></MPD>'));
  assert.ok(!manifestHasText('<MPD><Period><AdaptationSet contentType="video"></AdaptationSet></Period></MPD>'));
  assert.ok(!manifestHasText(null));
});

// ---- YouTube ---------------------------------------------------------------------------------

test('YouTube caption tracks: manual English (CC first), then automatic; json3; no other languages', () => {
  const pr = json('youtube-player.json');
  const tracks = youtubeCaptionTracks(pr);
  assert.deepEqual(tracks.map((t) => [t.language, t.kind, t.sdh]), [['en-GB', 'manual', true], ['en', 'manual', false], ['en', 'asr', false]]);
  for (const t of tracks) {
    assert.equal(new URL(t.url).searchParams.get('fmt'), 'json3', t.url);
    assert.ok(t.ask);
    assert.ok(t.url.includes('signature='), 'signed URL kept');
  }
  assert.equal(tracks.filter((t) => t.url.includes('fmt=srv3')).length, 0, 'fmt replaced, not duplicated');
  // Only automatic English: that is used.
  const asrOnly = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [pr.captions.playerCaptionsTracklistRenderer.captionTracks[0], pr.captions.playerCaptionsTracklistRenderer.captionTracks[3]] } } };
  assert.deepEqual(youtubeCaptionTracks(asrOnly).map((t) => t.kind), ['asr']);
  // No English at all: a machine translation of the video's own track.
  const frOnly = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [pr.captions.playerCaptionsTracklistRenderer.captionTracks[3]] } } };
  const [tr] = youtubeCaptionTracks(frOnly);
  assert.equal(tr.kind, 'translated');
  assert.equal(new URL(tr.url).searchParams.get('tlang'), 'en');
  assert.equal(tr.from, 'fr');
  assert.deepEqual(youtubeCaptionTracks({}), []);
  assert.deepEqual(youtubeCaptionTracks({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }, null, 'x'] } } }), []);
});

test('YouTube player response → id, title, channel, tracks', () => {
  const info = youtubePlayerInfo(json('youtube-player.json'));
  assert.equal(info.movieId, 'eRsGyueVLvQ');
  assert.deepEqual(info.meta, { name: 'Sintel - Open Movie by Blender Foundation', channel: 'Blender', runtime: 888, type: 'video' });
  assert.equal(info.tracks.length, 3);
  assert.equal(info.available, 3);
  const film = youtubePlayerInfo({ videoDetails: { videoId: 'abcdefghijk', title: 'Big Film', isTvfilmVideo: true }, microformat: { playerMicroformatRenderer: { publishDate: '2019-03-01' } } });
  assert.equal(film.meta.tvfilm, true);
  assert.equal(film.meta.year, 2019);
  assert.deepEqual(film.tracks, []);
  // A blocked or unplayable response still names the video when it can.
  assert.equal(youtubePlayerInfo({ playabilityStatus: { status: 'LOGIN_REQUIRED' } }), null);
  assert.equal(youtubePlayerInfo(null), null);
});

test('YouTube timed-text language: translation target first', () => {
  assert.equal(youtubeSubtitleLanguage('https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=json3'), 'en');
  assert.equal(youtubeSubtitleLanguage('https://www.youtube.com/api/timedtext?v=x&lang=ja&tlang=en'), 'en');
  assert.equal(youtubeSubtitleLanguage('https://www.youtube.com/api/timedtext?v=x&lang=en&tlang=fr'), 'fr');
  assert.equal(youtubeSubtitleLanguage('https://www.youtube.com/api/timedtext?v=x&lang=en-GB'), 'en-GB');
});

test('YouTube json3: words joined into lines, sound cues kept, the [ __ ] mask muted', () => {
  const text = fixture('youtube-asr.json3');
  assert.equal(detectFormat(text), 'json3');
  assert.ok(looksLikeSubtitle(text));
  const cues = parseJson3(text);
  assert.deepEqual(cues.map((c) => c.text), ['[Music]', 'what are you doing', 'get the f**k out', 'Tom & Jerry', 'we have to go', '[Applause]']);
  assert.deepEqual([cues[1].start, cues[1].end], [5, 9.1]);
  assert.deepEqual(parseSubtitles(text), cues);
  const language = analyzeCues(cues).filter((s) => s.category === 'language');
  assert.equal(language.length, 1);
  assert.equal(language[0].severity, 3);
  assert.ok(language[0].start >= 7 && language[0].end <= 11.1);
  assert.deepEqual(parseJson3('{"events": "nope"}'), []);
  assert.deepEqual(parseJson3('not json'), []);
});

test('YouTube srv3 and the older transcript format', () => {
  const srv3 = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body><p t="1000" d="2500">Hello &amp; welcome</p><p t="4000" d="1000"><s ac="0">what</s><s t="200"> the</s><s t="400"> [ __ ]</s></p><p t="9000" d="1000"></p></body></timedtext>';
  assert.equal(detectFormat(srv3), 'srv3');
  assert.ok(looksLikeSubtitle(srv3));
  assert.deepEqual(parseSrv3(srv3), [{ start: 1, end: 3.5, text: 'Hello & welcome' }, { start: 4, end: 5, text: 'what the f**k' }]);
  const old = '<?xml version="1.0" encoding="utf-8" ?><transcript><text start="0.5" dur="2">it&amp;#39;s fine</text></transcript>';
  assert.deepEqual(parseSubtitles(old), [{ start: 0.5, end: 2.5, text: "it's fine" }]);
});

// ---- the other services -------------------------------------------------------------------------

test('Vimeo player config → English track, title, owner', () => {
  const info = vimeoConfigInfo(json('vimeo-config.json'));
  assert.equal(info.movieId, '76979871');
  assert.equal(info.meta.name, 'The New Vimeo Player (You Know, For Videos)');
  assert.equal(info.meta.channel, 'Vimeo');
  assert.deepEqual(info.tracks.map((t) => [t.language, t.format]), [['en', 'vtt']]);
  assert.match(info.tracks[0].url, /^https:\/\/captions\.vimeo\.com\/captions\/140662\.vtt/);
  assert.equal(vimeoConfigInfo({}), null);
});

test('Tubi content → .srt over https', () => {
  // The shape tubitv.com embeds for a title (and its content API returns).
  const info = tubiContentInfo({ video: { id: '594084', title: 'I Am Legend', year: 2007, duration: 6028, subtitles: [
    { url: 'http://s.adrise.tv/04d1fa97-5254-4404-8b44-1586a8932da7.srt', lang: 'English', lang_alpha3: 'eng', lang_translation: 'English' },
    { url: 'http://s.adrise.tv/x.srt', lang: 'Spanish', lang_alpha3: 'spa' },
  ] } });
  assert.equal(info.movieId, '594084');
  assert.deepEqual(info.meta, { name: 'I Am Legend', year: 2007, runtime: 6028 });
  assert.deepEqual(info.tracks, [{ url: 'https://s.adrise.tv/04d1fa97-5254-4404-8b44-1586a8932da7.srt', language: 'en', sdh: false, format: 'srt' }]);
  assert.equal(tubiContentInfo({ nothing: true }), null);
});

test('Hulu playlist, Crunchyroll play service, Plex metadata', () => {
  assert.deepEqual(huluPlaylistTracks({ transcripts_urls: { webvtt: { en: 'https://a/en.vtt', es: 'https://a/es.vtt' }, ttml: { en: 'https://a/en.ttml' }, smi: { en: 'https://a/en.smi' } } }).map((t) => [t.format, t.url]),
    [['vtt', 'https://a/en.vtt'], ['ttml', 'https://a/en.ttml']]);
  assert.deepEqual(huluPlaylistTracks({}), []);

  const cr = crunchyrollPlayTracks({
    subtitles: { 'en-US': { format: 'ass', language: 'en-US', url: 'https://v.vrv.co/a/en-US.ass' }, 'de-DE': { format: 'ass', language: 'de-DE', url: 'https://v.vrv.co/a/de.ass' } },
    captions: { 'en-US': { format: 'vtt', language: 'en-US', url: 'https://v.vrv.co/a/en-US.cc.vtt' } },
  });
  assert.deepEqual(cr.map((t) => [t.format, t.sdh]), [['vtt', true], ['ass', false]]);

  const plex = plexMetadataInfo({ MediaContainer: { Metadata: [{
    ratingKey: '4242', guid: 'plex://episode/5d9c', type: 'episode', title: 'Pilot', grandparentTitle: 'The Show', parentIndex: 1, index: 1, duration: 1800000,
    Media: [{ Part: [{ Stream: [
      { streamType: 1, codec: 'h264' },
      { streamType: 3, codec: 'srt', languageCode: 'eng', key: '/library/streams/77', hearingImpaired: true },
      { streamType: 3, codec: 'pgs', languageCode: 'eng', key: '/library/streams/78' },
      { streamType: 3, codec: 'ass', languageCode: 'fre', key: '/library/streams/79' },
      { streamType: 3, codec: 'srt', languageCode: 'eng', key: '/library/streams/80', forced: true },
    ] }] }],
  }] } }, 'https://192-168-1-2.abc.plex.direct:32400/library/metadata/4242?X-Plex-Token=tok%20en');
  assert.equal(plex.ratingKey, '4242');
  assert.deepEqual(plex.meta, { type: 'episode', series: 'The Show', season: 1, episode: 1, name: 'Pilot', runtime: 1800 });
  assert.deepEqual(plex.tracks.map((t) => [t.url, t.sdh]), [['https://192-168-1-2.abc.plex.direct:32400/library/streams/77?X-Plex-Token=tok%20en', true]]);
});

test('HLS: English subtitle renditions (SDH first, forced skipped) and their segments', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="en",NAME="English",URI="audio/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",LANGUAGE="en",NAME="English",AUTOSELECT=YES,URI="r/en_sub.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",LANGUAGE="en",NAME="English [CC]",CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound",URI="r/en_cc.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",LANGUAGE="en",NAME="English (forced)",FORCED=YES,URI="r/en_forced.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",LANGUAGE="es-419",NAME="Español",URI="r/es.m3u8"',
    '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",LANGUAGE="en",INSTREAM-ID="CC1"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,SUBTITLES="sub"',
    'v/1080.m3u8',
  ].join('\n');
  const tracks = hlsSubtitleTracks(master, 'https://cdn.example.net/ps01/title/master.m3u8?token=1');
  assert.deepEqual(tracks.map((t) => [t.url, t.sdh, t.format]), [
    ['https://cdn.example.net/ps01/title/r/en_cc.m3u8', true, 'hls'],
    ['https://cdn.example.net/ps01/title/r/en_sub.m3u8', false, 'hls'],
  ]);
  assert.deepEqual(manifestSubtitleTracks(master, 'https://cdn.example.net/ps01/title/master.m3u8'), hlsSubtitleTracks(master, 'https://cdn.example.net/ps01/title/master.m3u8'));
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg_00001.vtt\n#EXTINF:6.0,\nseg_00002.vtt\n#EXT-X-ENDLIST\n';
  assert.deepEqual(hlsSegments(media, 'https://cdn.example.net/ps01/title/r/en_cc.m3u8'), ['https://cdn.example.net/ps01/title/r/seg_00001.vtt', 'https://cdn.example.net/ps01/title/r/seg_00002.vtt']);
  assert.deepEqual(hlsSegments('#EXTM3U\n#EXT-X-BYTERANGE:100@0\nall.vtt\n#EXT-X-BYTERANGE:100@100\nall.vtt\n', 'https://x/a.m3u8'), ['https://x/all.vtt']);
});

test('HLS WebVTT segments are joined into one track, timestamp maps honoured', () => {
  const seg = (map, body) => `WEBVTT\n${map ? `X-TIMESTAMP-MAP=${map}\n` : ''}\n${body}\n`;
  const joined = joinVttSegments([
    seg('MPEGTS:900000,LOCAL:00:00:00.000', '00:00:01.000 --> 00:00:03.000\nfirst line\n\n00:00:05.000 --> 00:00:07.000\nacross the boundary'),
    seg('MPEGTS:900000,LOCAL:00:00:00.000', '00:00:05.000 --> 00:00:07.000\nacross the boundary\n\n00:00:08.000 --> 00:00:09.500\n[gunshots]'),
    null,
    '<html>error</html>',
  ]);
  const cues = parseSubtitles(joined);
  assert.deepEqual(cues.map((c) => [c.start, c.end, c.text]), [[1, 3, 'first line'], [5, 7, 'across the boundary'], [8, 9.5, '[gunshots]']]);
  // Per-segment timestamp maps (each segment timed from its own start).
  const shifted = parseSubtitles(joinVttSegments([
    seg('MPEGTS:900000,LOCAL:00:00:00.000', '00:00:01.000 --> 00:00:02.000\none'),
    seg('MPEGTS:1440000,LOCAL:00:00:00.000', '00:00:01.000 --> 00:00:02.000\ntwo'),
  ]));
  assert.deepEqual(shifted.map((c) => [c.start, c.text]), [[1, 'one'], [7, 'two']]);
  assert.equal(joinVttSegments([]), null);
});

test('DASH: sidecar English text tracks; segmented and fragmented ones skipped', () => {
  const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><BaseURL>https://cdn.example.net/title/</BaseURL>
<Period id="0">
  <AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v1"><BaseURL>v/1080.mp4</BaseURL></Representation></AdaptationSet>
  <AdaptationSet contentType="text" mimeType="text/vtt" lang="en"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/><Representation id="t1"><BaseURL>t/sub/en.vtt</BaseURL></Representation></AdaptationSet>
  <AdaptationSet contentType="text" mimeType="text/vtt" lang="en" label="English SDH"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="caption"/><Representation id="t2"><BaseURL>t/sub/en_sdh.vtt</BaseURL></Representation></AdaptationSet>
  <AdaptationSet contentType="text" mimeType="text/vtt" lang="en"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="forced-subtitle"/><Representation id="t3"><BaseURL>t/sub/en_forced.vtt</BaseURL></Representation></AdaptationSet>
  <AdaptationSet contentType="text" mimeType="application/ttml+xml" lang="fr"><Representation id="t4"><BaseURL>t/sub/fr.ttml</BaseURL></Representation></AdaptationSet>
  <AdaptationSet contentType="text" mimeType="application/mp4" codecs="stpp" lang="en"><Representation id="t5"><SegmentTemplate media="t/stpp/$Number$.m4s"/></Representation></AdaptationSet>
  <AdaptationSet contentType="text" mimeType="text/vtt" lang="en-US"><Representation id="t6"><SegmentTemplate media="t/seg/$Number$.vtt"/><BaseURL>t/seg/</BaseURL></Representation></AdaptationSet>
</Period></MPD>`;
  const tracks = dashSubtitleTracks(mpd, 'https://manifests.example.net/x/manifest.mpd');
  assert.deepEqual(tracks.map((t) => [t.url, t.sdh, t.format]), [
    ['https://cdn.example.net/title/t/sub/en_sdh.vtt', true, 'vtt'],
    ['https://cdn.example.net/title/t/sub/en.vtt', false, 'vtt'],
  ]);
  assert.deepEqual(dashSubtitleTracks('<html></html>', 'https://x/'), []);
});

test('JSON-LD: episodes and films, only for the title in the address', () => {
  // The shape tubitv.com publishes.
  const tubi = [{ '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebPage', url: 'https://tubitv.com/movies/594084/i-am-legend', name: 'I Am Legend (2007)' },
    { '@type': 'Movie', '@id': 'https://tubitv.com/movies/594084/i-am-legend#video', name: 'I Am Legend', url: 'https://tubitv.com/movies/594084/i-am-legend', dateCreated: '2007-12-14' },
    { '@type': 'VideoObject', name: 'I Am Legend (2007)', url: 'https://tubitv.com/movies/594084/i-am-legend' },
  ] }];
  assert.deepEqual(metaFromJsonLd(tubi, '594084'), { type: 'movie', name: 'I Am Legend', year: 2007 });
  assert.equal(metaFromJsonLd(tubi, '999999'), null, 'a stale block for another title is ignored');
  const ep = { '@type': 'TVEpisode', url: 'https://www.crunchyroll.com/watch/G4VUQ1ZKW/x', name: 'Cruelty', episodeNumber: '1',
    partOfSeason: { '@type': 'TVSeason', seasonNumber: '1' }, partOfSeries: { '@type': 'TVSeries', name: 'Demon Slayer' } };
  assert.deepEqual(metaFromJsonLd([ep], 'G4VUQ1ZKW'), { type: 'episode', series: 'Demon Slayer', season: 1, episode: 1, name: 'Cruelty' });
  assert.equal(metaFromJsonLd([], 'x'), null);
});

test('episode labels the players show', () => {
  assert.deepEqual(episodeMeta('The Mandalorian', 'S1:E2 Chapter 2: The Child'), { series: 'The Mandalorian', season: 1, episode: 2, name: 'Chapter 2: The Child' });
  assert.deepEqual(episodeMeta('The Last of Us', 'S1 E3 · Long, Long Time'), { series: 'The Last of Us', season: 1, episode: 3, name: 'Long, Long Time' });
  assert.deepEqual(episodeMeta('Demon Slayer', 'E5 - My Own Steel'), { series: 'Demon Slayer', episode: 5, name: 'My Own Steel' });
  assert.deepEqual(episodeMeta('Inception', ''), { name: 'Inception' });
  assert.equal(episodeMeta('', ''), null);
});

// ---- subtitle formats the services serve -----------------------------------------------------

test('ASS (Crunchyroll): dialogue lines, override tags and signs dropped', () => {
  const ass = `[Script Info]
Title: Episode 1
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\i1}Where are you,\\Nbrother?{\\i0}
Dialogue: 0,0:00:04.00,0:00:05.25,Signs,,0,0,0,,{\\pos(10,10)}TOKYO STATION
Comment: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,not shown
Dialogue: 0,0:01:02.00,0:01:04.00,Default,,0,0,0,,Damn it, run!
`;
  assert.equal(detectFormat(ass), 'ass');
  assert.ok(looksLikeSubtitle(ass));
  assert.deepEqual(parseASS(ass), [{ start: 1.5, end: 3, text: 'Where are you,\nbrother?' }, { start: 62, end: 64, text: 'Damn it, run!' }]);
  assert.equal(parseSubtitles(ass).length, 2);
});

test('looksLikeSubtitle accepts every format the scanner reads, nothing else', () => {
  assert.ok(looksLikeSubtitle('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi'));
  assert.ok(looksLikeSubtitle('1\n00:00:01,000 --> 00:00:02,000\nhi\n'));
  assert.ok(looksLikeSubtitle('<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body/></tt>'));
  assert.ok(!looksLikeSubtitle('<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code></Error>'));
  assert.ok(!looksLikeSubtitle(''));
  assert.ok(!looksLikeSubtitle('{"error":{"code":403}}'));
  assert.ok(!looksLikeSubtitle('<!doctype html><html>'));
});

test('isEnglish reads codes and names', () => {
  for (const v of ['en', 'en-US', 'eng', 'English', 'English [CC]']) assert.ok(isEnglish(v), v);
  for (const v of ['es', 'fre', 'Español', '', null, 'england-fr']) assert.ok(!isEnglish(v), String(v));
});
