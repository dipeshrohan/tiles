import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTilesServer } from '../server.js';

let server;
let base;

before(async () => {
  server = createTilesServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('serves index.html at the root with an html content type', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<title>Tiles<\/title>/);
});

test('serves the bundle as javascript', async () => {
  const res = await fetch(`${base}/js/tiles.bundle.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('returns 404 for missing files', async () => {
  assert.equal((await fetch(`${base}/nope.js`)).status, 404);
});

test('never serves files outside the project folder', async () => {
  for (const path of [
    '/../../../../etc/hostname',
    '/..%2f..%2f..%2f..%2fetc%2fhostname',
    '/%2e%2e/%2e%2e/etc/hostname',
  ]) {
    const res = await fetch(`${base}${path}`);
    assert.notEqual(res.status, 200, path);
  }
});

test('returns 400 for a malformed URL and keeps serving', async () => {
  assert.equal((await fetch(`${base}/%E0`)).status, 400);
  assert.equal((await fetch(`${base}/`)).status, 200);
});
