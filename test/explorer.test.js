import { test } from 'vitest';
import assert from 'node:assert/strict';
import { describe as describeSeries, gapFor, pan, presetRange, toPoints, zoomOut } from '../js/views/explorer.ts';
import { tickLabel, timeAt, timeChart, timeTicks, TIME_CHART } from '../js/lib/svg.ts';

const H = 3_600_000;
const T0 = Date.parse('2026-09-01T06:00:00Z');

const series = (points, bucket_s = null) => ({
  signal_id: 's1',
  tag: 'press1.temperature',
  unit: '°C',
  start: new Date(T0).toISOString(),
  end: new Date(T0 + 24 * H).toISOString(),
  bucket_s,
  points,
});
const reading = (minutes, value, extra = {}) => ({
  at: new Date(T0 + minutes * 60_000).toISOString(),
  value,
  min: value,
  max: value,
  n: 1,
  text: null,
  ...extra,
});

test('preset ranges end now, or just after the latest reading picked', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  assert.deepEqual(presetRange('1h', [], now), { from: '2026-10-08T11:00:00.000Z', to: '2026-10-08T12:00:00.000Z' });
  assert.equal(presetRange('7d', [], now).from, '2026-10-01T12:00:00.000Z');
  const picked = [
    { id: 'a', tag: 'a', unit: null, last_at: '2026-09-01T06:00:00Z' },
    { id: 'b', tag: 'b', unit: null, last_at: '2026-09-02T06:00:00Z' },
    { id: 'c', tag: 'c', unit: null, last_at: null },
  ];
  assert.deepEqual(presetRange('data', picked, now), {
    from: '2026-09-01T06:00:00.001Z',
    to: '2026-09-02T06:00:00.001Z', // `to` is excluded, so the latest reading is in
  });
  assert.equal(presetRange('data', [picked[2]], now).to, '2026-10-08T12:00:00.000Z'); // no readings: up to now
});

test('zooming out doubles the range around its middle; panning moves by half', () => {
  const range = { from: '2026-09-01T06:00:00.000Z', to: '2026-09-01T08:00:00.000Z' };
  assert.deepEqual(zoomOut(range), { from: '2026-09-01T05:00:00.000Z', to: '2026-09-01T09:00:00.000Z' });
  assert.deepEqual(pan(range, -1), { from: '2026-09-01T05:00:00.000Z', to: '2026-09-01T07:00:00.000Z' });
  assert.deepEqual(pan(range, 1), { from: '2026-09-01T07:00:00.000Z', to: '2026-09-01T09:00:00.000Z' });
});

test('points to plot, and how far apart they may be and still be joined', () => {
  const raw = series([reading(0, 20), reading(1, 21), reading(2, null, { text: 'running' }), reading(3, 22)]);
  const points = toPoints(raw);
  assert.deepEqual(
    points.map((p) => [p.t - T0, p.v, p.lo, p.hi]),
    [
      [0, 20, 20, 20],
      [60_000, 21, 21, 21],
      [180_000, 22, 22, 22],
    ],
  );
  assert.equal(gapFor(raw, points), 5 * 60_000); // five median steps
  assert.equal(gapFor(series([], 60), []), 90_000); // one and a half buckets
  assert.equal(gapFor(series([reading(0, 1)]), toPoints(series([reading(0, 1)]))), Infinity);
});

test('what a series holds, in words', () => {
  assert.equal(describeSeries(series([])), 'No readings in this range');
  assert.equal(describeSeries(series([reading(0, 1), reading(1, 2)])), '2 reading(s)');
  assert.equal(
    describeSeries(series([reading(0, 1, { n: 3600 }), reading(60, 2, { n: 1200 })], 3600)),
    '4,800 readings, as 2 averages of 1 h with their range',
  );
});

test('time ticks fall on round local times', () => {
  const { step, ticks } = timeTicks(T0, T0 + 24 * H);
  assert.equal(step, 6 * H);
  assert.equal(ticks.length, 5); // both ends included
  for (const t of ticks) assert.equal(new Date(t).getHours() % 6, 0);
  assert.equal(timeTicks(T0, T0 + 10 * 60_000).step, 5 * 60_000);
  const midnight = new Date(2026, 8, 2).getTime();
  assert.match(tickLabel(midnight, H), /^2 Sept?$/); // ICU versions abbreviate September differently
  assert.equal(tickLabel(midnight + 90 * 60_000, H), '01:30');
  assert.equal(tickLabel(midnight + 90 * 60_000 + 5000, 5000), '01:30:05');
});

test('a point on the chart maps back to its time, kept within the axis', () => {
  const { width, pad } = TIME_CHART;
  assert.equal(timeAt(pad.l, T0, T0 + H), T0);
  assert.equal(timeAt(width - pad.r, T0, T0 + H), T0 + H);
  assert.equal(timeAt(0, T0, T0 + H), T0);
  assert.equal(timeAt((pad.l + width - pad.r) / 2, T0, T0 + H), T0 + H / 2);
});

test('the time chart joins near points, breaks at gaps and shades bucket ranges', () => {
  const pts = (ts, lo = 0) => ts.map((m, i) => ({ t: T0 + m * 60_000, v: i, lo: i - lo, hi: i + lo }));
  const joined = timeChart({ points: pts([0, 1, 2, 30, 31]), from: T0, to: T0 + H, gap: 5 * 60_000 });
  assert.equal((joined.match(/<path d="M[^"]*" fill="none"/g) ?? []).length, 2); // two runs
  assert.doesNotMatch(joined, /fill-opacity/); // raw readings: no band
  const banded = timeChart({ points: pts([0, 1, 2], 1), from: T0, to: T0 + H, gap: 90_000, yLabel: '°C <b>' });
  assert.match(banded, /fill-opacity="0.18"/);
  assert.match(banded, /°C &lt;b&gt;/);
  assert.match(
    timeChart({ points: pts([0]), from: T0, to: T0 + H, gap: Infinity }),
    /<circle/, // a lone point is a dot
  );
  assert.match(timeChart({ points: [], from: T0, to: T0 + H, gap: 1 }), /No readings in this range/);
});
