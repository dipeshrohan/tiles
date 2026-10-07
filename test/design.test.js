import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, evaluate, sweep, sensitivity, makeRun, runDiff, auditRecord } from '../js/lib/design.js';

const defaults = (m) => Object.fromEntries(MODELS[m].params.map((p) => [p.key, p.default]));

test('every model version evaluates to a finite number at defaults', () => {
  for (const m of Object.values(MODELS)) {
    for (const v of Object.keys(m.versions))
      assert.ok(Number.isFinite(evaluate(m.id, v, defaults(m.id))), `${m.id} v${v}`);
  }
});

test('swelling force rises with state of charge', () => {
  const lo = evaluate('swelling', '2.0', { ...defaults('swelling'), soc: 10 });
  const hi = evaluate('swelling', '2.0', { ...defaults('swelling'), soc: 90 });
  assert.ok(hi > lo);
});

test('sweep grid matches requested size and bounds', () => {
  const s = sweep('swelling', '2.0', defaults('swelling'), 'soc', 'temperature', 5);
  assert.equal(s.grid.length, 5);
  assert.equal(s.grid[0].length, 5);
  assert.ok(s.min <= s.max);
});

test('sensitivity is sorted by magnitude', () => {
  const s = sensitivity('actuator', '1.1', defaults('actuator'));
  for (let i = 1; i < s.length; i++) assert.ok(Math.abs(s[i - 1].delta) >= Math.abs(s[i].delta));
});

test('runs record lineage and diffs, and audit export includes outputs', () => {
  const a = makeRun({ modelId: 'swelling', version: '1.1', params: defaults('swelling'), author: 't' });
  const b = makeRun({
    modelId: 'swelling',
    version: '2.0',
    params: { ...defaults('swelling'), soc: 40 },
    author: 't',
    parent: a.id,
  });
  assert.deepEqual(runDiff(b, a), [
    { key: 'soc', from: 80, to: 40 },
    { key: 'model version', from: '1.1', to: '2.0' },
  ]);
  const audit = auditRecord([b, a], 'swelling');
  assert.equal(audit.runs.length, 2);
  assert.equal(audit.runs[0].output.unit, 'kN');
  assert.throws(() => evaluate('swelling', '9.9', {}), /no version/);
});
