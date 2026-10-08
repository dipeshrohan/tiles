// The warning performance page's logic (T3.10): how its numbers read, and the codes typed in.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { duration, kpis, parseCodes, share, spread } from '../js/lib/performance.ts';

test('shares round down, so nearly all never reads as all', () => {
  assert.deepEqual(
    [share(null), share(1), share(0.9996), share(0.75), share(0)],
    ['–', '100.0%', '99.9%', '75.0%', '0.0%'],
  );
});

test('durations and their spread read as people say them', () => {
  assert.deepEqual(
    [duration(40), duration(600), duration(7790), duration(3 * 86400)],
    ['40 s', '10 min', '2.2 h', '3.0 d'],
  );
  assert.equal(spread({ count: 3, min: 1, p10: 600, median: 7790, p90: 9000, max: 9001 }), '2.2 h (10 min to 2.5 h)');
  assert.equal(spread(null), '–');
});

test('codes are split at commas and line breaks, trimmed, each once', () => {
  assert.deepEqual(parseCodes(' DT-SEIZURE, DT-LUB\nDT-SEIZURE,, '), ['DT-SEIZURE', 'DT-LUB']);
  assert.deepEqual(parseCodes(''), []);
  assert.equal(parseCodes(Array.from({ length: 60 }, (_, i) => `C${i}`).join(',')).length, 50);
});

test('the headline numbers', () => {
  const totals = {
    warnings: 4,
    true_warnings: 3,
    false_warnings: 1,
    pending_warnings: 1,
    events: 4,
    caught: 3,
    recall: 0.75,
    precision: 0.75,
    false_per_day: 0.2,
    warning_seconds: { count: 3, min: 6080, p10: 6175, median: 6555, p90: 7543, max: 7790 },
    confirmed: { true_alarm: 2, false_alarm: 1, unknown: 0, unresolved: 2 },
  };
  assert.deepEqual(
    kpis(totals).map((k) => [k.value, k.note, k.tone]),
    [
      ['75.0%', '3 of 4 downtime or scrap event(s)', 'good'],
      ['75.0%', '3 of 4; 1 too recent to tell', ''],
      ['66.6%', '2 true, 1 false, 0 unknown, 2 open', ''],
      ['1.8 h', '1.7 h to 2.1 h (10th to 90th percentile)', ''],
    ],
  );
  const none = kpis({
    ...totals,
    recall: null,
    events: 0,
    caught: 0,
    warning_seconds: null,
    confirmed: { true_alarm: 0, false_alarm: 0, unknown: 1, unresolved: 0 },
  });
  assert.deepEqual(
    none.map((k) => k.value),
    ['–', '75.0%', '–', '–'],
  );
  assert.equal(none[3].note, 'no event warned of yet');
  assert.equal(kpis({ ...totals, recall: 0.25 })[0].tone, 'bad');
});
