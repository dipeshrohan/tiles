// Design-model parity (T4.10): test/fixtures/design-models.json holds what the browser's design
// models (js/lib/design.ts) give for each version on a spread of parameters; the API's registry
// ports (api/src/tiles_api/models/design.py) must give the same (api/tests/test_design_models.py).
// Regenerate: UPDATE_FIXTURES=1 npx vitest run test/design-parity.test.js, then npm run format.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { evaluate, MODELS } from '../js/lib/design.ts';
import { createRng } from '../js/lib/rng.ts';

const file = new URL('./fixtures/design-models.json', import.meta.url);

function cases() {
  const rng = createRng(11);
  const out = {};
  for (const model of Object.values(MODELS)) {
    const sets = [
      Object.fromEntries(model.params.map((p) => [p.key, p.default])),
      Object.fromEntries(model.params.map((p) => [p.key, p.min])),
      Object.fromEntries(model.params.map((p) => [p.key, p.max])),
      ...Array.from({ length: 12 }, () =>
        Object.fromEntries(model.params.map((p) => [p.key, p.min + rng.next() * (p.max - p.min)])),
      ),
    ];
    out[model.id] = {
      latest: model.latest,
      params: model.params.map((p) => ({ key: p.key, unit: p.unit, min: p.min, max: p.max, default: p.default })),
      output: model.output,
      versions: Object.fromEntries(
        Object.keys(model.versions).map((v) => [
          v,
          sets.map((params) => ({ params, value: evaluate(model.id, v, params) })),
        ]),
      ),
    };
  }
  return out;
}

function assertClose(actual, expected, path = '$') {
  if (typeof expected === 'number' && typeof actual === 'number') {
    assert.ok(
      Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
      `${path}: ${actual} != ${expected}`,
    );
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual ?? {}), Object.keys(expected), path);
    for (const key of Object.keys(expected)) assertClose(actual[key], expected[key], `${path}.${key}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

test('the design-model fixture matches these models', () => {
  const fresh = cases();
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, JSON.stringify(fresh));
  assertClose(fresh, JSON.parse(readFileSync(file, 'utf8')));
});
