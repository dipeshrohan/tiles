// The plant navigator's logic (T5.17): the hierarchy as places, a machine's sheet, finding a
// place, warnings rolled up to places, and its links.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { workingGraph } from '../js/lib/ontology.ts';
import { seedOntology } from '../js/lib/data.ts';
import {
  findPlaces,
  machineSheet,
  machinesUnder,
  parentPlace,
  placeFromHash,
  placeLink,
  placesIn,
  rollUp,
  topPlaces,
  trail,
} from '../js/lib/plant.ts';
import { placeWarning } from '../js/lib/shopfloor.ts';
import { largePlantGraph } from './fixtures/large-plant.js';

const graph = workingGraph(seedOntology());
const labels = (g, ids) => ids.map((id) => g.nodes[id].label);

test('the places: the site at the top, then what each place contains, by name', () => {
  assert.deepEqual(topPlaces(graph), ['site-nk']);
  assert.deepEqual(labels(graph, placesIn(graph, 'site-nk')), ['Cell Assembly', 'Electrode', 'Housing Casting']);
  assert.deepEqual(labels(graph, placesIn(graph, 'wc-cast')), ['Die-cast Line 1']);
  assert.deepEqual(placesIn(graph, 'm-dc02'), []); // signals and PLCs aren't places
  assert.equal(parentPlace(graph, 'm-dc02'), 'ln-dc1');
  assert.equal(parentPlace(graph, 'site-nk'), null);
});

test('names sort as people read them: "Line 2" before "Line 10"', () => {
  const g = { nodes: {}, edges: {} };
  g.nodes.s = { id: 's', type: 'Site', label: 'Site', props: {} };
  for (const n of [10, 2, 1]) {
    g.nodes[`l${n}`] = { id: `l${n}`, type: 'Line', label: `Line ${n}`, props: {} };
    g.edges[`e${n}`] = { id: `e${n}`, from: 's', rel: 'contains', to: `l${n}` };
  }
  assert.deepEqual(labels(g, placesIn(g, 's')), ['Line 1', 'Line 2', 'Line 10']);
});

test('the trail runs from the top to the place, and survives a cycle', () => {
  assert.deepEqual(
    trail(graph, 'm-dc02').map((n) => n.label),
    ['Demo Cell Plant', 'Housing Casting', 'Die-cast Line 1', 'Die-caster DC-02'],
  );
  assert.deepEqual(trail(graph, 'nope'), []);
  const g = structuredClone(graph);
  g.edges.loop = { id: 'loop', from: 'm-dc02', rel: 'contains', to: 'site-nk' };
  assert.equal(trail(g, 'm-dc02').length, 4);
  assert.equal(machinesUnder(g, 'site-nk').length, 3); // no endless walk
});

test('the machines under a place, at any depth', () => {
  assert.deepEqual(labels(graph, machinesUnder(graph, 'site-nk')), [
    'Die-caster DC-02',
    'Notching Cutter C-01',
    'Tab Welder W-03',
  ]);
  assert.deepEqual(machinesUnder(graph, 'ln-dc1'), ['m-dc02']);
  assert.deepEqual(machinesUnder(graph, 'm-dc02'), ['m-dc02']);
  const big = largePlantGraph();
  assert.equal(machinesUnder(big, 'site').length, 128);
  assert.equal(placesIn(big, 'wc1').length, 4);
});

test("a machine's sheet: its PLC's signals, processes and materials, documents and models", () => {
  const sheet = machineSheet(graph, 'm-dc02');
  assert.deepEqual(
    sheet.plcs.map((p) => [p.plc.label, p.signals.map((s) => s.label)]),
    [['PLC DC-02', ['Hydraulic pressure', 'Metal pressure', 'Plunger velocity']]],
  );
  assert.deepEqual(
    sheet.processes.map((p) => [p.process.label, p.materials.map((m) => m.label)]),
    [['High-pressure die casting', ['AlSi10Mg melt']]],
  );
  assert.deepEqual(
    sheet.documents.map((d) => d.label),
    ['DC-02 maintenance manual'],
  );
  assert.deepEqual(
    sheet.models.map((m) => m.label),
    ['Plunger friction virtual sensor'],
  );
  assert.deepEqual([sheet.feedsFrom, sheet.feedsTo, sheet.signals, sheet.parts], [[], [], [], []]);
});

test('a machine also has the signals and parts it contains, and its neighbours on the line', () => {
  const g = structuredClone(graph);
  g.nodes.sx = { id: 'sx', type: 'Signal', label: 'Door switch', props: {} };
  g.nodes.cx = { id: 'cx', type: 'Cell', label: 'Robot cell', props: {} };
  g.edges.a = { id: 'a', from: 'm-dc02', rel: 'contains', to: 'sx' };
  g.edges.b = { id: 'b', from: 'm-dc02', rel: 'contains', to: 'cx' };
  g.edges.c = { id: 'c', from: 'm-cut01', rel: 'feeds', to: 'm-dc02' };
  g.edges.d = { id: 'd', from: 'm-dc02', rel: 'feeds', to: 'm-weld03' };
  const sheet = machineSheet(g, 'm-dc02');
  assert.deepEqual(
    sheet.signals.map((n) => n.label),
    ['Door switch'],
  );
  assert.deepEqual(
    sheet.parts.map((n) => n.label),
    ['Robot cell'],
  );
  assert.deepEqual(
    sheet.feedsFrom.map((n) => n.label),
    ['Notching Cutter C-01'],
  );
  assert.deepEqual(
    sheet.feedsTo.map((n) => n.label),
    ['Tab Welder W-03'],
  );
});

test('finding a place: every word, names that start with it first, with the places above', () => {
  assert.deepEqual(
    findPlaces(graph, 'line').map((h) => h.label),
    ['Cutting Line 1', 'Die-cast Line 1', 'Welding Line 2'],
  );
  assert.deepEqual(findPlaces(graph, 'dc-02 caster'), [
    {
      id: 'm-dc02',
      label: 'Die-caster DC-02',
      type: 'Machine',
      path: ['Demo Cell Plant', 'Housing Casting', 'Die-cast Line 1'],
    },
  ]);
  assert.deepEqual(
    findPlaces(graph, 'cell').map((h) => h.label),
    ['Cell Assembly', 'Demo Cell Plant'],
  );
  assert.deepEqual(findPlaces(graph, '  '), []);
  assert.deepEqual(findPlaces(graph, 'pressure'), []); // signals aren't places
  assert.equal(findPlaces(largePlantGraph(), 'press', 5).length, 5);
});

test('warnings roll up to every place above their machine', () => {
  const w = (id, tag, ended) => ({
    id,
    signal_tag: tag,
    started_at: '2026-10-09T10:00:00Z',
    ended_at: ended,
    status: 'raised',
    assignee: null,
    assignee_id: null,
  });
  const links = new Map([
    ['dc.vel', 'sig-vel'],
    ['weld.power', 'sig-power'],
  ]);
  const items = [
    placeWarning(graph, w('a', 'dc.vel', null), links, ''),
    placeWarning(graph, w('b', 'weld.power', '2026-10-09T10:05:00Z'), links, ''),
    placeWarning(graph, w('c', 'nowhere', null), links, ''),
  ];
  const site = rollUp(graph, items, 'site-nk');
  assert.deepEqual([site.state, site.warnings.map((i) => i.id)], ['out', ['a', 'b']]);
  const weld = rollUp(graph, items, 'wc-asm');
  assert.deepEqual([weld.state, weld.warnings.map((i) => i.id)], ['new', ['b']]);
  assert.deepEqual(rollUp(graph, items, 'wc-elec'), { state: 'ok', warnings: [] });
});

test('links name a place by its id, safely', () => {
  assert.equal(placeLink('m dc/02'), '#/plant/m%20dc%2F02');
  assert.equal(placeFromHash(placeLink('m dc/02')), 'm dc/02');
  assert.equal(placeFromHash('#/plant/m-dc02?x=1'), 'm-dc02');
  assert.equal(placeFromHash('#/plant'), null);
  assert.equal(placeFromHash('#/plant/'), null);
  assert.equal(placeFromHash('#/plant/%E0%A4%A'), null); // broken escapes open the top
  assert.equal(placeFromHash('#/shopfloor'), null);
});
