// Date fields with their value written out in Tiles' format and the site's zone (review H-18).
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { datedField, readsAs } from '../js/lib/date-fields.ts';
import { setFormatLocale, setTimeZone } from '../js/lib/format.ts';

afterEach(() => {
  setFormatLocale('en');
  setTimeZone(null);
});

test('a field’s value reads as Tiles writes it: the language’s date, the site’s clock and zone', () => {
  setTimeZone('Europe/Berlin');
  assert.equal(readsAs('2026-11-17T12:00', 'datetime-local'), '17 Nov 2026, 12:00 CET');
  assert.equal(readsAs('2026-07-22', 'date'), '22 Jul 2026');
  setFormatLocale('de');
  assert.equal(readsAs('2026-07-22', 'date'), '22. Juli 2026');
});

test('an empty or partial value reads as nothing', () => {
  assert.equal(readsAs('', 'datetime-local'), '');
  assert.equal(readsAs('2026-11-', 'date'), '');
  assert.equal(readsAs('2026-11-17', 'datetime-local'), '');
});

test('the field names its line, which starts with the value written out', () => {
  setTimeZone('UTC');
  const html = datedField('From', { name: 'from', kind: 'datetime-local', value: '2026-11-18T12:00', required: true });
  assert.match(html, /<input[^>]* type="datetime-local"[^>]* aria-describedby="reads-as-from"/);
  assert.match(html, /<input[^>]* required/);
  assert.match(html, /<output class="small soft" id="reads-as-from">18 Nov 2026, 12:00 UTC<\/output>/);
});
