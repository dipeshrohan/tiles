// Wear-check parity (T3.13): test/fixtures/wear-check.json holds the browser's demo welder power
// (hourly, up to the scheduled tip swap) and what js/lib/analysis.ts's wearCheck says of each tip;
// the API's wear check (api/src/tiles_api/wear.py, and over HTTP on the same readings) must say the
// same (api/tests/test_wear.py).
// Regenerate: UPDATE_FIXTURES=1 npx vitest run test/wear-parity.test.js, then npm run format.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { wearCheck } from '../js/lib/analysis.ts';
import { generateWeldPower } from '../js/lib/data.ts';

const file = new URL('./fixtures/wear-check.json', import.meta.url);

function cases() {
  const weld = generateWeldPower();
  const series = weld.series.slice(0, weld.swapAt);
  const keep = (r) => ({ baseline: r.baseline, last: r.last, change: r.change });
  return {
    window_hours: 24,
    hours: series.length,
    cathode: series.map((s) => s.cathode),
    anode: series.map((s) => s.anode),
    results: {
      cathode: keep(wearCheck(weld.series, 'cathode', { until: weld.swapAt })),
      anode: keep(wearCheck(weld.series, 'anode', { until: weld.swapAt })),
    },
  };
}

function assertClose(actual, expected, path = '$') {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const ok = Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected));
    assert.ok(ok, `${path}: ${actual} != ${expected}`);
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual ?? {}), Object.keys(expected), path);
    for (const key of Object.keys(expected)) assertClose(actual[key], expected[key], `${path}.${key}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

test('the wear-check fixture matches this model', () => {
  const fresh = cases();
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, JSON.stringify(fresh));
  assertClose(fresh, JSON.parse(readFileSync(file, 'utf8')));
  // The cathode tip wears before its swap; the anode doesn't.
  assert.ok(fresh.results.cathode.change > 0.05);
  assert.ok(Math.abs(fresh.results.anode.change) < 0.02);
});
