import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, convertTime, listsFor, lookup, mergeSubmission, parseSubmission, pathForKey,
  segmentId, segmentsFor, validateEpisode, validateList, validateShow,
} from '../shared/catalog.js';

// Synthetic cue timings (not real subtitle data): ~1 cue every 4 s.
const cues = Array.from({ length: 400 }, (_, i) => 20 + i * 4 + ((i * 7919) % 13) / 10);
const nf = { platform: 'netflix', platformId: '70248288', series: 'Game of Thrones', season: 1, episode: 1, name: 'Winter Is Coming', runtime: 3720 };
const sub = (title, segments, sync) => ({ cleancut: 1, title, segments, ...(sync ? { sync } : {}) });

test('paths and ids', () => {
  assert.equal(pathForKey('game-of-thrones/s01e01'), 'shows/game-of-thrones/s01e01.json');
  assert.equal(pathForKey('the-matrix-1999'), 'movies/the-matrix-1999.json');
  assert.throws(() => pathForKey('../etc/passwd'));
  const s = { on: 'netflix', category: 'sex', start: 10, end: 20 };
  assert.equal(segmentId(s), segmentId({ ...s }));
  assert.notEqual(segmentId(s), segmentId({ ...s, start: 11 }));
});

test('first submission creates the episode on the submitting platform\'s timeline', () => {
  const r = mergeSubmission(null, sub(nf, [
    { start: 1210, end: 1290, category: 'sex', severity: 3, note: 'brothel' },
    { start: 300, end: 302, category: 'language', severity: 3 },
  ], cues), { author: 'alice' });
  assert.equal(r.created, true);
  assert.equal(r.key, 'game-of-thrones/s01e01');
  assert.equal(r.platformStatus, 'reference');
  const ep = r.episode;
  assert.equal(ep.timeline, 'netflix');
  assert.deepEqual(ep.platforms.netflix, { id: '70248288', offset: 0, speed: 1 });
  assert.equal(ep.segments.length, 2);
  assert.equal(ep.segments[0].start, 300); // sorted
  assert.equal(ep.segments[1].by, 'alice');
  assert.equal(ep.segments[1].on, 'netflix');
  assert.ok(ep.sync.cues.length > 300);
  assert.deepEqual(validateEpisode(ep, 'catalog/shows/game-of-thrones/s01e01.json'), []);
});

test('same episode from Prime: clock measured from subtitles, tags shared both ways', () => {
  const base = mergeSubmission(null, sub(nf, [{ start: 1210, end: 1290, category: 'sex', severity: 3 }], cues)).episode;
  // Prime's encode runs 12.4 s later (a studio logo, say).
  const prime = { ...nf, platform: 'prime', platformId: 'B007ABC' };
  const r = mergeSubmission(base, sub(prime, [
    { start: 1222.6, end: 1302.2, category: 'sex', severity: 3 },          // the same scene: a duplicate
    { start: 2012.4, end: 2032.4, category: 'violence', severity: 3 },     // a new one, timed on Prime
  ], cues.map((c) => c + 12.4)), { author: 'bob' });
  assert.equal(r.platformStatus, 'aligned');
  assert.ok(Math.abs(r.episode.platforms.prime.offset - 12.4) < 0.1);
  assert.equal(r.added, 1);
  assert.equal(r.duplicates, 1);

  const onNetflix = segmentsFor(r.episode, 'netflix');
  assert.equal(onNetflix.timing, 'native');
  const v = onNetflix.segments.find((s) => s.category === 'violence');
  assert.ok(Math.abs(v.start - 2000) < 0.15, `violence on Netflix at ${v.start}`);
  const onPrime = segmentsFor(r.episode, 'prime');
  assert.equal(onPrime.timing, 'synced');
  const s = onPrime.segments.find((x) => x.category === 'sex');
  assert.ok(Math.abs(s.start - 1222.4) < 0.15, `sex on Prime at ${s.start}`);
});

test('a platform without subtitle timing stays unsynced; its own tags still work on it', () => {
  const base = mergeSubmission(null, sub(nf, [{ start: 100, end: 110, category: 'gore', severity: 3 }], cues)).episode;
  const web = { ...nf, platform: 'web', platformId: 'example.com/got/1' };
  const r = mergeSubmission(base, sub(web, [{ start: 500, end: 510, category: 'drugs', severity: 2 }]));
  assert.equal(r.platformStatus, 'unsynced');
  assert.equal(r.episode.platforms.web.offset, null);
  const onWeb = segmentsFor(r.episode, 'web');
  assert.equal(onWeb.timing, 'unsynced');
  // Its own tag is native; the Netflix one is offered on the reference clock for manual sync.
  assert.deepEqual(onWeb.segments.map((x) => x.category).sort(), ['drugs', 'gore']);
  // Netflix cannot use the web tag until the web clock is known.
  const onNetflix = segmentsFor(r.episode, 'netflix');
  assert.equal(onNetflix.skipped, 1);
  // A device that measures the web clock itself can use everything, converted.
  const measured = segmentsFor(r.episode, 'web', { offset: 30 });
  assert.equal(measured.timing, 'aligned');
  assert.equal(measured.segments.find((x) => x.category === 'gore').start, 130);
  assert.equal(measured.segments.find((x) => x.category === 'drugs').start, 500);
});

test('unknown platform with a measured offset', () => {
  const ep = mergeSubmission(null, sub(nf, [{ start: 100, end: 110, category: 'gore', severity: 3 }], cues)).episode;
  const r = segmentsFor(ep, 'prime', { offset: -5, speed: 1 });
  assert.equal(r.timing, 'aligned');
  assert.deepEqual([r.segments[0].start, r.segments[0].end], [95, 105]);
  assert.ok(Math.abs(convertTime(10, { offset: 0, speed: 1 }, { offset: 2, speed: 23.976 / 25 }) - (10 * 23.976 / 25 + 2)) < 1e-9);
});

test('conflicting platform ids and bad input are rejected', () => {
  const ep = mergeSubmission(null, sub(nf, [{ start: 1, end: 2, category: 'gore', severity: 1 }])).episode;
  assert.throws(() => mergeSubmission(ep, sub({ ...nf, platformId: '999' }, [{ start: 1, end: 2, category: 'gore', severity: 1 }])), /already has id/);
  assert.throws(() => mergeSubmission(null, sub({ ...nf, platform: 'betamax' }, [{ start: 1, end: 2, category: 'gore', severity: 1 }])), /platform/);
  assert.throws(() => mergeSubmission(null, sub(nf, [{ start: 5, end: 2, category: 'gore', severity: 1 }])), /segments\[0\]/);
  assert.throws(() => mergeSubmission(null, sub({ platform: 'netflix', platformId: '1' }, [{ start: 1, end: 2, category: 'gore', severity: 1 }])), /title needs/);
});

test('parseSubmission reads an issue-form body', () => {
  const body = '### Tags\n\n```json\n{ "cleancut": 1, "title": {"platform":"netflix"}, "segments": [] }\n```\n\n### Notes\n\n_No response_';
  assert.equal(parseSubmission(body).title.platform, 'netflix');
  assert.throws(() => parseSubmission('hello'), /valid JSON/);
  assert.throws(() => parseSubmission('{"a":1}'), /not a CleanCut submission/);
});

test('index: platform ids, names across services, movies without year, lists', () => {
  const got1 = mergeSubmission(null, sub(nf, [{ start: 1, end: 2, category: 'sex', severity: 3 }], cues)).episode;
  const got1b = mergeSubmission(got1, sub({ ...nf, platform: 'prime', platformId: 'B007ABC' }, [{ start: 50, end: 60, category: 'gore', severity: 2 }], cues.map((c) => c + 3))).episode;
  const film = mergeSubmission(null, sub({ platform: 'prime', platformId: 'B0FILM', name: 'Example Film', year: 2001 }, [{ start: 1, end: 2, category: 'language', severity: 1 }])).episode;
  const index = buildIndex({
    shows: { 'game-of-thrones': { name: 'Game of Thrones', year: 2011, aliases: ['Game of Thrones (HBO)'] } },
    episodes: [got1b, film],
    lists: [
      { id: 'family-night', name: 'Family night', scope: '*', settings: { preset: 'PG' } },
      { id: 'got-teens', name: 'GoT for teens', scope: 'game-of-thrones', settings: { preset: 'PG-13' } },
      { id: 'other', name: 'Other', scope: 'other-show', settings: { preset: 'G' } },
    ],
  }, 'T');
  assert.deepEqual(index.counts, { shows: 1, movies: 1, episodes: 2, segments: 3, lists: 3 });
  assert.equal(index.platforms['netflix:70248288'], 'game-of-thrones/s01e01');
  assert.equal(index.platforms['prime:B007ABC'], 'game-of-thrones/s01e01');
  assert.deepEqual(index.titles['game-of-thrones'].episodes.s01e01.platforms, ['netflix', 'prime']);

  assert.equal(lookup(index, { platform: 'prime', platformId: 'B007ABC' }).via, 'platform');
  // A platform id the catalog has never seen, found by title…
  assert.deepEqual(lookup(index, { platform: 'netflix', platformId: 'new', canonicalKey: 'game-of-thrones/s01e01' }), { key: 'game-of-thrones/s01e01', path: 'shows/game-of-thrones/s01e01.json', via: 'title' });
  // …or by a name another service uses.
  assert.equal(lookup(index, { platform: 'web', platformId: 'x', canonicalKey: 'game-of-thrones-hbo/s01e01' }).via, 'alias');
  assert.equal(lookup(index, { platform: 'web', platformId: 'x', canonicalKey: 'game-of-thrones/s09e09' }), null);
  // Films: services rarely show the year.
  assert.equal(lookup(index, { platform: 'netflix', platformId: 'y', canonicalKey: 'example-film' }).key, 'example-film-2001');

  // Only lists made for the title: its show's or its own, not the all-titles ones.
  assert.deepEqual(listsFor(index, 'game-of-thrones/s01e01').map((l) => l.id), ['got-teens']);
  assert.deepEqual(listsFor(index, 'example-film-2001').map((l) => l.id), []);
  assert.deepEqual(listsFor(index, [null, 'game-of-thrones/s09e09']).map((l) => l.id), ['got-teens']); // not in the catalog yet, known by name
  assert.deepEqual(listsFor(index, null), []);
});

test('validators', () => {
  assert.deepEqual(validateShow({ name: 'X' }), []);
  assert.ok(validateShow({}).length);
  assert.deepEqual(validateList({ id: 'family-night', name: 'Family night', scope: '*', settings: {} }, 'catalog/lists/family-night.json'), []);
  assert.ok(validateList({ id: 'x', name: 'n', scope: '?', settings: null }).length >= 3);
  const ep = mergeSubmission(null, sub(nf, [{ start: 1, end: 2, category: 'sex', severity: 3 }])).episode;
  assert.match(validateEpisode(ep, 'catalog/shows/wrong/s01e01.json')[0], /belongs in/);
  assert.match(validateEpisode({ ...ep, timeline: 'prime' }).join(), /timeline/);
  assert.match(validateEpisode({ ...ep, segments: [...ep.segments, ep.segments[0]] }).join(), /duplicate id/);
});

test('machine-detected tags keep their source and confidence', () => {
  const r = mergeSubmission(null, sub(nf, [
    { start: 10, end: 20, category: 'nudity', severity: 2, source: 'scanner', confidence: 0.72 },
    { start: 30, end: 40, category: 'gore', severity: 3 },
  ]));
  const [scan, human] = r.episode.segments;
  assert.deepEqual([scan.source, scan.confidence], ['scanner', 0.72]);
  assert.equal(human.source, undefined);
  assert.equal(segmentsFor(r.episode, 'netflix').segments[1].source, 'community');
});
