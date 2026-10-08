// Plunger-friction parity (T3.02): test/fixtures/plunger-shots.json holds simulated shots and
// this model's estimate for each; the API's port (api/src/tiles_api/models/plunger.py) must
// give the same numbers (api/tests/test_models.py).
// Regenerate: UPDATE_FIXTURES=1 npx vitest run test/plunger-parity.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRng } from '../js/lib/rng.ts';
import { estimateFriction, simulateShot } from '../js/lib/physics.ts';

const file = new URL('./fixtures/plunger-shots.json', import.meta.url);

function shots() {
  const rng = createRng(3);
  return [900, 1200, 1800, 3500].map((friction) => {
    const payload = simulateShot(friction, rng);
    return { friction, payload, estimate: estimateFriction(payload) };
  });
}

test('the plunger-friction fixture matches this model', () => {
  const fresh = shots();
  if (process.env.UPDATE_FIXTURES === '1' || !existsSync(file))
    writeFileSync(file, `${JSON.stringify({ shots: fresh })}\n`);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.shots, fresh);
  for (const s of fresh) assert.ok(Math.abs(s.estimate - s.friction) / s.friction < 0.05);
});
