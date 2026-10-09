// The wear check in the Data explorer (T3.13): the windows asked for, the limit, the result shown.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseLimit, wearBlock, wearPlan } from '../js/lib/wear.ts';

const range = (hours, to = '2026-09-05T06:00:00.000Z') => ({
  from: new Date(Date.parse(to) - hours * 3_600_000).toISOString(),
  to,
});

test('the last day (at most a quarter of the range) is checked against the rest, in whole buckets', () => {
  assert.deepEqual(wearPlan(range(96)), {
    end: '2026-09-05T06:00:00.000Z',
    recent_hours: 24,
    baseline_hours: 72,
    bucket_minutes: 15,
  });
  assert.deepEqual(wearPlan(range(30 * 24)), {
    end: '2026-09-05T06:00:00.000Z',
    recent_hours: 24,
    baseline_hours: 696,
    bucket_minutes: 120,
  });
  // Short ranges: a quarter of them.
  assert.deepEqual(wearPlan(range(8)), {
    end: '2026-09-05T06:00:00.000Z',
    recent_hours: 2,
    baseline_hours: 6,
    bucket_minutes: 5,
  });
  // A range that isn't a whole number of buckets: its start is left out.
  const odd = wearPlan(range(96.1));
  assert.equal(typeof odd, 'object');
  assert.ok(odd.recent_hours + odd.baseline_hours <= 96.1);
  assert.match(String(wearPlan(range(0.1))), /too short/);
  assert.match(String(wearPlan(range(121 * 24))), /at most 120 days/);
  assert.match(String(wearPlan({ from: 'x', to: 'y' })), /Choose a range/);
});

test('every plan fits what the API takes', () => {
  for (const hours of [1, 2, 7, 25, 49, 97, 24 * 7, 24 * 31, 24 * 90, 24 * 100, 24 * 110, 24 * 120]) {
    const p = wearPlan(range(hours));
    assert.equal(typeof p, 'object', `${hours}: ${p}`);
    const width = p.bucket_minutes / 60;
    assert.ok(Number.isInteger(Math.round((p.recent_hours / width) * 1e9) / 1e9), `${hours}: recent`);
    assert.ok(Number.isInteger(Math.round((p.baseline_hours / width) * 1e9) / 1e9), `${hours}: baseline`);
    assert.ok((p.recent_hours + p.baseline_hours) / width <= 5000, `${hours}: buckets`);
    assert.ok(p.recent_hours / width <= 500 && p.recent_hours / width >= 4, `${hours}: recent buckets`);
  }
});

test('a limit is a number or nothing', () => {
  assert.equal(parseLimit(' '), null);
  assert.equal(parseLimit('1900'), 1900);
  assert.equal(parseLimit('1,900'), 1900); // as the check's sentences write it
  assert.equal(parseLimit('1,900.5'), 1900.5);
  assert.equal(parseLimit('-12.5'), -12.5);
  assert.equal(parseLimit('high'), 'The limit is a number');
});

test('the result shows its verdict, the baseline and limit, and the recent window shaded', () => {
  const r = {
    signal_id: 's',
    tag: 'w03.power',
    unit: 'W',
    start: '2026-09-01T06:00:00Z',
    recent_from: '2026-09-04T06:00:00Z',
    end: '2026-09-05T06:00:00Z',
    verdict: 'wearing',
    baseline: 1620,
    last: 1785,
    change: 0.1,
    slope_per_day: 160,
    hours_to_limit: 18,
    baseline_buckets: 72,
    recent_buckets: 24,
    text: 'Wearing: <the> recent level is 1,785 W.',
    buckets: Array.from({ length: 96 }, (_, h) => ({
      at: new Date(Date.parse('2026-09-01T06:00:00Z') + h * 3_600_000).toISOString(),
      value: 1620 + (h >= 72 ? (h - 72) * 8 : 0),
      n: 60,
    })),
  };
  const html = wearBlock(r, 1900);
  assert.match(html, /<span class="badge bad">Wearing<\/span> Wearing: &lt;the&gt; recent level/);
  assert.equal((html.match(/class="level"/g) ?? []).length, 2);
  assert.match(html, />baseline</);
  assert.match(html, />limit</);
  assert.match(html, /class="span"|<rect/);
  assert.match(html, /Medians of 96 bucket\(s\)/);
  assert.equal((wearBlock({ ...r, verdict: 'stable' }, null).match(/class="level"/g) ?? []).length, 1);
  assert.match(wearBlock({ ...r, verdict: 'not_enough_data', baseline: null }, null), /Not enough data/);
});
