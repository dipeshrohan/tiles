import { test } from 'vitest';
import assert from 'node:assert/strict';
import { changeFrom, latest, resultsTable, sourceLabel } from '../js/views/signals.ts';
import { describeAudit } from '../js/views/settings.ts';

const SIG = {
  id: 's1',
  tag: 'press1.temperature',
  unit: '°C',
  sample_rate_hz: 10,
  source: 'edge:press-shop-edge',
  description: 'Platen, upper',
  node_id: null,
  node_label: null,
  created_at: '2026-10-01T00:00:00Z',
  last_at: '2026-10-08T06:00:00Z',
  last_value: 21.50000001,
};

test('where a signal comes from, in words', () => {
  assert.equal(sourceLabel('edge:press-shop-edge'), 'Edge agent press-shop-edge');
  assert.equal(sourceLabel('import:line:2.csv'), 'Import line:2.csv');
  assert.equal(sourceLabel('manual'), 'Entered by hand');
});

test('the latest reading, with its unit', () => {
  assert.match(latest(SIG), /^21\.5 °C · /);
  assert.match(latest({ ...SIG, last_value: 'running' }), /^running · /);
  assert.match(latest({ ...SIG, last_value: true }), /^true · /);
  assert.equal(latest({ ...SIG, last_at: null, last_value: null }), '—');
});

test('the edit form sends only what changed; blanks clear', () => {
  const same = { unit: '°C', rate: '10', description: 'Platen, upper', node: '' };
  assert.deepEqual(changeFrom(same, SIG), {});
  assert.deepEqual(changeFrom({ ...same, unit: ' ', rate: '2,5', node: 'sig-1' }, SIG), {
    unit: null,
    sample_rate_hz: 2.5,
    node_id: 'sig-1',
  });
  assert.deepEqual(changeFrom({ ...same, rate: '' }, SIG), { sample_rate_hz: null });
  assert.equal(changeFrom({ ...same, rate: '0' }, SIG), 'The sample rate is a number of readings per second, above 0.');
  assert.equal(
    changeFrom({ ...same, rate: 'fast' }, SIG),
    'The sample rate is a number of readings per second, above 0.',
  );
});

test('signal changes read as sentences in the audit log', () => {
  const e = {
    action: 'signal.update',
    before: {},
    after: { tag: 'press1.temperature', unit: '°C', node_id: 'sig-1' },
    entity_type: 'signal',
    entity_id: 's1',
  };
  assert.equal(describeAudit(e), 'Changed unit, ontology link of signal press1.temperature');
});

test('the ontology link: the node, a node with an empty label, or one that is gone', () => {
  const ctx = { ui: (_id, defaults) => defaults, state: { repo: { head: { nodes: {} } } } };
  const row = (extra) => resultsTable(ctx, { total: 1, signals: [{ ...SIG, ...extra }] }, false);
  assert.match(row({ node_id: 'sig-1', node_label: 'Platen <b>' }), /<a href="#\/ontology">Platen &lt;b&gt;<\/a>/);
  assert.match(row({ node_id: 'sig-1', node_label: '' }), /<a href="#\/ontology">sig-1<\/a>/);
  assert.match(row({ node_id: 'sig-1', node_label: null }), /missing node/);
});

test('text fields left as they were are not sent, even when stored with spaces', () => {
  const spaced = { ...SIG, unit: 'kg ', description: ' Platen ' };
  const form = { unit: 'kg ', rate: '20', description: ' Platen ', node: '' };
  assert.deepEqual(changeFrom(form, spaced), { sample_rate_hz: 20 });
  assert.deepEqual(changeFrom({ ...form, unit: ' t ' }, spaced), { unit: 't', sample_rate_hz: 20 });
});
