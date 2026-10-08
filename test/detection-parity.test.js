// Detection parity (T3.04): test/fixtures/friction-detection.json holds a friction history and
// the alerts js/lib/physics.ts raises on it; the API's streaming detector
// (api/src/tiles_api/detection.py) must raise the same ones (api/tests/test_detection.py).
// Regenerate: UPDATE_FIXTURES=1 npx vitest run test/detection-parity.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { detectFrictionAlerts, generateShotHistory } from '../js/lib/physics.ts';

const file = new URL('./fixtures/friction-detection.json', import.meta.url);

function cases() {
  const { history, cycleSeconds } = generateShotHistory();
  const values = history.map((s) => s.friction);
  return {
    cycleSeconds,
    config: { window: 200, k: 4, persist: 3 },
    values,
    alerts: detectFrictionAlerts(history).alerts,
  };
}

test('the friction-detection fixture matches this model', () => {
  const fresh = cases();
  // Only rewritten on request: a missing fixture fails, rather than being made to match.
  if (process.env.UPDATE_FIXTURES === '1') writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved, fresh);
  assert.ok(fresh.alerts.length >= 3);
});
