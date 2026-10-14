// Setting up a site (T6.06): slugs, the plant outline as ontology ops, and the agent's config.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { applyOps, emptyGraph } from '../js/lib/ontology.ts';
import {
  agentConfig,
  freeAgentName,
  names,
  outlineOps,
  outlineProblem,
  slugFrom,
  STEPS,
} from '../js/lib/onboarding.ts';
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
  assert.deepEqual(names(' Press 1 \n\nPress 2\nPress 1\r\nPress 3 '), ['Press 1', 'Press 2', 'Press 3']);
  assert.deepEqual(names('Press 4, 400 t\nPress 5'), ['Press 4, 400 t', 'Press 5']); // one per line, commas and all
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

test('a new agent is offered the first free name', () => {
  assert.equal(freeAgentName([]), 'edge-01');
  assert.equal(freeAgentName(['edge-01', 'edge-03']), 'edge-02');
  assert.equal(freeAgentName(['edge-01', 'edge-02', 'edge-03']), 'edge-04');
});

test("the agent's config points at this Tiles, its token in a file beside it", () => {
  const toml = agentConfig('https://tiles.example.com/');
  assert.match(toml, /^\[tiles\]\nurl = "https:\/\/tiles\.example\.com"\ntoken_file = "token"/);
  assert.match(toml, /\[agent\]\nheartbeat_seconds = 30/);
  assert.doesNotMatch(toml, /tla_/); // never a token in the file
});

// ---- in local mode (U4.10) ----
import { seedOntology } from '../js/lib/data.ts';
import { DEMO_TAGS, localProgress, mappedTo, mappingOps, suggestFor } from '../js/lib/onboarding.ts';

test('on the demo plant: its tags are suggested Signal nodes, and mapping them sets up the site', () => {
  let graph = seedOntology().head;
  // Every suggested node is a Signal of the tag's machine, and every machine is one.
  for (const t of DEMO_TAGS) {
    assert.equal(graph.nodes[t.machine]?.type, 'Machine', t.tag);
    if (t.suggest) assert.equal(machineOf(graph, t.suggest), t.machine, t.tag);
  }
  let p = localProgress(graph, { agent: false });
  assert.deepEqual(
    p.steps.map((s) => [s.key, s.done]),
    [
      ['site', true],
      ['outline', true],
      ['agent', false],
      ['mapping', false],
      ['dashboard', false],
    ],
  );
  assert.equal(p.next, 'agent');
  assert.equal(p.steps[1].detail, '3 machines in the ontology');
  p = localProgress(graph, { agent: true });
  assert.equal(p.next, 'mapping');
  assert.equal(p.steps[3].detail, '0 of 6 demo tags mapped');

  const vel = DEMO_TAGS.find((t) => t.tag === 'dc02.plunger_vel');
  assert.deepEqual(suggestFor(graph, vel), {
    kind: 'link',
    node: 'sig-vel',
    label: 'Plunger velocity',
    why: 'Its description matches Plunger velocity, on Die-caster DC-02',
  });
  const temp = DEMO_TAGS.find((t) => t.tag === 'dc02.die_temp');
  assert.equal(suggestFor(graph, temp).kind, 'new');
  assert.match(suggestFor(graph, temp).why, /under PLC DC-02, Die-caster DC-02’s controller/);

  // One tag: its node carries it, and its machine is the first dashboard.
  graph = applyOps(graph, mappingOps(graph, [vel])).graph;
  assert.equal(mappedTo(graph, 'dc02.plunger_vel'), 'sig-vel');
  p = localProgress(graph, { agent: true });
  assert.equal(p.next, null);
  assert.deepEqual(p.dashboard, { id: 'm-dc02', label: 'Die-caster DC-02' });
  assert.equal(p.steps[4].detail, 'Die-caster DC-02: 1 mapped signal');

  // The rest: a new Signal node under the PLC for the one without, nothing twice.
  const ops = mappingOps(graph, DEMO_TAGS);
  assert.equal(ops.filter((o) => o.kind === 'setProp').length, 4);
  assert.deepEqual(
    ops.filter((o) => o.kind !== 'setProp'),
    [
      {
        kind: 'addNode',
        node: {
          id: 'sig-dc02-die-temp',
          type: 'Signal',
          label: 'Die temperature',
          props: { unit: '°C', tag: 'dc02.die_temp' },
        },
      },
      {
        kind: 'addEdge',
        edge: { id: 'plc-dc-emits-sig-dc02-die-temp', from: 'plc-dc', rel: 'emits', to: 'sig-dc02-die-temp' },
      },
    ],
  );
  graph = applyOps(graph, ops).graph;
  assert.equal(mappingOps(graph, DEMO_TAGS).length, 0);
  p = localProgress(graph, { agent: true });
  assert.equal(p.mapped, 6);
  assert.deepEqual(p.dashboard, { id: 'm-dc02', label: 'Die-caster DC-02' }); // 4 of the 6

  // A node taken by another tag, or a machine gone: no link to it.
  const taken = applyOps(seedOntology().head, [{ kind: 'setProp', id: 'sig-vel', key: 'tag', value: 'other' }]).graph;
  assert.equal(suggestFor(taken, vel).kind, 'new');
  const gone = structuredClone(seedOntology().head);
  delete gone.nodes['m-dc02'];
  assert.equal(suggestFor(gone, temp).kind, 'none');
});

test('a suggested node moved to another machine is not linked; new ids never collide', () => {
  const seed = seedOntology().head;
  const hyd = DEMO_TAGS.find((t) => t.tag === 'dc02.hyd_pressure');
  const moved = applyOps(seed, [
    { kind: 'removeEdge', id: 'plc-dc-emits-sig-ph' },
    { kind: 'addEdge', edge: { id: 'plc-cut-emits-sig-ph', from: 'plc-cut', rel: 'emits', to: 'sig-ph' } },
  ]).graph;
  assert.equal(suggestFor(moved, hyd).kind, 'new');
  const temp = DEMO_TAGS.find((t) => t.tag === 'dc02.die_temp');
  const crowded = applyOps(seed, [
    { kind: 'addNode', node: { id: 'sig-dc02-die-temp', type: 'Signal', label: 'Other', props: {} } },
    {
      kind: 'addEdge',
      edge: { id: 'plc-dc-emits-sig-dc02-die-temp-2', from: 'plc-dc', rel: 'emits', to: 'sig-dc02-die-temp' },
    },
  ]).graph;
  const ops = mappingOps(crowded, [temp]);
  assert.deepEqual(
    ops.map((o) => (o.kind === 'addNode' ? o.node.id : o.kind === 'addEdge' ? o.edge.id : o.kind)),
    ['sig-dc02-die-temp-2', 'plc-dc-emits-sig-dc02-die-temp-2-2'],
  );
  assert.doesNotThrow(() => applyOps(crowded, ops));
});
