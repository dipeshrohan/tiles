// Failure-mode model parity (T8.02 to T8.04): test/fixtures/failure-models.json holds windows of
// readings, healthy and failing, and what js/lib/failure-models.ts makes of them; the API's port
// (api/src/tiles_api/models/failure_modes.py) must give the same numbers (api/tests/test_failure_modes.py).
// Regenerate: UPDATE_FIXTURES=1 npx vitest run test/failure-models-parity.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRng } from '../js/lib/rng.ts';
import { accumulatorCharge, dieCooling, furnaceHeater } from '../js/lib/failure-models.ts';

const file = new URL('./fixtures/failure-models.json', import.meta.url);
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d; // as the historian keeps readings

// A window of `n` readings at a degradation `s` (0 healthy, 1 failing), as the plant drifts.
function windows() {
  const rng = createRng(8);
  const made = [];
  for (const s of [0, 0.3, 0.7, 1]) {
    const n = 40;
    const acc = { buildup: [], pressure: [] };
    const fur = { power: [], bath: [], cycle: [] };
    const cool = { die_temp: [], fixed_temp: [], flow: [] };
    for (let i = 0; i < n; i++) {
      acc.buildup.push(round(24 + 30 * s + rng.normal(0, 1.4), 1));
      acc.pressure.push(round(160 - 22 * s + rng.normal(0, 0.6), 1));
      const f = Math.min(1, 0.6 + 0.4 * s);
      fur.power.push(round(48 + (28 * Math.min(f, 0.85)) / 0.85 + rng.normal(0, 1.2), 1));
      fur.bath.push(round(690 - (26 * Math.max(0, f - 0.85)) / 0.15 + rng.normal(0, 1.5), 1));
      fur.cycle.push(i === 7 ? 620 : round(94 + rng.normal(0, 1), 1)); // one long wait: left out
      const fixed = 238 + rng.normal(0, 1.6);
      cool.fixed_temp.push(round(fixed, 1));
      cool.die_temp.push(round(fixed + 4 + 42 * s + rng.normal(0, 1.8), 1));
      cool.flow.push(round(42 * (1 - 0.55 * s) + rng.normal(0, 0.8), 1));
    }
    made.push({
      severity: s,
      accumulator: { inputs: acc, outputs: accumulatorCharge(acc) },
      furnace: { inputs: fur, outputs: furnaceHeater(fur) },
      cooling: { inputs: cool, outputs: dieCooling(cool) },
    });
  }
  // Below the intensifier's load pressure: no build-up to expect.
  const low = { buildup: [30, 31], pressure: [55, 61] };
  made.push({ severity: null, accumulator: { inputs: low, outputs: accumulatorCharge(low) } });
  return made;
}

// Equal, or for numbers within 1e-12: Math.pow's last bit differs between Node versions.
function near(saved, fresh, path = '') {
  if (typeof saved === 'number' && typeof fresh === 'number') {
    const ok = Math.abs(saved - fresh) <= 1e-12 * Math.max(1, Math.abs(saved));
    assert.ok(ok, `${path}: ${saved} is not ${fresh}`);
  } else if (saved && typeof saved === 'object') {
    assert.ok(fresh && typeof fresh === 'object', `${path}: not an object`);
    assert.deepEqual(Object.keys(saved), Object.keys(fresh), path);
    for (const k of Object.keys(saved)) near(saved[k], fresh[k], `${path}.${k}`);
  } else assert.equal(saved, fresh, path);
}

test('the failure-model fixture matches these models', () => {
  const fresh = windows();
  // Only rewritten on request: a missing fixture fails, rather than being made to match.
  if (process.env.UPDATE_FIXTURES === '1') writeFileSync(file, `${JSON.stringify({ windows: fresh }, null, 2)}\n`);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  near(saved.windows, JSON.parse(JSON.stringify(fresh)));
});

test('each model reads its failure from the readings', () => {
  const [healthy, , , failing] = windows();
  assert.ok(Math.abs(healthy.accumulator.outputs.sag[0]) < 1.5);
  assert.ok(failing.accumulator.outputs.sag[0] > 20); // most of the 30 ms the pressure doesn't explain
  assert.ok(Math.abs(failing.accumulator.outputs.charge_loss[0] - 22 / 160) < 0.01);
  assert.ok(Math.abs(healthy.furnace.outputs.heater_excess[0] - 19.8) < 1.5);
  assert.ok(failing.furnace.outputs.heater_excess[0] > healthy.furnace.outputs.heater_excess[0] + 15);
  assert.equal(healthy.furnace.outputs.excess[7], null);
  assert.equal(healthy.cooling.outputs.over_limit[0], 0);
  assert.ok(Math.abs(failing.cooling.outputs.blockage[0] - 0.55) < 0.02);
  assert.ok(failing.cooling.outputs.hot_half[0] > 38);
  const low = windows().at(-1).accumulator.outputs;
  assert.deepEqual(low.excess_buildup.slice(0, 1), [null]);
});
