// Setpoint recommendations in the browser (T11.02): which models can recommend, what a
// recommendation changes, who may do what with it, and the form's numbers.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  allowed,
  assetOf,
  changes,
  isChance,
  ordered,
  recommendable,
  settableOf,
  stateOf,
} from '../js/lib/recommendations.ts';

const param = (name, unit = '', def = 0) => ({ name, unit, default: def, min: 0, max: 1000, description: name });
const porosity = {
  key: 'die-porosity',
  version: '1.0.0',
  name: 'Die-cast porosity',
  kind: 'design',
  domain: 'die casting',
  source: 'builtin',
  description: '',
  inputs: [],
  outputs: [{ name: 'porosity', unit: '%', description: '', per: 'window' }],
  params: [param('vacuum', 'mbar', 48), param('die_temp_set', '°C', 232), param('die_temp', '°C', 232)],
};
const rec = (over = {}) => ({
  number: 1,
  model: 'die-porosity',
  version: '1.0.0',
  objective: 'scrap_chance',
  asset: 'DC-01',
  state: { die_temp_set: 232, vacuum: 121 },
  sources: {},
  proposal: { die_temp_set: 222 },
  limits: { die_temp_set: { min: 222, max: 242 } },
  expected: { now: { scrap_chance: 0.02 }, proposed: { scrap_chance: 0.01 } },
  status: 'proposed',
  proposed_by: 'eng',
  proposed_at: '2026-05-04T10:00:00Z',
  decided_by: null,
  decided_at: null,
  decision_note: '',
  applied_by: null,
  applied_at: null,
  applied_note: '',
  mine: false,
  ...over,
});

test('only a design model without input series can recommend settings', () => {
  const plunger = { ...porosity, key: 'plunger-friction', kind: 'virtual-sensor', inputs: [{ name: 't' }] };
  assert.deepEqual(
    recommendable([plunger, porosity]).map((m) => m.key),
    ['die-porosity'],
  );
});

test('a machine is named as the MES names it: its asset, else its label', () => {
  assert.equal(assetOf({ id: 'm', type: 'Machine', label: 'Die caster 1', props: { asset: ' DC-01 ' } }), 'DC-01');
  assert.equal(assetOf({ id: 'm', type: 'Machine', label: 'DC-02', props: {} }), 'DC-02');
});

test('a recommendation lists each change, from its state to the proposal, within its limit', () => {
  assert.deepEqual(changes(rec(), porosity.params), [
    { param: 'die_temp_set', unit: '°C', from: 232, to: 222, min: 222, max: 242 },
  ]);
  assert.equal(changes(rec({ state: {} }))[0].from, null);
  assert.ok(isChance('scrap_chance') && !isChance('porosity') && !isChance('chancellor'));
});

test('someone else approves; anyone who edits rejects; an approved one is marked applied', () => {
  assert.deepEqual(allowed(rec(), true), { approve: true, reject: true, applied: false });
  assert.deepEqual(allowed(rec({ mine: true }), true), { approve: false, reject: true, applied: false });
  assert.deepEqual(allowed(rec({ status: 'approved' }), true), { approve: false, reject: false, applied: true });
  assert.deepEqual(allowed(rec(), false), { approve: false, reject: false, applied: false });
  assert.deepEqual(allowed(rec({ status: 'applied' }), true), { approve: false, reject: false, applied: false });
});

test('open recommendations come first, newest first', () => {
  const list = [
    rec({ number: 1, status: 'applied' }),
    rec({ number: 2, status: 'proposed' }),
    rec({ number: 3, status: 'approved' }),
    rec({ number: 4, status: 'proposed' }),
    rec({ number: 5, status: 'rejected' }),
  ];
  assert.deepEqual(
    ordered(list).map((r) => r.number),
    [4, 2, 3, 1, 5],
  );
});

test('the form gives typed values, signals instead of values, and names what is not a number', () => {
  assert.deepEqual(
    settableOf(porosity, new Set(['die_temp_set'])).map((p) => p.name),
    ['die_temp_set'],
  );
  const read = stateOf(porosity, { vacuum: '120', die_temp_set: '', die_temp: 'warm' }, { die_temp: 'sig-1' });
  assert.deepEqual(read, { state: { vacuum: 120 }, signals: { die_temp: 'sig-1' }, bad: [] });
  assert.deepEqual(stateOf(porosity, { vacuum: 'high' }, {}).bad, ['vacuum']);
});
