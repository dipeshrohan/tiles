import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRng } from '../js/lib/rng.ts';
import {
  simulateShot,
  estimateFriction,
  generateShotHistory,
  detectFrictionAlerts,
  scoreAlerts,
} from '../js/lib/physics.ts';

test('friction estimate recovers the true friction from a shot payload', () => {
  const rng = createRng(3);
  for (const friction of [1200, 1800, 3500]) {
    const est = estimateFriction(simulateShot(friction, rng));
    assert.ok(Math.abs(est - friction) / friction < 0.05, `estimated ${est} for ${friction}`);
  }
});

test('shot history is reproducible for a seed', () => {
  const a = generateShotHistory({ seed: 9, shots: 50 });
  const b = generateShotHistory({ seed: 9, shots: 50 });
  assert.deepEqual(a.history, b.history);
});

test('friction warnings precede every seizure stop with no false alarms', () => {
  const { history, downtime, cycleSeconds } = generateShotHistory();
  const { alerts, flags } = detectFrictionAlerts(history);
  const scored = scoreAlerts(alerts, downtime, cycleSeconds);
  assert.equal(scored.filter((s) => s.predicted).length, downtime.length);
  for (const s of scored) assert.ok(s.leadHours > 0.5, `${s.id} lead ${s.leadHours}`);
  // Every alert window must belong to a downtime event.
  for (const a of alerts) assert.ok(downtime.some((d) => d.shot >= a.firstShot && d.shot - a.firstShot < 300));
  assert.equal(flags.length, history.length);
});

test('no alerts on a flat friction history', () => {
  const rng = createRng(4);
  const history = Array.from({ length: 600 }, (_, i) => ({ index: i, friction: 1800 + rng.normal(0, 40) }));
  assert.equal(detectFrictionAlerts(history).alerts.length, 0);
});
