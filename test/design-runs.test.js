// The Design Studio's runs from the API (T4.14): names, versions and runs as the browser reads them.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { API_MODEL, asRun, browserModel, browserVersion, changesOf, headOf } from '../js/lib/design-runs.ts';
import { MODELS, runDiff } from '../js/lib/design.ts';

const stored = (over = {}) => ({
  number: 7,
  model: 'cell-swelling',
  version: '2.0.0',
  model_name: 'Cell swelling force',
  params: { soc: 80, temperature: 25, preload: 2, cycles: 300, thickness: 95 },
  output: { force: 3.21 },
  units: { force: 'kN' },
  parent: 6,
  restored_from: null,
  project: 'p1',
  note: 'Hotter',
  author: { name: 'Eng', email: 'eng@example.com' },
  created_at: '2026-10-09T10:00:00Z',
  changes: [],
  ...over,
});

test("every browser model has the registry's key, and back", () => {
  assert.deepEqual(Object.keys(API_MODEL).sort(), Object.keys(MODELS).sort());
  for (const [id, key] of Object.entries(API_MODEL)) assert.equal(browserModel(key), id);
  assert.equal(browserModel('plunger-friction'), 'plunger-friction');
  assert.equal(browserVersion('2.0.0'), '2.0');
  assert.equal(browserVersion('1.1.0'), '1.1');
  assert.equal(browserVersion('1.1.2'), '1.1.2'); // not a browser version: left as it is
  for (const m of Object.values(MODELS))
    for (const v of Object.keys(m.versions)) assert.equal(browserVersion(`${v}.0`), v);
});

test('a stored run reads as a browser run, so its diff against its parent is the same', () => {
  const run = asRun(stored());
  assert.deepEqual(run, {
    id: '7',
    modelId: 'swelling',
    version: '2.0',
    params: { soc: 80, temperature: 25, preload: 2, cycles: 300, thickness: 95 },
    value: 3.21,
    author: 'Eng',
    note: 'Hotter',
    parent: '6',
    date: '2026-10-09T10:00:00Z',
  });
  const parent = asRun(stored({ number: 6, version: '1.1.0', params: { ...run.params, soc: 70 }, parent: null }));
  assert.equal(parent.parent, null);
  assert.deepEqual(runDiff(run, parent), [
    { key: 'soc', from: 70, to: 80 },
    { key: 'model version', from: '1.1', to: '2.0' },
  ]);
  assert.ok(Number.isNaN(asRun(stored({ output: {} })).value));
});

test('a new run follows the latest of its model', () => {
  const runs = [stored({ number: 9, model: 'joint-actuator' }), stored({ number: 8 }), stored({ number: 7 })];
  assert.equal(headOf(runs, 'swelling'), 8);
  assert.equal(headOf(runs, 'actuator'), 9);
  assert.equal(headOf([], 'swelling'), null);
});

test("a stored run's changes from its parent, as the history shows them", () => {
  const changes = [
    { key: 'version', before: '1.1.0', after: '2.0.0' },
    { key: 'soc', before: 70, after: 80 },
    { key: 'gone', before: 1, after: null },
  ];
  assert.deepEqual(changesOf(stored({ changes })), [
    { key: 'model version', from: '1.1', to: '2.0' },
    { key: 'soc', from: 70, to: 80 },
    { key: 'gone', from: 1, to: undefined },
  ]);
});
