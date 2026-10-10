import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { createTilesServer, securityHeaders } from '../server.js';

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

test('the API address of a deployment goes into the page, escaped', async () => {
  const deployed = createTilesServer({ apiUrl: 'https://api.example.com/?a="b"&c' });
  await new Promise((resolve) => deployed.listen(0, resolve));
  try {
    const at = `http://127.0.0.1:${deployed.address().port}`;
    for (const path of ['/', '/index.html']) {
      const html = await (await fetch(at + path)).text();
      assert.match(html, /<meta name="tiles-api" content="https:\/\/api\.example\.com\/\?a=&quot;b&quot;&amp;c" \/>/);
    }
  } finally {
    deployed.close();
  }
  // Without one, the page keeps the empty tag (as from file://), and the app stays local.
  assert.match(await (await fetch(`${base}/`)).text(), /<meta name="tiles-api" content="" \/>/);
  assert.throws(() => createTilesServer({ apiUrl: 'javascript:alert(1)' }), /Not an http\(s\) URL/);
});

test('every answer carries the security headers (threat model G-B1)', async () => {
  for (const path of ['/', '/js/tiles.bundle.js', '/nope.js']) {
    const res = await fetch(`${base}${path}`);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'(;|$)/); // no inline scripts, no eval
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'self' blob:(;|$)/); // a document's PDF, nothing from elsewhere
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer'); // the sign-in code never leaves in a referrer
  }
  // The page has no inline script for the policy to block.
  const html = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  // The API may be plain http on a plant's network (a local cluster, or one a user picks).
  assert.match(securityHeaders()['content-security-policy'], /connect-src 'self' https: http:(;|$)/);
});
