import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundle } from '../build.js';

test('committed bundle matches the module sources', () => {
  const committed = readFileSync(new URL('../js/tiles.bundle.js', import.meta.url), 'utf8');
  assert.equal(committed, bundle(), 'js/tiles.bundle.js is stale: run `npm run build`');
});

test('index.html loads the classic bundle, not a module script', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="js\/tiles\.bundle\.js" defer><\/script>/);
  assert.doesNotMatch(html, /type="module"/);
});
