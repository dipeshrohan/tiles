// Correlation parity (T3.11): test/fixtures/correlation.json holds the browser's synthetic cutter
// batches and the findings js/lib/analysis.ts ranks on them, pooled and split by material; the
// API's correlation finder (api/src/tiles_api/correlate.py) must find the same
// (api/tests/test_correlate.py).
// Regenerate: UPDATE_FIXTURES=1 npx vitest run test/correlation-parity.test.js, then npm run format.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { correlationFinder } from '../js/lib/analysis.ts';
import { CUTTER_VARIABLES, generateCutterBatches } from '../js/lib/data.ts';

const file = new URL('./fixtures/correlation.json', import.meta.url);

function cases() {
  const rows = generateCutterBatches();
  const keep = (f) => ({
    segment: f.segment,
    variable: f.variable,
    ngMean: f.ngMean,
    okMean: f.okMean,
    effect: f.effect,
    r: f.r,
    ngCount: f.ngCount,
    okCount: f.okCount,
  });
  return {
    variables: CUTTER_VARIABLES.map((v) => v.key),
    rows,
    pooled: correlationFinder(rows, CUTTER_VARIABLES).map(keep),
    split: correlationFinder(rows, CUTTER_VARIABLES, { splitBy: 'material' }).map(keep),
  };
}

// Asserts two JSON values are equal, numbers within a relative 1e-12 (Math functions may differ
// in the last bit between Node versions).
function assertClose(actual, expected, path = '$') {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const ok = Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected));
    assert.ok(ok, `${path}: ${actual} != ${expected}`);
  } else if (expected && typeof expected === 'object') {
    assert.equal(typeof actual, 'object', path);
    assert.deepEqual(Object.keys(actual ?? {}), Object.keys(expected), path);
    for (const key of Object.keys(expected)) assertClose(actual[key], expected[key], `${path}.${key}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

test('the correlation fixture matches this model', () => {
  const fresh = cases();
  // Only rewritten on request: a missing fixture fails, rather than being made to match.
  if (process.env.UPDATE_FIXTURES === '1') writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assertClose(saved, fresh);
  // The pooled view hides the tension effect the split shows (the point of the split).
  assert.equal(fresh.split[0].variable, 'tension');
  assert.notEqual(fresh.pooled[0].variable, 'tension');
});
