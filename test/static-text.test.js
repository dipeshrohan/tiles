// index.html's fixed words (U6.01): each element names its message, put in at start-up.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translateStatic } from '../js/lib/static-text.ts';
import { addCatalogue, setLocale } from '../js/lib/i18n.ts';
import en from '../js/i18n/en.json';

// Just enough of the DOM: elements with attributes and text, found by `[attr]`.
function el(attrs, text = '') {
  const a = new Map(Object.entries(attrs));
  return {
    textContent: text,
    getAttribute: (k) => a.get(k) ?? null,
    setAttribute: (k, v) => a.set(k, v),
    hasAttribute: (k) => a.has(k),
  };
}
const rootOf = (els) => ({
  querySelectorAll: (sel) => els.filter((e) => e.hasAttribute(/^\[(.+)\]$/.exec(sel)[1])),
});

test('text, labels, titles and tooltips come from the catalogue', () => {
  addCatalogue('xx', { 'app.static.skip': 'Zum Inhalt', 'app.static.theme': 'Thema', 'app.static.menu': 'Menü' });
  setLocale('xx');
  try {
    const skip = el({ 'data-i18n': 'app.static.skip' }, 'Skip to content');
    const theme = el(
      {
        'aria-label': 'Toggle light or dark theme',
        'data-i18n-label': 'app.static.theme',
        'data-i18n-tooltip': 'app.static.menu',
      },
      '',
    );
    const titled = el({ title: 'Old', 'data-i18n-title': 'app.static.theme' });
    const unknown = el(
      { 'data-i18n': 'app.static.nothing', 'data-i18n-label': 'nope.nope', 'aria-label': 'Kept' },
      'Kept',
    );
    translateStatic(rootOf([skip, theme, titled, unknown]));
    assert.equal(skip.textContent, 'Zum Inhalt');
    assert.equal(theme.getAttribute('aria-label'), 'Thema');
    assert.equal(theme.getAttribute('data-tooltip'), 'Menü');
    assert.equal(theme.textContent, ''); // a label alone leaves the text
    assert.equal(titled.getAttribute('title'), 'Thema');
    // A key no catalogue has leaves the element as it was.
    assert.equal(unknown.textContent, 'Kept');
    assert.equal(unknown.getAttribute('aria-label'), 'Kept');
  } finally {
    setLocale('en');
  }
});

test("index.html's keys are in the catalogue, and its English is the catalogue's", () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const tags = [...html.matchAll(/<[a-z]+\b[^>]*\bdata-i18n[^>]*>/g)].map((m) => m[0]);
  assert.ok(tags.length >= 8);
  const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  for (const tag of tags) {
    for (const [data, target] of [
      ['data-i18n-label', 'aria-label'],
      ['data-i18n-title', 'title'],
      ['data-i18n-tooltip', 'data-tooltip'],
    ]) {
      const key = attr(tag, data);
      if (key) assert.equal(en[key], attr(tag, target), `${key} in ${tag}`);
    }
    const key = attr(tag, 'data-i18n');
    if (key) {
      assert.ok(key in en, key);
      const after = html.slice(html.indexOf(tag) + tag.length);
      assert.equal(after.slice(0, after.indexOf('<')), en[key], key);
    }
  }
});
