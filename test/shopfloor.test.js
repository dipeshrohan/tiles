// The shopfloor view's logic (T5.16): placing a warning on its machine, the order a shift works
// through them, the machine board and the headline.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { workingGraph } from '../js/lib/ontology.ts';
import { seedOntology } from '../js/lib/data.ts';
import {
  floorOrder,
  headline,
  machineBoard,
  machineOf,
  nodeForTag,
  pathOf,
  placeWarning,
  stateOf,
} from '../js/lib/shopfloor.ts';

const graph = workingGraph(seedOntology());

const warning = (over = {}) => ({
  id: 'w1',
  detector_id: 'd1',
  detector: 'friction',
  signal_id: 's1',
  signal_tag: 'dc02.velocity',
  started_at: '2026-10-09T10:00:00Z',
  last_at: '2026-10-09T10:05:00Z',
  ended_at: null,
  side: 'above',
  peak: 3,
  baseline: 1,
  threshold: 2,
  readings: 4,
  status: 'raised',
  acknowledged_at: null,
  acknowledged_by: null,
  assignee_id: null,
  assignee: null,
  resolved_at: null,
  resolved_by: null,
  outcome: null,
  resolution_note: '',
  ...over,
});

test('a signal belongs to the machine its PLC controls; a model to the machine it monitors', () => {
  assert.equal(machineOf(graph, 'sig-vel'), 'm-dc02');
  assert.equal(machineOf(graph, 'sig-power'), 'm-weld03');
  assert.equal(machineOf(graph, 'plc-cut'), 'm-cut01');
  assert.equal(machineOf(graph, 'mdl-friction'), 'm-dc02');
  assert.equal(machineOf(graph, 'm-dc02'), 'm-dc02');
  assert.equal(machineOf(graph, 'ln-dc1'), null); // above the machines
  assert.equal(machineOf(graph, 'nope'), null);
});

test('a node under a machine in the hierarchy belongs to it', () => {
  const g = structuredClone(graph);
  g.nodes['sig-x'] = { id: 'sig-x', type: 'Signal', label: 'Loose tag', props: {} };
  g.edges['e-x'] = { id: 'e-x', from: 'm-cut01', rel: 'contains', to: 'sig-x' };
  assert.equal(machineOf(g, 'sig-x'), 'm-cut01');
});

test('a cycle in the hierarchy ends the search rather than looping', () => {
  const g = structuredClone(graph);
  g.nodes['a'] = { id: 'a', type: 'Signal', label: 'a', props: {} };
  g.nodes['b'] = { id: 'b', type: 'Cell', label: 'b', props: {} };
  g.edges['ab'] = { id: 'ab', from: 'a', rel: 'contains', to: 'b' };
  g.edges['ba'] = { id: 'ba', from: 'b', rel: 'contains', to: 'a' };
  assert.equal(machineOf(g, 'a'), null);
  assert.deepEqual(pathOf(g, 'a'), ['b']);
});

test('the path above a machine leaves out the site', () => {
  assert.deepEqual(pathOf(graph, 'm-dc02'), ['Housing Casting', 'Die-cast Line 1']);
  assert.deepEqual(pathOf(graph, 'site-nk'), []);
});

test("a tag's node: the catalogue's link, then a Signal node's tag property, then its label", () => {
  const g = structuredClone(graph);
  g.nodes['sig-vel'].props.tag = 'dc02.velocity';
  assert.equal(nodeForTag(g, 'dc02.velocity', new Map()), 'sig-vel');
  assert.equal(nodeForTag(g, 'dc02.velocity', new Map([['dc02.velocity', 'sig-pm']])), 'sig-pm');
  // A link to a node the ontology no longer has falls back to the tag.
  assert.equal(nodeForTag(g, 'dc02.velocity', new Map([['dc02.velocity', 'gone']])), 'sig-vel');
  assert.equal(nodeForTag(g, 'Metal pressure', new Map()), 'sig-pm');
  assert.equal(nodeForTag(g, 'unknown', new Map()), null);
});

test('a warning is placed on its machine, or named by its tag when nothing places it', () => {
  const links = new Map([['dc02.velocity', 'sig-vel']]);
  const placed = placeWarning(graph, warning(), links, 'Peak 3');
  assert.equal(placed.machine, 'Die-caster DC-02');
  assert.equal(placed.machineId, 'm-dc02');
  assert.deepEqual(placed.path, ['Housing Casting', 'Die-cast Line 1']);
  assert.equal(placed.state, 'out');
  assert.equal(placed.detail, 'Peak 3');
  const loose = placeWarning(graph, warning({ signal_tag: 'line9.temp' }), links, '');
  assert.equal(loose.machine, 'line9.temp');
  assert.equal(loose.machineId, null);
  assert.deepEqual(loose.path, []);
});

test("a warning's state: out while its signal is, then new until someone takes it", () => {
  assert.equal(stateOf({ status: 'raised', ended_at: null }), 'out');
  assert.equal(stateOf({ status: 'acknowledged', ended_at: null }), 'out');
  assert.equal(stateOf({ status: 'raised', ended_at: '2026-10-09T10:10:00Z' }), 'new');
  assert.equal(stateOf({ status: 'acknowledged', ended_at: '2026-10-09T10:10:00Z' }), 'taken');
  assert.equal(stateOf({ status: 'resolved', ended_at: null }), 'ok');
});

test('the floor works through signals still out, then untaken warnings, newest first', () => {
  const links = new Map();
  const place = (over) => placeWarning(graph, warning(over), links, '');
  const back = '2026-10-09T11:00:00Z';
  const taken = place({ id: 'taken', status: 'acknowledged', ended_at: back, started_at: '2026-10-09T12:00:00Z' });
  const oldNew = place({ id: 'old-new', ended_at: back, started_at: '2026-10-09T08:00:00Z' });
  const newNew = place({ id: 'new-new', ended_at: back, started_at: '2026-10-09T09:00:00Z' });
  const out = place({ id: 'out', status: 'acknowledged', started_at: '2026-10-09T07:00:00Z' });
  assert.deepEqual(
    [taken, oldNew, newNew, out].sort(floorOrder).map((i) => i.id),
    ['out', 'new-new', 'old-new', 'taken'],
  );
});

test('the board has every machine, those with warnings first, each with its worst state', () => {
  const links = new Map([
    ['dc02.velocity', 'sig-vel'],
    ['weld.power', 'sig-power'],
  ]);
  const items = [
    placeWarning(graph, warning({ id: 'a', status: 'acknowledged', ended_at: '2026-10-09T10:10:00Z' }), links, ''),
    placeWarning(graph, warning({ id: 'b' }), links, ''),
    placeWarning(
      graph,
      warning({ id: 'c', signal_tag: 'weld.power', status: 'acknowledged', ended_at: '2026-10-09T10:10:00Z' }),
      links,
      '',
    ),
  ];
  const tiles = machineBoard(graph, items);
  assert.deepEqual(
    tiles.map((t) => [t.label, t.state, t.warnings]),
    [
      ['Die-caster DC-02', 'out', 2],
      ['Tab Welder W-03', 'taken', 1],
      ['Notching Cutter C-01', 'ok', 0],
    ],
  );
  assert.deepEqual(tiles[2].path, ['Electrode', 'Cutting Line 1']);
});

test('the board orders machines by where they are, "Line 2" before "Line 10"', () => {
  const g = { nodes: {}, edges: {} };
  const node = (id, type, label) => (g.nodes[id] = { id, type, label, props: {} });
  const edge = (from, to) => (g.edges[`${from}-${to}`] = { id: `${from}-${to}`, from, rel: 'contains', to });
  for (const n of [10, 2, 1]) {
    node(`l${n}`, 'Line', `Line ${n}`);
    node(`m${n}`, 'Machine', 'Press');
    edge(`l${n}`, `m${n}`);
  }
  assert.deepEqual(
    machineBoard(g, []).map((t) => t.path[0]),
    ['Line 1', 'Line 2', 'Line 10'],
  );
});

test('the headline says what needs someone', () => {
  const links = new Map();
  const place = (over) => placeWarning(graph, warning(over), links, '');
  assert.deepEqual(headline([]), { tone: 'good', text: 'All clear: no open warnings' });
  assert.deepEqual(headline([place({ status: 'acknowledged', ended_at: '2026-10-09T10:10:00Z' })]), {
    tone: 'warn',
    text: '1 open warning',
  });
  assert.deepEqual(headline([place({}), place({ id: 'w2', ended_at: '2026-10-09T10:10:00Z' })]), {
    tone: 'bad',
    text: '2 open warnings: 1 signal still out, 2 nobody has taken',
  });
});
