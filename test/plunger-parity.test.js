// Plunger-friction parity (T3.02): test/fixtures/plunger-shots.json holds simulated shots and
// this model's estimate for each; the API's port (api/src/tiles_api/models/plunger.py) must
// give the same numbers (api/tests/test_models.py).
// Regenerate: UPDATE_FIXTURES=1 npx vitest run test/plunger-parity.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRng } from '../js/lib/rng.ts';
import { estimateFriction, simulateShot } from '../js/lib/physics.ts';

const file = new URL('./fixtures/plunger-shots.json', import.meta.url);

function shots() {
  const rng = createRng(3);
  const made = [900, 1200, 1800, 3500].map((friction) => {
    const payload = simulateShot(friction, rng);
    return { friction, payload, estimate: estimateFriction(payload) };
  });
  // A logger that wrote one timestamp twice: that sample is skipped, by both implementations.
  const repeated = simulateShot(1500, rng);
  repeated.t[20] = repeated.t[19];
  made.push({ friction: 1500, payload: repeated, estimate: estimateFriction(repeated) });
  return made;
}

test('the plunger-friction fixture matches this model', () => {
  const fresh = shots();
  // Only rewritten on request: a missing fixture fails, rather than being made to match.
  if (process.env.UPDATE_FIXTURES === '1') writeFileSync(file, `${JSON.stringify({ shots: fresh }, null, 2)}\n`);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.shots, fresh);
  for (const s of fresh) assert.ok(Math.abs(s.estimate - s.friction) / s.friction < 0.05);
});
