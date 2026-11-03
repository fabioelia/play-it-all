import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS, resolveProfile, exceeds, describeProfile } from '../shared/ratings.js';
import { buildPlan, decide, mergeRegions, skippedSeconds } from '../shared/engine.js';
import { parseSubtitles, parseTTMLTime, parseClock, detectFormat, ttmlLanguage } from '../shared/subtitles.js';
import { analyzeCues, findProfanity, splitCue } from '../shared/analyzer.js';
import { extractNetflixTimedText, extractNetflixMetadata, extractPrimeSubtitles, extractPrimeTitle, looksLikeSubtitle } from '../shared/sources.js';
import { canonicalKey, parseEpisodeLabel, slug, formatTime } from '../shared/identity.js';
import { validateSegment } from '../shared/validate.js';

const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const seg = (start, end, category, severity, extra = {}) => ({ id: `${category}-${start}`, start, end, category, severity, source: 'community', ...extra });

test('presets get stricter from R to G', () => {
  const order = ['unfiltered', 'R', 'PG-13', 'PG', 'G'];
  for (let i = 1; i < order.length; i++) {
    for (const [cat, max] of Object.entries(PRESETS[order[i]].thresholds)) {
      assert.ok(max <= PRESETS[order[i - 1]].thresholds[cat], `${order[i]} ${cat}`);
    }
  }
});

test('resolveProfile: presets, custom thresholds, bad input', () => {
  assert.equal(resolveProfile({ preset: 'G' }).thresholds.sex, 0);
  const custom = resolveProfile({ preset: 'custom', thresholds: { violence: 1, language: 9 } });
  assert.equal(custom.thresholds.violence, 1);
  assert.equal(custom.thresholds.language, 3);
  assert.equal(resolveProfile({ preset: 'nonsense' }).preset, 'PG-13');
  assert.equal(resolveProfile({ actions: { violence: 'blur', sex: 'explode' } }).actions.violence, 'blur');
  assert.equal(resolveProfile({ actions: { sex: 'explode' } }).actions.sex, 'skip');
  assert.ok(exceeds(seg(0, 1, 'sex', 2), resolveProfile({ preset: 'R' })) === false);
  assert.ok(exceeds(seg(0, 1, 'sex', 3), resolveProfile({ preset: 'R' })));
  assert.match(describeProfile({ preset: 'custom', thresholds: { nudity: 0 } }), /no nudity/);
});

test('Game of Thrones example: same tags, different cuts per rating', () => {
  const tags = [
    seg(120, 180, 'sex', 3),
    seg(400, 420, 'violence', 3),
    seg(421, 425, 'gore', 3),
    seg(600, 602, 'language', 3),
    seg(700, 701, 'language', 1),
  ];
  const plan = (preset) => buildPlan(tags, { preset }).actions;
  assert.deepEqual(plan('unfiltered'), []);
  const r = plan('R');
  assert.deepEqual(r.map((a) => a.action), ['skip', 'skip']); // strong sex + strong gore
  const pg13 = plan('PG-13');
  // violence 400-420 and gore 421-425 merge into one skip
  assert.deepEqual(pg13.map((a) => [a.action, Math.round(a.start)]), [['skip', 120], ['skip', 400], ['mute', 600]]);
  const g = plan('G');
  assert.equal(g.filter((a) => a.action === 'mute').length, 2);
  assert.ok(skippedSeconds(pg13) > 60 + 25);
});

test('machine segments are suggestions unless confident and enabled', () => {
  const ai = seg(10, 20, 'sex', 3, { source: 'subtitles', confidence: 0.5 });
  const p = { preset: 'PG' };
  assert.equal(buildPlan([ai], p).flagged[0].decision, 'suggested');
  assert.equal(buildPlan([ai], { ...p, ai: { enabled: true, minConfidence: 0.4 } }).flagged[0].decision, 'filter');
  assert.equal(buildPlan([{ ...ai, confidence: 0.99 }], { ...p, ai: { enabled: false } }).flagged[0].decision, 'suggested');
});

test('published list overrides include/exclude specific segments', () => {
  const tags = [seg(10, 20, 'violence', 1), seg(30, 40, 'violence', 3)];
  const { flagged, actions } = buildPlan(tags, { preset: 'PG-13' }, { overrides: { include: ['violence-10'], exclude: ['violence-30'] } });
  assert.deepEqual(flagged.map((f) => f.decision), ['filter', 'allowed-by-list']);
  assert.equal(actions.length, 1);
});

test('mergeRegions merges near-adjacent skips and drops mutes inside skips', () => {
  const regions = mergeRegions([
    { start: 0, end: 10, action: 'skip', segmentIds: ['a'], reasons: [{ category: 'sex', severity: 3 }] },
    { start: 11, end: 15, action: 'skip', segmentIds: ['b'], reasons: [{ category: 'sex', severity: 2 }] },
    { start: 3, end: 4, action: 'mute', segmentIds: ['c'], reasons: [{ category: 'language', severity: 3 }] },
    { start: 30, end: 31, action: 'mute', segmentIds: ['d'], reasons: [{ category: 'language', severity: 3 }] },
  ]);
  assert.equal(regions.length, 2);
  assert.deepEqual([regions[0].start, regions[0].end], [0, 15]);
  assert.deepEqual(regions[0].reasons, [{ category: 'sex', severity: 3 }]);
});

test('decide: skip, chained skip, mute, blur, disabled, lead', () => {
  const actions = mergeRegions([
    { start: 10, end: 20, action: 'skip', segmentIds: ['a'], reasons: [] },
    { start: 25, end: 30, action: 'skip', segmentIds: ['x'], reasons: [] },
    { start: 50, end: 52, action: 'mute', segmentIds: ['b'], reasons: [] },
    { start: 60, end: 70, action: 'blur', segmentIds: ['c'], reasons: [] },
  ]);
  assert.equal(decide(5, actions).skipTo, null);
  assert.equal(decide(9.9, actions).skipTo, 20); // lead
  assert.equal(decide(15, actions).skipTo, 20);
  assert.equal(decide(20, actions).skipTo, null);
  assert.equal(decide(51, actions).mute, true);
  assert.equal(decide(65, actions).blur, true);
  assert.equal(decide(15, actions, { disabled: new Set([actions[0].key]) }).skipTo, null);
  // chain: a region whose end lands inside another skip region
  const chained = [
    { key: 'a', start: 0, end: 10, action: 'skip' },
    { key: 'b', start: 9, end: 18, action: 'skip' },
  ];
  assert.equal(decide(1, chained).skipTo, 18);
});

test('subtitle timestamps', () => {
  assert.equal(parseClock('01:02:03.5'), 3723.5);
  assert.equal(parseClock('02:03,250'), 123.25);
  assert.equal(parseTTMLTime('15000000t'), 1.5);
  assert.equal(parseTTMLTime('1500ms'), 1.5);
  assert.equal(parseTTMLTime('00:00:01:15', { frameRate: 30 }), 1.5);
  assert.equal(parseTTMLTime('2.5s'), 2.5);
});

test('parse Netflix DFXP (ticks, spans, br, entities)', () => {
  const xml = fixture('netflix-sample.dfxp');
  assert.equal(detectFormat(xml), 'ttml');
  assert.equal(ttmlLanguage(xml), 'en');
  const cues = parseSubtitles(xml);
  assert.equal(cues.length, 8);
  assert.deepEqual(cues[1], { start: 5, end: 8, text: 'What the fuck\nis that?' });
  assert.equal(cues[7].text, 'Tom & Jerry, the class assignment.');
});

test('parse WebVTT and SRT', () => {
  const vtt = parseSubtitles(fixture('sample.vtt'));
  assert.equal(vtt.length, 3);
  assert.equal(vtt[0].text, 'Winter is coming.');
  const srt = parseSubtitles('1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,500\r\n<i>Shit.</i>\r\n');
  assert.deepEqual(srt[1], { start: 3, end: 4.5, text: 'Shit.' });
});

test('profanity matching respects word boundaries', () => {
  const words = (s) => findProfanity(s).map((h) => [h.word, h.severity]);
  assert.deepEqual(words('Hello class, pass the assessment.'), []);
  assert.deepEqual(words("Shut the fuck up, you dumbass"), [['fuck', 3], ['dumbass', 2]]);
  assert.deepEqual(words("Fuckin' hell"), [["Fuckin'", 3], ['hell', 1]]);
  assert.deepEqual(words('Goddamn it'), [['Goddamn', 2]]);
  assert.equal(findProfanity('god damn it').length, 1);
  assert.deepEqual(splitCue('[gunfire]\nJON: Get down!').sounds, ['gunfire']);
});

test('analyzer: language segments and clustered scene hints', () => {
  const segs = analyzeCues(parseSubtitles(fixture('netflix-sample.dfxp')));
  const byCat = (c) => segs.filter((s) => s.category === c);
  assert.equal(byCat('language').length, 1);
  assert.equal(byCat('language')[0].severity, 3);
  assert.deepEqual([byCat('language')[0].start, byCat('language')[0].end], [5, 8]);
  // three sex hints 40–50s cluster into one scene with compounded confidence
  const sex = byCat('sex');
  assert.equal(sex.length, 1);
  assert.equal(sex[0].severity, 3);
  assert.ok(sex[0].confidence > 0.8, `confidence ${sex[0].confidence}`);
  assert.ok(sex[0].start <= 40 && sex[0].end >= 50);
  assert.equal(byCat('gore').length, 1);
  assert.equal(byCat('violence').length, 1);
  assert.ok(segs.every((s) => s.source === 'subtitles'));
});

test('analyzer word mode narrows the mute window', () => {
  const cues = [{ start: 10, end: 16, text: 'I told you a hundred times already, you bastard' }];
  const [line] = analyzeCues(cues);
  const [word] = analyzeCues(cues, { languageMode: 'word' });
  assert.deepEqual([line.start, line.end], [10, 16]);
  assert.ok(word.start > 13 && word.end <= 16, JSON.stringify(word));
});

test('Netflix manifest + metadata extraction', () => {
  const manifest = {
    result: {
      timedtexttracks: [
        { language: 'es', ttDownloadables: { 'dfxp-ls-sdh': { urls: [{ url: 'https://x/es' }] } } },
        { language: 'en', isForcedNarrative: true, ttDownloadables: { 'dfxp-ls-sdh': { urls: [{ url: 'https://x/forced' }] } } },
        { language: 'en', trackType: 'PRIMARY', rawTrackType: 'subtitles', ttDownloadables: { 'webvtt-lssdh-ios8': { downloadUrls: { 1: 'https://x/en.vtt' } } } },
        { language: 'en', trackType: 'CLOSEDCAPTIONS', ttDownloadables: { 'dfxp-ls-sdh': { urls: [{ url: 'https://x/en-cc.dfxp' }] } } },
        { isNoneTrack: true },
      ],
    },
  };
  const tracks = extractNetflixTimedText(manifest);
  assert.deepEqual(tracks.map((t) => t.url), ['https://x/en-cc.dfxp', 'https://x/en.vtt']);
  const meta = extractNetflixMetadata({
    video: { type: 'show', title: 'Game of Thrones', seasons: [{ seq: 1, episodes: [{ id: 70248288, seq: 1, title: 'Winter Is Coming', runtime: 3700 }] }] },
  });
  assert.deepEqual(meta['70248288'], { type: 'episode', series: 'Game of Thrones', season: 1, episode: 1, name: 'Winter Is Coming', runtime: 3700 });
  assert.deepEqual(extractNetflixMetadata(null), {});
  assert.deepEqual(extractNetflixTimedText({ nope: 1 }), []);
});

test('Netflix v2+ manifests: textTracks, downloadables, tracks sent without links', async () => {
  const { netflixManifestInfo } = await import('../shared/sources.js');
  // The shape the current player requests (manifestVersion v2-v4), as a PBO response.
  const pbo = {
    version: 2,
    result: {
      movieId: 81234567,
      manifestVersion: 'v4',
      textTracks: [
        { id: 'A', language: 'en', trackType: 'CLOSEDCAPTIONS', rawTrackType: 'closedcaptions', hydrated: true,
          downloadables: { 'imsc1.1': { urls: [{ cdnId: 3, url: 'https://cdn/en-cc' }] }, 'nflx-cmisc': { urls: [{ cdnId: 3, url: 'https://cdn/img' }] } } },
        { id: 'B', language: 'en', trackType: 'PRIMARY', rawTrackType: 'subtitles', hydrated: false, downloadables: {} },
        { id: 'C', language: 'de', trackType: 'PRIMARY', hydrated: true, downloadables: { 'imsc1.1': { urls: [{ url: 'https://cdn/de' }] } } },
        { id: 'none', isNoneTrack: true },
      ],
    },
  };
  const info = netflixManifestInfo(pbo);
  assert.equal(info.movieId, '81234567');
  assert.deepEqual(info.tracks.map((t) => [t.url, t.format, t.sdh]), [['https://cdn/en-cc', 'imsc1.1', true]]);
  assert.equal(info.available, 2);
  assert.equal(info.dehydrated, 1);
  assert.deepEqual(extractNetflixTimedText(pbo.result).map((t) => t.url), ['https://cdn/en-cc']);
  // English listed but sent without links (subtitles off): nothing to fetch yet, and we can say why.
  const off = netflixManifestInfo({ result: { movieId: 1, textTracks: [{ language: 'en', hydrated: false, downloadables: {} }] } });
  assert.deepEqual([off.tracks.length, off.available, off.dehydrated], [0, 1, 1]);
  assert.equal(netflixManifestInfo({ result: { ok: true } }).movieId, null);
});

test('Prime playback resources extraction', () => {
  const json = {
    timedTextUrls: { result: { subtitleUrls: [
      { url: 'https://p/fr.ttml2', languageCode: 'fr-fr', type: 'subtitle' },
      { url: 'https://p/en.ttml2', languageCode: 'en-us', type: 'subtitle' },
      { url: 'https://p/en-sdh.ttml2', languageCode: 'en-us', type: 'sdh' },
    ] } },
    catalogMetadata: {
      catalog: { id: 'B0EP', type: 'EPISODE', title: 'Pilot', episodeNumber: 1, runtimeSeconds: 3000 },
      family: { tvAncestors: [{ catalog: { type: 'SEASON', seasonNumber: 2 } }, { catalog: { type: 'SHOW', title: 'The Boys' } }] },
    },
  };
  assert.deepEqual(extractPrimeSubtitles(json).map((s) => s.url), ['https://p/en-sdh.ttml2', 'https://p/en.ttml2']);
  assert.deepEqual(extractPrimeTitle(json), { asin: 'B0EP', type: 'episode', name: 'Pilot', series: 'The Boys', season: 2, episode: 1, runtime: 3000 });
  assert.ok(looksLikeSubtitle('﻿<?xml version="1.0"?><tt xmlns="x">'));
  assert.ok(looksLikeSubtitle('WEBVTT\n\n'));
  assert.ok(!looksLikeSubtitle('{"json":true}'));
});

test('identity helpers', () => {
  assert.equal(canonicalKey({ series: 'Game of Thrones', season: 1, episode: 9 }), 'game-of-thrones/s01e09');
  assert.equal(canonicalKey({ name: 'Amélie', year: 2001 }), 'amelie-2001');
  assert.deepEqual(parseEpisodeLabel('S1:E3 Lord Snow'), { season: 1, episode: 3, rest: 'Lord Snow' });
  assert.deepEqual(parseEpisodeLabel('Season 2, Ep. 10 Valar Morghulis'), { season: 2, episode: 10, rest: 'Valar Morghulis' });
  assert.equal(parseEpisodeLabel('Movie'), null);
  assert.equal(slug('Tom & Jerry!'), 'tom-and-jerry');
  assert.equal(formatTime(3725), '1:02:05');
});

test('validateSegment', () => {
  assert.equal(validateSegment({ start: 1, end: 2, category: 'sex', severity: 3 }).ok, true);
  assert.equal(validateSegment({ start: 2, end: 1, category: 'sex', severity: 3 }).ok, false);
  assert.equal(validateSegment({ start: 1, end: 2, category: 'porn', severity: 3 }).ok, false);
  assert.equal(validateSegment({ start: 1, end: 2, category: 'sex', severity: 4 }).ok, false);
  assert.equal(validateSegment({ start: 1, end: 2, category: 'sex', severity: 3, action: 'delete' }).ok, false);
  assert.equal(validateSegment({ start: 1, end: 2, category: 'sex', severity: 2, note: 'x'.repeat(999) }).segment.note.length, 280);
});

test('mayMatter lets nearly every request through untouched', async () => {
  const { mayMatter } = await import('../shared/sources.js');
  const nf = 'www.netflix.com';
  assert.ok(mayMatter('https://www.netflix.com/nq/website/memberapi/v1/metadata?movieid=1', nf));
  assert.ok(mayMatter('https://www.netflix.com/playapi/cadmium/licensedmanifest/1?reqName=prefetch/licensedManifest', nf));
  assert.ok(mayMatter('/msl/playapi/cadmium/manifest/1', nf));
  assert.ok(!mayMatter('https://www.netflix.com/playapi/cadmium/event/1?reqName=events/start&x=manifest', nf));
  assert.ok(!mayMatter('https://www.netflix.com/nq/website/memberapi/v1/pathEvaluator?original_path=/shakti/subtitles', nf));
  assert.ok(!mayMatter('https://ipv4-c1.oca.nflxvideo.net/range/0-99?o=1&v=5', nf));
  assert.ok(!mayMatter('https://logs.netflix.com/log/www/cl/2', nf));
  const pv = 'www.primevideo.com';
  assert.ok(mayMatter('https://atv-ps.primevideo.com/cdp/catalog/GetPlaybackResources?asin=B0', pv));
  assert.ok(mayMatter('https://cf.example.net/abc/en.ttml2', pv));
  assert.ok(!mayMatter('https://www.primevideo.com/api/getDetailPage', pv));
  assert.ok(mayMatter('/demo-playback.json', 'localhost'));
});

test('classifyResponse reads only what the extension needs', async () => {
  const { classifyResponse } = await import('../shared/sources.js');
  const nf = 'www.netflix.com';
  // Netflix player data
  assert.equal(classifyResponse('https://www.netflix.com/nq/website/memberapi/v1/metadata?movieid=1', nf), 'json');
  assert.equal(classifyResponse('https://www.netflix.com/playapi/cadmium/licensedmanifest/1', nf), 'json');
  // Netflix noise: GraphQL / browse JSON, events, media
  assert.equal(classifyResponse('https://web.prod.cloud.netflix.com/graphql', nf, { contentType: 'application/json' }), null);
  assert.equal(classifyResponse('https://www.netflix.com/playapi/cadmium/event/1?playbackcontextid=x', nf, { contentType: 'application/json' }), null);
  assert.equal(classifyResponse('https://ipv4-c1.oca.nflxvideo.net/range/0-99?o=1&v=5', nf, { contentType: 'application/octet-stream', binary: true }), null);
  assert.equal(classifyResponse('https://ipv4-c1.oca.nflxvideo.net/range/0-99?o=1&v=5', nf, { contentType: '', binary: true }), 'peek');
  assert.equal(classifyResponse('https://ipv4-c1.oca.nflxvideo.net/range/0-99?o=1&v=5', nf, { contentType: 'application/x-binary', binary: true }), null);
  assert.equal(classifyResponse('https://ipv4-c1.oca.nflxvideo.net/range/0-99?o=1&v=5', nf, { contentType: '', binary: true, length: 9e6 }), null);
  assert.equal(classifyResponse('https://ipv4-c1.oca.nflxvideo.net/?o=1&v=5', nf, { contentType: 'text/xml' }), 'subtitle');
  // Prime
  const pv = 'www.primevideo.com';
  assert.equal(classifyResponse('https://atv-ps.primevideo.com/cdp/catalog/GetPlaybackResources?asin=B0', pv), 'json');
  assert.equal(classifyResponse('https://cf.example.net/abc/en.ttml2', pv), 'subtitle');
  assert.equal(classifyResponse('https://www.primevideo.com/api/getDetailPage', pv, { contentType: 'application/json' }), null);
  // demo page
  assert.equal(classifyResponse('/demo-playback.json', 'localhost'), 'json');
  assert.equal(classifyResponse('/demo.vtt', 'localhost', { contentType: 'text/vtt' }), 'subtitle');
});
