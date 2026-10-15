// The language Tiles is shown in: chosen, loaded, and the pseudo-locale (U6.03).
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chosenLanguage, LANGUAGES, PSEUDO, pseudo, pseudoCatalogue, useLanguage } from '../js/lib/language.ts';
import { currentLocale, t } from '../js/lib/i18n.ts';
import { formatLocale, number } from '../js/lib/format.ts';
import { shape } from '../scripts/check-i18n.js';

afterEach(async () => {
  await useLanguage('en');
});

test('?lang= wins, then the one kept, then the browser’s, then English', () => {
  assert.equal(chosenLanguage('?lang=de', ['en-GB']), 'de');
  assert.equal(chosenLanguage('?lang=xx', ['fr-FR', 'de-AT']), 'de'); // unknown asked; German from the browser
  assert.equal(chosenLanguage('', ['fr-FR']), 'en');
  assert.equal(chosenLanguage(`?lang=${PSEUDO}`, []), PSEUDO);
  assert.deepEqual(
    LANGUAGES.map((l) => l.code),
    ['en', 'de'],
  );
});

test('German: its words, its numbers; English for a key it lacks', async () => {
  globalThis.TILES_MESSAGES.de = JSON.parse(readFileSync(new URL('../js/i18n/de.json', import.meta.url), 'utf8'));
  assert.equal(await useLanguage('de'), 'de');
  assert.equal(currentLocale(), 'de');
  assert.equal(t('common.help'), 'Hilfe');
  assert.equal(formatLocale(), 'de');
  assert.equal(number(12480.5, 1), '12.480,5');
  assert.equal(t('settings.language.title'), 'Sprache');
  delete globalThis.TILES_MESSAGES.de['common.help'];
  assert.equal(t('common.help'), 'Help');
});

test('a language that can’t be loaded leaves English', async () => {
  assert.equal(await useLanguage('fr'), 'en');
});

test('the pseudo-locale: accented, 40% longer, in brackets, its ICU structure intact', async () => {
  assert.equal(pseudo('Save'), '[Šàṽé ··]');
  const m = '{count, plural, one {# signal on {site}} other {# signals on {site}}}';
  const p = pseudo(m);
  assert.equal(shape(p), shape(m));
  assert.match(p, /^\[\{count, plural, one \{# šîĝñàĺ öñ \{site\}\} other \{# šîĝñàĺš öñ \{site\}\}\} ·+\]$/);
  // Every English message keeps its shape.
  const en = globalThis.TILES_MESSAGES.en;
  const fake = pseudoCatalogue(en);
  for (const k of Object.keys(en)) assert.equal(shape(fake[k]), shape(en[k]), k);
  assert.equal(await useLanguage(PSEUDO), PSEUDO);
  assert.equal(t('common.help'), pseudo('Help'));
  assert.equal(t('app.badge.openWarnings', { count: 2 }).includes('2'), true);
});

test('the latest choice wins: a slow catalogue arriving after another choice changes nothing', async () => {
  // A page whose German catalogue is still on its way.
  const de = globalThis.TILES_MESSAGES.de;
  delete globalThis.TILES_MESSAGES.de;
  let script;
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({}),
    head: { append: (s) => (script = s) },
    documentElement: {},
  };
  try {
    const slow = useLanguage('de');
    const fast = useLanguage('en');
    assert.equal(await fast, 'en');
    globalThis.TILES_MESSAGES.de = de ?? { 'common.help': 'Hilfe' };
    script.onload();
    assert.equal(await slow, null);
    assert.equal(currentLocale(), 'en');
  } finally {
    delete globalThis.document;
  }
});

test('the pseudo-locale is for one visit, written as English (en-GB), padded by what is seen', async () => {
  const kept = new Map();
  const hadWindow = 'window' in globalThis;
  globalThis.window ??= globalThis;
  globalThis.localStorage = {
    getItem: (k) => kept.get(k) ?? null,
    setItem: (k, v) => kept.set(k, String(v)),
    removeItem: (k) => kept.delete(k),
  };
  try {
    const { load } = await import('../js/lib/store.ts');
    chosenLanguage('?lang=de', []);
    assert.equal(chosenLanguage(`?lang=${PSEUDO}`, []), PSEUDO);
    assert.equal(load('language', null), 'de'); // kept as it was
    assert.equal(chosenLanguage('', []), 'de');
  } finally {
    delete globalThis.localStorage;
    if (!hadWindow) delete globalThis.window;
  }
  await useLanguage(PSEUDO);
  assert.equal(formatLocale(), 'en-GB');
  // A plural pads by its longest option, not its syntax: "# signals on " is what is seen.
  const p = pseudo('{count, plural, one {# signal on {site}} other {# signals on {site}}}');
  assert.equal(p.match(/·+/)[0].length, Math.round('# signals on '.length * 0.4));
});
