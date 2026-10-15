// The catalogues as the page loads them (U6.01): js/messages-<code>.js, made from js/i18n/<code>.json.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileOf, generate, locales } from '../scripts/messages.js';

test('each js/messages-<code>.js is made from its catalogue as it is now (run npm run build)', () => {
  assert.ok(locales().includes('en'));
  for (const code of locales())
    assert.equal(readFileSync(new URL(`../js/${fileOf(code)}`, import.meta.url), 'utf8'), generate(code), code);
});

test('a catalogue script adds its messages to window.TILES_MESSAGES, and nothing else', () => {
  const window = { TILES_MESSAGES: { xx: { a: 'b' } } };
  new Function('window', generate('en'))(window);
  assert.equal(window.TILES_MESSAGES.xx.a, 'b');
  assert.equal(window.TILES_MESSAGES.en['common.help'], 'Help');
  // The page loads it before the bundle.
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('js/messages-en.js') < html.indexOf('js/tiles.bundle.js'));
});
