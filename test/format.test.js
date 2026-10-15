// Numbers, dates and times as the person's language writes them, in the site's zone (U6.02).
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  date,
  dateTime,
  duration,
  formatLocale,
  number,
  percent,
  relative,
  setFormatLocale,
  setTimeZone,
  significant,
  textOrder,
  time,
  timeZone,
  upTo,
} from '../js/lib/format.ts';
import { check, findFixed } from '../scripts/check-format.js';

afterEach(() => {
  setFormatLocale('en');
  setTimeZone(null);
});

const AT = '2026-10-15T07:30:05Z';
// Intl puts a narrow no-break space in some places (10:30 AM, 24,2 %): compare with plain spaces.
const plain = (s) => s.replace(/[\u202f\u00a0]/g, ' ');

test('English (the catalogue’s en) is written as en-GB', () => {
  setFormatLocale('en');
  assert.equal(formatLocale(), 'en-GB');
  assert.equal(number(12480.5, 1), '12,480.5');
  assert.equal(number(3, 2), '3.00');
  assert.equal(upTo(2.5, 1), '2.5');
  assert.equal(upTo(3, 1), '3');
  assert.equal(significant(0.000234567), '0.000235');
  assert.equal(percent(0.242, 1), '24.2%');
  assert.equal(number(Number.NaN), '–');
  setTimeZone('Europe/Berlin');
  assert.equal(date(AT), '15 Oct 2026');
  assert.equal(dateTime(AT), '15 Oct 2026, 09:30 CEST');
  assert.equal(dateTime(AT, { seconds: true, zone: false }), '15 Oct 2026, 09:30:05');
  assert.equal(time(AT), '09:30');
});

test('German writes 12.480,5 and its own dates, in the same zone', () => {
  setFormatLocale('de');
  assert.equal(formatLocale(), 'de');
  assert.equal(number(12480.5, 1), '12.480,5');
  assert.equal(plain(percent(0.242, 1)), '24,2 %');
  setTimeZone('Europe/Berlin');
  assert.equal(date(AT), '15. Okt. 2026');
  assert.equal(time(AT), '09:30');
  assert.match(dateTime(AT), /^15\. Okt\. 2026, 09:30 MESZ$/);
});

test('US English writes its dates month first, with AM and PM', () => {
  setFormatLocale('en-US');
  assert.equal(number(12480.5, 1), '12,480.5');
  setTimeZone('America/Chicago');
  assert.equal(date(AT), 'Oct 15, 2026');
  assert.equal(plain(time(AT)), '02:30 AM');
  assert.equal(plain(dateTime(AT)), 'Oct 15, 2026, 02:30 AM CDT');
});

test('times are in the site’s zone, named; an unknown zone falls back to this browser’s', () => {
  setTimeZone('Asia/Tokyo');
  assert.equal(timeZone(), 'Asia/Tokyo');
  assert.equal(dateTime(AT), '15 Oct 2026, 16:30 GMT+9');
  setTimeZone('Mars/Olympus');
  assert.equal(timeZone(), new Intl.DateTimeFormat().resolvedOptions().timeZone);
  // An unknown language: en-GB, never a throw.
  setFormatLocale('xx-nope');
  assert.equal(formatLocale(), 'en-GB');
});

test('durations in the largest unit that keeps them readable (writing.md)', () => {
  assert.equal(duration(2_500), '2.5 s');
  assert.equal(duration(45_000), '45 s');
  assert.equal(duration(57 * 60_000), '57 min');
  assert.equal(duration(130 * 60_000), '2 h 10 min');
  assert.equal(duration(3 * 3_600_000), '3 h');
  assert.equal(duration(3 * 86_400_000), '3 days');
  assert.equal(duration(-45_000), '−45 s');
  setFormatLocale('de');
  assert.equal(duration(2_500), '2,5 s');
  assert.equal(duration(3 * 86_400_000), '3 Tage');
});

test('relative time says how long ago, in the language; past a week, the date', () => {
  const now = Date.parse(AT);
  assert.equal(relative(now - 10_000, now), 'now');
  assert.equal(relative(now - 3 * 60_000, now), '3 minutes ago');
  assert.equal(relative(now - 2 * 3_600_000, now), '2 hours ago');
  assert.equal(relative(now - 86_400_000, now), 'yesterday');
  assert.equal(relative(now + 2 * 3_600_000, now), 'in 2 hours');
  assert.equal(relative(now - 10 * 86_400_000, now), date(now - 10 * 86_400_000));
  setFormatLocale('de');
  assert.equal(relative(now - 3 * 60_000, now), 'vor 3 Minuten');
  assert.equal(relative(now - 86_400_000, now), 'gestern');
});

test('text sorts in the language’s order, numbers inside it by value', () => {
  const lines = ['Line 10', 'line 2', 'Line 1'];
  assert.deepEqual([...lines].sort(textOrder({ numeric: true, sensitivity: 'base' }).compare), [
    'Line 1',
    'line 2',
    'Line 10',
  ]);
});

test('no number or date is written with a fixed locale outside format.ts', () => {
  assert.deepEqual(
    findFixed("a.toLocaleString('en-GB');\nnew Intl.NumberFormat('en-US');\nd.toLocaleDateString();\nok(x);").map(
      (h) => h.line,
    ),
    [1, 2, 3],
  );
  assert.deepEqual(findFixed('new Intl.DateTimeFormat(PARSE_LOCALE, {});'), []);
  assert.deepEqual(check(), []);
});
