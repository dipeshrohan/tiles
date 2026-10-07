import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { committedBundle, freshBundle } from '../scripts/check-bundle.js';

test('committed bundle matches a fresh build of the sources', async () => {
  assert.equal(committedBundle(), await freshBundle(), 'js/tiles.bundle.js is stale: run `npm run build`');
}, 30_000);

test('bundle is a classic script, safe to load from file://', () => {
  const code = committedBundle();
  assert.doesNotMatch(code, /^\s*(import|export)\s/m);
});

test('index.html loads the classic bundle, not a module script', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="js\/tiles\.bundle\.js" defer><\/script>/);
  assert.doesNotMatch(html, /type="module"/);
});
