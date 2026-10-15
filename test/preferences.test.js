// Preferences (U6.06): what was kept or sent, checked; as the API takes them; and the number format
// a person chose over their language's.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { cleanPreferences, DEFAULTS, NUMBER_FORMATS, samePreferences, toApi } from '../js/lib/preferences.ts';
import { chooseFormat, formatSample, number, setFormatLocale } from '../js/lib/format.ts';
import { browserLanguage } from '../js/lib/language.ts';

const o = { languages: ['en', 'de'], pages: ['home', 'warnings', 'signals'] };

test('preferences kept or sent keep only what is known; the rest default', () => {
  assert.deepEqual(cleanPreferences(null, o), DEFAULTS);
  assert.deepEqual(cleanPreferences('dark', o), DEFAULTS);
  const mine = {
    theme: 'dark',
    density: 'compact',
    language: 'de',
    numbers: 'en-US',
    timeZone: 'device',
    motion: 'reduce',
    shortcuts: false,
    start: 'warnings',
  };
  assert.deepEqual(cleanPreferences(mine, o), mine);
  // The API's names too (time_zone).
  assert.equal(cleanPreferences({ time_zone: 'device' }, o).timeZone, 'device');
  assert.deepEqual(
    cleanPreferences(
      {
        theme: 'blue',
        density: 'tiny',
        language: 'fr',
        numbers: 'xx-YY',
        timeZone: 'Europe/Berlin',
        motion: 'none',
        shortcuts: 'off',
        start: 'gone',
        extra: 1,
      },
      o,
    ),
    DEFAULTS,
  );
  // Home is where Tiles opens anyway: no start page.
  assert.equal(cleanPreferences({ start: 'home' }, o).start, null);
});

test('as the API takes them, and back', () => {
  const p = { ...DEFAULTS, timeZone: 'device', start: 'signals' };
  assert.deepEqual(toApi(p), {
    theme: 'system',
    density: 'comfortable',
    language: 'auto',
    numbers: 'auto',
    time_zone: 'device',
    motion: 'system',
    shortcuts: true,
    start: 'signals',
  });
  assert.deepEqual(cleanPreferences(toApi(p), o), p); // and back
  assert.ok(samePreferences(p, { ...p }));
  assert.ok(!samePreferences(p, DEFAULTS));
});

test('a number format chosen wins over the language’s, until it is cleared', () => {
  setFormatLocale('en');
  assert.equal(number(1234.5, 1), '1,234.5');
  chooseFormat('de-DE');
  assert.equal(number(1234.5, 1), '1.234,5');
  setFormatLocale('en'); // the language changes: the choice stays
  assert.equal(number(1234.5, 1), '1.234,5');
  chooseFormat(null);
  assert.equal(number(1234.5, 1), '1,234.5');
  setFormatLocale('de');
  assert.equal(number(1234.5, 1), '1.234,5');
  setFormatLocale('en');
});

test('each format offered is named in the page’s language and shown with an example', () => {
  const day = Date.UTC(2026, 9, 16, 12);
  assert.deepEqual(formatSample('en-US', day), { name: 'English (United States)', sample: '1,234.5 · 10/16/26' });
  chooseFormat('de-DE'); // numbers in German, the page in English: still named in English
  assert.equal(formatSample('de-CH', day).name, 'German (Switzerland)');
  chooseFormat(null);
  assert.equal(formatSample('de-DE', day).sample, '1.234,5 · 16.10.26');
  for (const code of NUMBER_FORMATS) assert.match(formatSample(code, day).sample, /1.?234[.,]5 · /);
});

test('the browser’s language: its first Tiles has, English without one', () => {
  assert.equal(browserLanguage(['fr-FR', 'de-AT', 'en']), 'de');
  assert.equal(browserLanguage(['fr-FR']), 'en');
  assert.equal(browserLanguage([]), 'en');
});
