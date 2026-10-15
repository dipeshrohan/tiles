import { test } from 'vitest';
import assert from 'node:assert/strict';
import { addCatalogue, formatMessage, setLocale, currentLocale } from '../js/lib/i18n.ts';

test('as HTML, the message’s words are escaped and its values put in as built', () => {
  assert.equal(formatMessage('A <b> & {x}', { x: '<i>term</i>' }, 'en', true), 'A &lt;b&gt; &amp; <i>term</i>');
  assert.equal(formatMessage('{n, plural, one {# <x>} other {# <y>}}', { n: 2 }, 'en', true), '2 &lt;y&gt;');
});

test('values go in by name; a missing one shows its name', () => {
  assert.equal(formatMessage('Hello {name}', { name: 'Ana' }), 'Hello Ana');
  assert.equal(formatMessage('{a} and {b}', { a: 1, b: 'x' }), '1 and x');
  assert.equal(formatMessage('Hello {name}', {}), 'Hello {name}');
  assert.equal(formatMessage('No braces', {}), 'No braces');
});

test('plurals by the locale’s rules, exact matches first, # the number', () => {
  const m = '{count, plural, =0 {No warnings} one {# warning} other {# warnings}}';
  assert.equal(formatMessage(m, { count: 0 }), 'No warnings');
  assert.equal(formatMessage(m, { count: 1 }), '1 warning');
  assert.equal(formatMessage(m, { count: 7 }), '7 warnings');
  // # is written as the language writes numbers.
  assert.equal(formatMessage(m, { count: 1430 }), '1,430 warnings');
  assert.equal(formatMessage(m, { count: 1430 }, 'de'), '1.430 warnings');
  // Other languages' categories: Polish has "few" and "many".
  const pl = '{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}';
  assert.equal(formatMessage(pl, { n: 3 }, 'pl'), '3 pliki');
  assert.equal(formatMessage(pl, { n: 5 }, 'pl'), '5 plików');
});

test('selects by a value’s text, other when none match; nested messages', () => {
  const m = '{role, select, viewer {Read only} admin {Admin of {site}} other {Can edit}}';
  assert.equal(formatMessage(m, { role: 'viewer' }), 'Read only');
  assert.equal(formatMessage(m, { role: 'admin', site: 'Plant A' }), 'Admin of Plant A');
  assert.equal(formatMessage(m, { role: 'engineer' }), 'Can edit');
  assert.equal(
    formatMessage('{n, plural, one {{who} took # warning} other {{who} took # warnings}}', { n: 2, who: 'Ana' }),
    'Ana took 2 warnings',
  );
});

test('a locale’s messages, falling back to English for what it lacks', async () => {
  const { t } = await import('../js/lib/i18n.ts');
  addCatalogue('xx', { 'feedbackAdmin.title': 'Rückmeldungen' });
  setLocale('xx');
  assert.equal(currentLocale(), 'xx');
  assert.equal(t('feedbackAdmin.title'), 'Rückmeldungen');
  assert.equal(t('feedbackAdmin.deleted'), 'Feedback deleted'); // not translated: English
  setLocale('nope');
  assert.equal(currentLocale(), 'en');
  assert.equal(t('feedbackAdmin.title'), 'Feedback');
});
