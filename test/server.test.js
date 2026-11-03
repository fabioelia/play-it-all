import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server/src/app.js';
import { openDb } from '../server/src/db.js';

let server, base;
before(async () => {
  server = createServer(createApp(openDb(':memory:'), { rateLimit: null }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function api(method, path, body, key) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

const got = { platform: 'netflix', platformId: '70248288', series: 'Game of Thrones', season: 1, episode: 1, name: 'Winter Is Coming', duration: 3720 };

test('full community flow', async () => {
  // accounts
  const alice = (await api('POST', '/v1/users', { name: 'alice' })).body;
  const bob = (await api('POST', '/v1/users', { name: 'bob' })).body;
  assert.match(alice.apiKey, /^cc_/);
  assert.equal((await api('GET', '/v1/me', null, alice.apiKey)).body.name, 'alice');
  assert.equal((await api('GET', '/v1/me', null, 'cc_wrong')).status, 401);
  assert.equal((await api('POST', '/v1/users', { name: '<script>' })).status, 400);

  // tagging needs auth and valid segments
  assert.equal((await api('POST', '/v1/segments', { title: got, segments: [{ start: 1, end: 2, category: 'sex', severity: 3 }] })).status, 401);
  const bad = await api('POST', '/v1/segments', { title: got, segments: [{ start: 5, end: 2, category: 'sex', severity: 3 }] }, alice.apiKey);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /segments\[0\]/);

  const added = await api('POST', '/v1/segments', {
    title: got,
    segments: [
      { start: 1210, end: 1290, category: 'sex', severity: 3, note: 'brothel scene' },
      { start: 3540, end: 3560, category: 'violence', severity: 2 },
      { start: 300, end: 302, category: 'language', severity: 3, action: 'mute' },
    ],
  }, alice.apiKey);
  assert.equal(added.status, 201);
  assert.equal(added.body.title.canonicalKey, 'game-of-thrones/s01e01');
  assert.equal(added.body.ids.length, 3);

  // lookup by platform id
  const look = (await api('GET', '/v1/lookup?platform=netflix&id=70248288')).body;
  assert.equal(look.segments.length, 3);
  assert.deepEqual(look.segments.map((s) => s.start), [300, 1210, 3540]);
  assert.equal(look.segments[0].author, 'alice');
  assert.equal(look.borrowedFrom, null);

  // same episode on Prime borrows Netflix timing via the canonical key
  const prime = (await api('GET', '/v1/lookup?platform=prime&id=B00ABC:s1e1&canonical=game-of-thrones/s01e01')).body;
  assert.equal(prime.segments.length, 3);
  assert.equal(prime.borrowedFrom.titleKey, 'netflix:70248288');

  // voting hides bad tags
  const sid = added.body.ids[1];
  for (const key of [alice.apiKey, bob.apiKey]) await api('POST', `/v1/segments/${sid}/vote`, { value: -1 }, key);
  assert.equal((await api('POST', `/v1/segments/${sid}/vote`, { value: 1 }, bob.apiKey)).body.score, 0);
  assert.equal((await api('POST', `/v1/segments/${sid}/vote`, { value: 5 }, bob.apiKey)).status, 400);

  // only the author can delete
  assert.equal((await api('DELETE', `/v1/segments/${added.body.ids[2]}`, null, bob.apiKey)).status, 403);
  assert.equal((await api('DELETE', `/v1/segments/${added.body.ids[2]}`, null, alice.apiKey)).status, 200);
  assert.equal((await api('GET', '/v1/lookup?platform=netflix&id=70248288')).body.segments.length, 2);

  // publish skip lists: one for this episode, one global
  const p1 = await api('POST', '/v1/profiles', {
    name: 'GoT family cut', description: 'PG-13, but keep the battle', settings: { preset: 'PG-13', actions: { violence: 'blur' } },
    title: got, overrides: { exclude: [sid] },
  }, bob.apiKey);
  assert.equal(p1.status, 201);
  assert.equal(p1.body.settings.thresholds.nudity, 0);
  assert.equal(p1.body.settings.actions.violence, 'blur');
  assert.equal(p1.body.titleKey, 'netflix:70248288');
  await api('POST', '/v1/profiles', { name: 'Strict G everywhere', settings: { preset: 'G' } }, alice.apiKey);
  assert.equal((await api('POST', '/v1/profiles', { name: 'x' }, alice.apiKey)).status, 400);

  const withProfiles = (await api('GET', '/v1/lookup?platform=netflix&id=70248288')).body;
  assert.deepEqual(withProfiles.profiles.map((p) => p.name), ['GoT family cut', 'Strict G everywhere']);
  assert.deepEqual(withProfiles.profiles[0].overrides.exclude, [sid]);
  // the episode-specific list is offered on Prime too (canonical match)
  const primeProfiles = (await api('GET', '/v1/profiles?canonical=game-of-thrones/s01e01')).body.profiles;
  assert.ok(primeProfiles.some((p) => p.name === 'GoT family cut'));

  assert.equal((await api('POST', `/v1/profiles/${p1.body.id}/subscribe`)).body.subscribers, 1);
  assert.equal((await api('GET', '/v1/profiles?q=family')).body.profiles.length, 1);

  // browse
  const titles = (await api('GET', '/v1/titles?q=thrones')).body.titles;
  assert.equal(titles[0].segmentCount, 2);
  assert.equal(titles[0].profileCount, 1);
});

test('errors: unknown route, bad json, big batch', async () => {
  assert.equal((await api('GET', '/v1/nope')).status, 404);
  const res = await fetch(`${base}/v1/users`, { method: 'POST', body: '{bad', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 400);
  const { apiKey } = (await api('POST', '/v1/users', { name: 'carol' })).body;
  const many = Array.from({ length: 501 }, (_, i) => ({ start: i, end: i + 1, category: 'language', severity: 1 }));
  assert.equal((await api('POST', '/v1/segments', { title: got, segments: many }, apiKey)).status, 413);
  assert.equal((await api('POST', '/v1/segments', { title: { platform: 'hulu', platformId: '1' }, segments: many.slice(0, 1) }, apiKey)).status, 400);
});
