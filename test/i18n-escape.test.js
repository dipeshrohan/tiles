// Catalogue words put into HTML go through esc() (U6.01): scripts/i18n-escape.js.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FILES, unescaped } from '../scripts/i18n-escape.js';

const lines = (src) => unescaped(src).map((h) => h.line);

test('finds t() whose words reach markup unescaped, through ?: || ?? and tHtml values', () => {
  assert.deepEqual(lines("const a = `<p>${t('x')}</p>`;"), [1]);
  assert.deepEqual(lines("const a = `<p>${ok ? t('x') : t('y')}</p>`;"), [1, 1]);
  assert.deepEqual(lines("const a = `<p>${(name || t('x'))}</p>`;"), [1]);
  assert.deepEqual(lines("const a = tHtml('m', { link: t('x') });"), [1]);
  // Escaped, said by a component, or plain text: fine.
  assert.deepEqual(lines("const a = `<p>${esc(t('x'))}</p>`;"), []);
  assert.deepEqual(lines("const a = `<p>${button(t('x'))}</p>`;"), []);
  assert.deepEqual(lines("const a = `${t('x')}: ${n}`;"), []);
  assert.deepEqual(lines("const a = `<p>${t('x') === y ? 'a' : 'b'}</p>`;"), []);
});

test('every page and module escapes the catalogue’s words in its markup', () => {
  const found = FILES().flatMap((f) => unescaped(readFileSync(f, 'utf8'), f).map((h) => `${f}:${h.line}`));
  assert.deepEqual(found, []);
});
