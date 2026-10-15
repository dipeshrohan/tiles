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
  // Rounded as shown: no "60 s" or "60 min"; a bucket of 90 s is 1.5 min.
  assert.equal(duration(59_600), '1 min');
  assert.equal(duration(59.7 * 60_000), '1 h');
  assert.equal(duration(90_000), '1.5 min');
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
  // A unit takes over where the smaller would round up to it.
  assert.equal(relative(now - (59 * 60_000 + 40_000), now), '1 hour ago');
  assert.equal(relative(now - (23 * 3_600_000 + 40 * 60_000), now), 'yesterday');
  assert.equal(relative(now - 6.6 * 86_400_000, now), date(now - 6.6 * 86_400_000));
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
  // Wrapped by Prettier, the browser's own, or a sort in a fixed language.
  assert.deepEqual(
    findFixed("x.toLocaleString(\n  'en-GB',\n  { maximumFractionDigits: 1 },\n);").map((h) => h.line),
    [1],
  );
  assert.deepEqual(findFixed('x.toLocaleString(undefined, { style: "percent" });').length, 1);
  assert.deepEqual(findFixed("a.localeCompare(b, 'en');").length, 1);
  assert.deepEqual(findFixed('a.localeCompare(b);'), []);
  assert.deepEqual(findFixed('const p = `${(x * 100).toFixed(1)}%`;').length, 1);
  assert.deepEqual(check(), []);
});

test('chart ticks fall on the site’s midnights, hours and month starts, labelled in its zone', async () => {
  const { timeTicks, tickLabel } = await import('../js/lib/svg.ts');
  const { zonedParts, zonedTime, zoneOffset } = await import('../js/lib/format.ts');
  setTimeZone('Europe/Berlin');
  assert.equal(zoneOffset('2026-10-15T00:00:00Z'), 120);
  assert.equal(zoneOffset('2026-12-15T00:00:00Z'), 60);
  assert.equal(new Date(zonedTime(2026, 9, 15)).toISOString(), '2026-10-14T22:00:00.000Z');
  // Two days in 6-hour steps: one tick at each Berlin midnight, labelled with the date.
  const from = Date.parse('2026-10-14T00:00:00Z');
  const { step, ticks } = timeTicks(from, from + 2 * 86_400_000);
  const midnights = ticks.filter((t) => zonedParts(t).hour === 0);
  assert.ok(midnights.length >= 1);
  assert.ok(ticks.every((t) => zonedParts(t).minute === 0 && zonedParts(t).hour % 6 === 0));
  assert.equal(tickLabel(midnights[0], step), '15 Oct');
  // Across the clock change (25 Oct), hours stay on the hour.
  const change = Date.parse('2026-10-24T12:00:00Z');
  assert.ok(timeTicks(change, change + 86_400_000).ticks.every((t) => zonedParts(t).minute === 0));
  // A year in months, for Chicago: each on the 1st at midnight there.
  setTimeZone('America/Chicago');
  const months = timeTicks(Date.parse('2026-01-15T00:00:00Z'), Date.parse('2026-12-20T00:00:00Z'));
  assert.ok(months.ticks.length >= 3); // quarters
  for (const t of months.ticks) assert.deepEqual([zonedParts(t).day, zonedParts(t).hour], [1, 0]);
  // A zone half an hour off UTC: hour ticks still on its hour.
  setTimeZone('Asia/Kolkata');
  const hours = timeTicks(from, from + 6 * 3_600_000);
  assert.ok(hours.ticks.every((t) => zonedParts(t).minute === 0));
});

test('date and time inputs are on the site’s clock', async () => {
  const { fromInput, inputValue } = await import('../js/lib/format.ts');
  setTimeZone('Europe/Berlin');
  assert.equal(inputValue('2026-10-15T07:30:59Z'), '2026-10-15T09:30');
  assert.equal(new Date(fromInput('2026-10-15T09:30')).toISOString(), '2026-10-15T07:30:00.000Z');
  assert.equal(new Date(fromInput('2026-12-15T09:30')).toISOString(), '2026-12-15T08:30:00.000Z');
  assert.ok(Number.isNaN(fromInput('yesterday')));
});
