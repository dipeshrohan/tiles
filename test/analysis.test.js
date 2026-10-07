import { test } from 'vitest';
import assert from 'node:assert/strict';
import { correlationFinder, explain, wearCheck } from '../js/lib/analysis.ts';
import { generateCutterBatches, generateWeldPower, CUTTER_VARIABLES, seedOntology } from '../js/lib/data.ts';
import { generateShotHistory } from '../js/lib/physics.ts';
import { workingGraph } from '../js/lib/ontology.ts';
import { ask, SUGGESTIONS } from '../js/lib/copilot.ts';
import { pearson, median, mad, cohensD } from '../js/lib/stats.ts';

test('stats basics', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12);
  assert.ok(mad([1, 1, 1, 1]) === 0);
  assert.ok(cohensD([10, 11, 12], [1, 2, 3]) > 5);
});

test('pooled data hides the tension effect; splitting by material reveals opposite directions', () => {
  const rows = generateCutterBatches();
  const pooled = correlationFinder(rows, CUTTER_VARIABLES);
  assert.ok(Math.abs(pooled[0].effect) < 0.8, `pooled top effect ${pooled[0].effect}`);
  const found = explain(correlationFinder(rows, CUTTER_VARIABLES, { splitBy: 'material' }));
  const bySeg = Object.fromEntries(found.map((f) => [f.segment, f]));
  assert.equal(bySeg.anode.variable, 'tension');
  assert.equal(bySeg.anode.direction, 'high');
  assert.equal(bySeg.cathode.variable, 'tension');
  assert.equal(bySeg.cathode.direction, 'low');
});

test('cathode weld power climbs before the swap while anode stays flat', () => {
  const { series, swapAt } = generateWeldPower();
  assert.ok(wearCheck(series, 'cathode', { until: swapAt }).change > 0.08);
  assert.ok(Math.abs(wearCheck(series, 'anode', { until: swapAt }).change) < 0.02);
});

test('copilot routes each suggestion to the right skill', () => {
  const ctx = {
    graph: workingGraph(seedOntology()),
    batches: generateCutterBatches(),
    weld: generateWeldPower(),
    shots: generateShotHistory(),
  };
  const skills = SUGGESTIONS.map((q) => ask(q, ctx).skill);
  assert.deepEqual(skills, ['root-cause', 'friction', 'wear', 'health', 'lookup']);
  assert.match(ask('Where is Tab Welder W-03?', ctx).text, /^• Machine Tab Welder W-03 — .*Welding Line 2/);
  assert.equal(ask('hello there', ctx).skill, 'help');
  assert.equal(ask('   ', ctx), null);
});

test('every copilot evidence link points at a page that exists', async () => {
  const views = await Promise.all(
    ['home', 'chat', 'ontology', 'quality', 'physics', 'design', 'settings'].map((v) => import(`../js/views/${v}.ts`)),
  );
  const routes = new Set(views.map((m) => `#/${m.default.id}`));
  const ctx = {
    graph: workingGraph(seedOntology()),
    batches: generateCutterBatches(),
    weld: generateWeldPower(),
    shots: generateShotHistory(),
  };
  for (const q of SUGGESTIONS) {
    const { link } = ask(q, ctx);
    assert.ok(routes.has(link), `"${q}" links to ${link}, which is not a page`);
  }
});
