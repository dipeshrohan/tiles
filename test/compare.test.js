import { test } from 'vitest';
import assert from 'node:assert/strict';
import { align, bucketMeans, offsetLabel, otherRange, summarise } from '../js/lib/compare.ts';
import { compareFromQuery, compareQuery, summaryText } from '../js/views/explorer.ts';

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.parse('2026-09-07T00:00:00Z'); // a Monday

test('the range compared is as long, starting earlier: just before, a day, a week, or a chosen start', () => {
  const r = { from: T0, to: T0 + 6 * H };
  assert.deepEqual(otherRange(r, 'before'), { from: T0 - 6 * H, to: T0 });
  assert.deepEqual(otherRange(r, 'day'), { from: T0 - D, to: T0 - D + 6 * H });
  assert.deepEqual(otherRange(r, 'week'), { from: T0 - 7 * D, to: T0 - 7 * D + 6 * H });
  assert.deepEqual(otherRange(r, 'custom', T0 - 3 * D), { from: T0 - 3 * D, to: T0 - 3 * D + 6 * H });
  assert.deepEqual(otherRange(r, 'custom'), otherRange(r, 'before')); // no start chosen yet
});

test('readings become bucket means; a bucket with none is a gap', () => {
  const span = { from: 0, to: 40 };
  assert.deepEqual(
    bucketMeans(
      [
        { t: 1, v: 2 },
        { t: 3, v: 4 },
        { t: 25, v: 9 },
        { t: 40, v: 99 }, // `to` is excluded
        { t: -1, v: 99 },
      ],
      span,
      4,
    ),
    [3, null, 9, null],
  );
});

test('two ranges are shift-aligned: last week’s hour 2 lies under this week’s hour 2', () => {
  const now = { from: T0, to: T0 + 4 * H };
  const then = otherRange(now, 'week');
  const readings = (span, values) => values.map((v, i) => ({ t: span.from + i * H + 1000, v }));
  const x = align(
    readings(then, [10, 11, 12, 13]),
    then,
    readings(
      now,
      [10, 12, 15, null].filter((v) => v !== null),
    ),
    now,
    4,
  );
  assert.deepEqual(x.a, [10, 11, 12, 13]);
  assert.deepEqual(x.b, [10, 12, 15, null]);
  assert.deepEqual(x.diff, [0, 1, 3, null]);
  assert.equal(x.width, H);
  const s = summarise(x);
  assert.equal(s.shared, 3); // the last hour has no reading this week: left out of both means
  assert.equal(s.meanA, 11);
  assert.equal(s.meanB, (10 + 12 + 15) / 3);
  assert.ok(Math.abs(s.diff - (37 / 3 - 11)) < 1e-9);
  assert.ok(Math.abs(s.pct - ((37 / 3 - 11) / 11) * 100) < 1e-9);
  assert.deepEqual(summarise(align([], now, [], now, 4)), {
    meanA: null,
    meanB: null,
    diff: null,
    pct: null,
    shared: 0,
  });
});

test('the shared axis reads as time since each range began', () => {
  assert.equal(offsetLabel(0), '+0 min');
  assert.equal(offsetLabel(45 * 60_000), '+45 min');
  assert.equal(offsetLabel(2.5 * H), '+2 h 30 min');
  assert.equal(offsetLabel(3 * H), '+3 h');
  assert.equal(offsetLabel(3 * D), '+3 d');
  assert.equal(offsetLabel(3 * D + 5 * H), '+3 d 5 h');
});

test('the comparison is in the address, and read back from it', () => {
  const ranges = {
    mode: 'ranges',
    signal: 's1',
    against: 'custom',
    start: '2026-09-01T00:00:00.000Z',
    a: null,
    b: null,
  };
  const q = compareQuery(ranges);
  assert.deepEqual(q, { compare: 'ranges', cs: 's1', against: 'custom', cstart: ranges.start, ca: null, cb: null });
  const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== null));
  assert.deepEqual(compareFromQuery(params), ranges);
  assert.deepEqual(compareQuery({ ...ranges, mode: 'off' }).compare, null);
  assert.equal(compareFromQuery(new URLSearchParams('compare=nope')), null);
  assert.equal(compareFromQuery(new URLSearchParams('compare=ranges&against=year')).against, 'week');
});

test('the summary says which is higher, by how much, over how many points', () => {
  assert.equal(
    summaryText({ meanA: 10, meanB: 12, diff: 2, pct: 20, shared: 5 }, ['Earlier', 'This range'], '°C'),
    'On average This range is higher by 2 °C (20%): 12 °C against 10 °C, over 5 points where both have readings.',
  );
  assert.match(
    summaryText({ meanA: 1, meanB: 0.5, diff: -0.5, pct: -50, shared: 2 }, ['a', 'b'], ''),
    /b is lower by 0\.5 \(50%\)/,
  );
  assert.match(
    summaryText({ meanA: null, meanB: null, diff: null, pct: null, shared: 0 }, ['a', 'b'], ''),
    /no readings at the same points/,
  );
});
