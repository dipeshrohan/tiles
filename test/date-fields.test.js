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

test('a day whose midnight the site’s clock skips still reads as that day (review)', () => {
  setTimeZone('America/Santiago'); // clocks go from 00:00 to 01:00 on 6 September 2026
  assert.match(readsAs('2026-09-06', 'date'), /^6 Sep/);
  setTimeZone('America/Havana'); // and on 8 March 2026
  assert.match(readsAs('2026-03-08', 'date'), /^8 Mar/);
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
  // A span, not an <output>: a status role would read the whole date out on every key.
  assert.match(html, /<span class="small soft reads-as" id="reads-as-from">18 Nov 2026, 12:00 UTC<\/span>/);
  assert.doesNotMatch(html, /<output|aria-live|role="status"/);
});
