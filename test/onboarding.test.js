// Setting up a site (T6.06): slugs, the plant outline as ontology ops, and the agent's config.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { applyOps, emptyGraph } from '../js/lib/ontology.ts';
import { agentConfig, names, outlineOps, outlineProblem, slugFrom, STEPS } from '../js/lib/onboarding.ts';
import { machineOf } from '../js/lib/shopfloor.ts';
import { machinesUnder, topPlaces } from '../js/lib/plant.ts';

const outline = (over = {}) => ({
  site: 'Plant 2',
  workcenter: 'Housing casting',
  line: 'Die-cast line 1',
  machines: ['Die-caster DC-01', 'Die-caster DC-02'],
  protocol: 'OPC UA',
  ...over,
});

test('the steps run from the site to its first dashboard', () => {
  assert.deepEqual(
    STEPS.map((s) => s.key),
    ['site', 'outline', 'agent', 'mapping', 'dashboard'],
  );
});

test("a site's slug is its name in lower case, digits and dashes", () => {
  assert.equal(slugFrom('Plant 2'), 'plant-2');
  assert.equal(slugFrom('  Werk Köln – Halle 3  '), 'werk-koln-halle-3');
  assert.equal(slugFrom('!!!'), 'site');
  assert.equal(slugFrom('a'.repeat(80)).length, 63);
  assert.match(slugFrom(`${'a'.repeat(62)} b`), /^[a-z0-9][a-z0-9-]{0,62}$/); // no dash left at the end
});

test('machine names: one per line or comma, trimmed, without blanks or repeats', () => {
  assert.deepEqual(names(' Press 1 \n\nPress 2, Press 1\r\nPress 3 '), ['Press 1', 'Press 2', 'Press 3']);
  assert.equal(outlineProblem(outline({ line: ' ' })), 'Name the line');
  assert.equal(outlineProblem(outline({ machines: [] })), 'Name at least one machine');
  assert.equal(outlineProblem(outline()), null);
});

test('the outline becomes the hierarchy, each machine with its PLC', () => {
  const { graph } = applyOps(emptyGraph(), outlineOps(emptyGraph(), outline()));
  const types = Object.values(graph.nodes).map((n) => `${n.type} ${n.label}`);
  assert.deepEqual(types.sort(), [
    'Line Die-cast line 1',
    'Machine Die-caster DC-01',
    'Machine Die-caster DC-02',
    'PLC PLC Die-caster DC-01',
    'PLC PLC Die-caster DC-02',
    'Site Plant 2',
    'Workcenter Housing casting',
  ]);
  assert.deepEqual(topPlaces(graph), ['site-plant-2']);
  assert.deepEqual(machinesUnder(graph, 'site-plant-2'), ['m-die-caster-dc-01', 'm-die-caster-dc-02']);
  assert.equal(graph.nodes['plc-die-caster-dc-01'].props.protocol, 'OPC UA');
  // A signal its PLC emits belongs to the machine: where mapping suggestions put new ones.
  graph.nodes.sig = { id: 'sig', type: 'Signal', label: 'Force', props: {} };
  graph.edges.e = { id: 'e', from: 'plc-die-caster-dc-01', rel: 'emits', to: 'sig' };
  assert.equal(machineOf({ ...graph }, 'sig'), 'm-die-caster-dc-01');
});

test('a second outline joins the site it has, without the workcenter, and its ids never collide', () => {
  const first = applyOps(emptyGraph(), outlineOps(emptyGraph(), outline())).graph;
  const ops = outlineOps(first, outline({ workcenter: '', line: 'Die-cast line 1', machines: ['Die-caster DC-01'] }));
  const { graph } = applyOps(first, ops); // applyOps throws on a duplicate id
  assert.equal(Object.values(graph.nodes).filter((n) => n.type === 'Site').length, 1);
  assert.ok(graph.nodes['line-die-cast-line-1-2']);
  assert.ok(graph.nodes['m-die-caster-dc-01-2']);
  assert.deepEqual(
    Object.values(graph.edges)
      .filter((e) => e.to === 'line-die-cast-line-1-2')
      .map((e) => [e.from, e.rel]),
    [['site-plant-2', 'contains']],
  );
});

test("the agent's config points at this Tiles, its token in a file beside it", () => {
  const toml = agentConfig('https://tiles.example.com/');
  assert.match(toml, /^\[tiles\]\nurl = "https:\/\/tiles\.example\.com"\ntoken_file = "token"/);
  assert.match(toml, /\[agent\]\nheartbeat_seconds = 30/);
  assert.doesNotMatch(toml, /tla_/); // never a token in the file
});
