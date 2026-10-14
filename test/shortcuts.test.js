import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GO_KEYS, PAGE_KEYS, keyAttr, keyAttrs, keyLabel, shortcutsHtml } from '../js/lib/shortcuts.ts';

test('g reaches each page by its own letter, and every page it names exists', () => {
  const letters = GO_KEYS.map(([k]) => k);
  assert.equal(new Set(letters).size, letters.length, 'one page per letter');
  assert.equal(new Set(GO_KEYS.map(([, p]) => p)).size, GO_KEYS.length, 'one letter per page');
  for (const k of letters) assert.match(k, /^[a-z]$/);
  for (const [, page] of GO_KEYS) {
    const file = page === 'import' ? 'imports' : page;
    assert.match(readFileSync(new URL(`../js/views/${file}.ts`, import.meta.url), 'utf8'), new RegExp(`id: '${page}'`));
  }
});

test("a page's keys are not the ones moving through a list or going to a page", () => {
  const reserved = ['g', 'j', 'k', '?'];
  for (const [k] of PAGE_KEYS) assert.ok(!reserved.includes(k), k);
});

test('the list names each page g reaches, escaped, and the switch to turn them off', () => {
  const html = shortcutsHtml({ title: (p) => (p === 'warnings' ? 'Warnings <now>' : p === 'chat' ? null : p) }, false);
  assert.match(html, /<kbd>g<\/kbd> <kbd>w<\/kbd><\/th><td>Warnings &lt;now&gt;<\/td>/);
  assert.doesNotMatch(html, /<kbd>c<\/kbd>/, 'a page not in the menu is left out');
  assert.match(html, /Ctrl K/);
  assert.match(shortcutsHtml({ title: (p) => p }, true), /⌘ K/);
  assert.match(html, /data-single-keys checked/);
  assert.match(html, /<caption>On a page<\/caption>/);
});

test('buttons and fields name their key while shortcuts are on (storage aside, they are)', () => {
  assert.deepEqual(keyAttrs('a'), { 'aria-keyshortcuts': 'a' });
  assert.equal(keyAttr('/'), ' aria-keyshortcuts="/"');
  assert.equal(keyLabel(' '), 'Space');
  assert.equal(keyLabel('a'), 'a');
});
