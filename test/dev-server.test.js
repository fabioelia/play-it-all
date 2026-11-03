import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDevServer } from '../scripts/dev-server.mjs';

let server, base;
before(async () => {
  server = createDevServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('serves the catalog with CORS', async () => {
  const res = await fetch(`${base}/catalog/index.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal((await res.json()).version, 1);
});

test('refuses paths outside its folders', async () => {
  for (const p of ['/catalog/../package.json', '/catalog/%2e%2e/package.json', '/../package.json', '/%2e%2e/package.json']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

test('byte ranges (video seeking)', async () => {
  const text = await (await fetch(`${base}/demo.vtt`)).text();
  const part = await fetch(`${base}/demo.vtt`, { headers: { Range: 'bytes=0-5' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), text.slice(0, 6));
  const suffix = await fetch(`${base}/demo.vtt`, { headers: { Range: 'bytes=-4' } });
  assert.equal(await suffix.text(), text.slice(-4));
  assert.equal((await fetch(`${base}/demo.vtt`, { headers: { Range: 'bytes=999999-' } })).status, 416);
});
