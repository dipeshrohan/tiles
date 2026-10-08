import { test } from 'vitest';
import assert from 'node:assert/strict';
import { describeChanges } from '../js/lib/review.ts';
import { mayDecide } from '../js/views/reviews.ts';

const head = {
  nodes: {
    p: { id: 'p', type: 'Machine', label: 'Press 1', props: { vendor: 'Acme', tonnage: 900 } },
    s: { id: 's', type: 'Signal', label: 'Force', props: {} },
  },
  edges: { 'p-emits-s': { id: 'p-emits-s', from: 'p', rel: 'emits', to: 's' } },
};
const show = (changes) => changes.map((c) => `${c.sign} ${c.text}${c.problem ? ` [${c.problem}]` : ''}`);

test('each op is described against the committed ontology, with the values it replaces', () => {
  const ops = [
    { kind: 'addNode', node: { id: 't', type: 'Signal', label: 'Temp', props: { unit: '°C' } } },
    { kind: 'addEdge', edge: { id: 'p-emits-t', from: 'p', rel: 'emits', to: 't' } },
    { kind: 'setProp', id: 'p', key: 'vendor', value: 'Bosch' },
    { kind: 'setProp', id: 'p', key: 'tonnage' },
    { kind: 'setProp', id: 'p', key: 'line', value: 2 },
    { kind: 'removeEdge', id: 'p-emits-s' },
    { kind: 'removeNode', id: 's' },
  ];
  assert.deepEqual(show(describeChanges(head, ops)), [
    '+ Signal “Temp” (unit “°C”)',
    '+ Press 1 —emits→ Temp', // the label of a node added by an earlier op
    '~ Press 1 · vendor: “Acme” → “Bosch”',
    '− Press 1 · tonnage (was 900)',
    '+ Press 1 · line = 2',
    '− Press 1 —emits→ Force',
    '− Signal “Force”',
  ]);
});

test('an op that no longer applies says why, and the rest are still described', () => {
  const ops = [
    { kind: 'addNode', node: { id: 's', type: 'Signal', label: 'Force again', props: {} } },
    { kind: 'setProp', id: 's', key: 'unit', value: 'kN' },
  ];
  assert.deepEqual(show(describeChanges(head, ops)), [
    '+ Signal “Force again” [Node s already exists]',
    '+ Force · unit = “kN”',
  ]);
});

test('a decided request is described without comparing it to the head it may now be part of', () => {
  const ops = [
    { kind: 'setProp', id: 'p', key: 'vendor', value: 'Acme' },
    { kind: 'removeNode', id: 'gone' },
    { kind: 'removeEdge', id: 'p-emits-s' },
  ];
  assert.deepEqual(show(describeChanges(head, ops, { compare: false })), [
    '+ Press 1 · vendor = “Acme”',
    '− node gone',
    '− relationship p-emits-s',
  ]);
});

test('approving or rejecting is for another engineer, the one named, or an admin', () => {
  const open = { status: 'open', author_id: 'ana', reviewer_id: null };
  assert.equal(mayDecide(open, 'bo', 'engineer'), true);
  assert.equal(mayDecide(open, 'ana', 'admin'), false); // your own
  assert.equal(mayDecide(open, 'bo', 'viewer'), false);
  assert.equal(mayDecide(open, 'bo', null), false);
  assert.equal(mayDecide({ ...open, status: 'approved' }, 'bo', 'engineer'), false);
  const named = { ...open, reviewer_id: 'cy' };
  assert.equal(mayDecide(named, 'bo', 'engineer'), false);
  assert.equal(mayDecide(named, 'cy', 'engineer'), true);
  assert.equal(mayDecide(named, 'bo', 'admin'), true);
});
