import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  BOX,
  canvasHeight,
  centerOn,
  fitView,
  hiddenByCollapse,
  hiddenUnder,
  hierarchy,
  layout,
  revealPath,
  searchNodes,
  zoomAt,
} from '../js/lib/canvas.ts';
import { largePlantGraph } from './fixtures/large-plant.js';

const g = (nodes, edges) => ({
  nodes: Object.fromEntries(nodes.map(([id, type]) => [id, { id, type, label: id, props: {} }])),
  edges: Object.fromEntries(edges.map(([from, rel, to]) => [`${from}-${to}`, { id: `${from}-${to}`, from, rel, to }])),
});

const plant = g(
  [
    ['line', 'Line'],
    ['m1', 'Machine'],
    ['m2', 'Machine'],
    ['plc', 'PLC'],
    ['sig', 'Signal'],
    ['shared', 'Signal'],
  ],
  [
    ['line', 'contains', 'm1'],
    ['line', 'contains', 'm2'],
    ['m1', 'controlledBy', 'plc'],
    ['plc', 'emits', 'sig'],
    ['plc', 'emits', 'shared'],
    ['m2', 'contains', 'shared'],
  ],
);

test('collapsing hides what a node contains or emits, but not what another expanded branch shows', () => {
  assert.deepEqual([...hiddenByCollapse(plant, new Set(['plc']))].sort(), ['sig']); // shared is under m2 too
  assert.deepEqual([...hiddenByCollapse(plant, new Set(['plc', 'm2']))].sort(), ['shared', 'sig']);
  // Collapsing the line hides its machines, their PLC and what it emits.
  assert.deepEqual([...hiddenByCollapse(plant, new Set(['line']))].sort(), ['m1', 'm2', 'plc', 'shared', 'sig']);
  assert.equal(hiddenUnder(plant, 'line'), 5);
  assert.deepEqual([...hiddenByCollapse(plant, new Set())], []);
  // A collapsed node inside a collapsed one is hidden; a loop doesn't hide its own top.
  assert.deepEqual([...hiddenByCollapse(plant, new Set(['line', 'plc']))].sort(), ['m1', 'm2', 'plc', 'shared', 'sig']);
  assert.deepEqual([...hiddenByCollapse(plant, new Set(['m1', 'm2']))].sort(), ['plc', 'shared', 'sig']);
  assert.deepEqual([...hiddenByCollapse(plant, new Set(['m1']))].sort(), ['plc', 'sig']); // shared: m2 shows it
  const loop = g(
    [
      ['a', 'Line'],
      ['b', 'Line'],
      ['top', 'Site'],
    ],
    [
      ['top', 'contains', 'a'],
      ['a', 'contains', 'b'],
      ['b', 'contains', 'a'],
    ],
  );
  assert.deepEqual([...hiddenByCollapse(loop, new Set(['a']))], ['b']);
});

test('finding a hidden node names the collapsed nodes to open', () => {
  assert.deepEqual(revealPath(plant, 'shared', new Set(['line', 'plc'])).sort(), ['line', 'plc']);
  assert.deepEqual(revealPath(plant, 'm1', new Set(['plc'])), []);
});

test('a plant of 2,000+ nodes lays out quickly, without overlaps, and about as wide as tall', () => {
  const big = largePlantGraph();
  assert.ok(Object.keys(big.nodes).length > 2000);
  const start = performance.now();
  const h = hierarchy(big);
  const { pos, width, height } = layout(big, () => true, h);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 500, `layout took ${elapsed} ms`);
  assert.equal(pos.size, Object.keys(big.nodes).length);
  const spots = new Set([...pos.values()].map((p) => `${p.x},${p.y}`));
  assert.equal(spots.size, pos.size); // no two nodes in one place
  for (const p of pos.values()) assert.ok(p.x + BOX.w <= width && p.y + BOX.h <= height);
  assert.ok(width / height > 0.5 && width / height < 6, `${width} × ${height}`);
  // Collapsing every PLC hides the 1,792 signals.
  const plcs = Object.values(big.nodes).filter((n) => n.type === 'PLC');
  const hidden = hiddenByCollapse(big, new Set(plcs.map((n) => n.id)), h);
  assert.equal(hidden.size, 1792);
  assert.equal(layout(big, (id) => !hidden.has(id), h).pos.size, Object.keys(big.nodes).length - 1792);
});

test('search finds nodes by every word of the query, best match first', () => {
  const big = largePlantGraph();
  assert.deepEqual(searchNodes(big, 'press 2.3.4'), ['wc2-line3-m4']);
  const signals = searchNodes(big, 'signal 1.1.1.1');
  assert.equal(signals[0], 'wc1-line1-m1-plc-s1'); // the exact label first
  assert.ok(signals.every((id) => big.nodes[id].label.includes('1.1.1.1')));
  assert.equal(searchNodes(big, 'hall 1')[0], 'wc1'); // the label itself before longer ones
  assert.deepEqual(searchNodes(big, '  '), []);
});

test('zoom keeps the point under the pointer still; fit and centre frame the drawing', () => {
  const fit = fitView(3000, 1000, 2);
  assert.deepEqual(fit, { x: 0, y: -250, w: 3000, h: 1500 });
  const zoomed = zoomAt(fit, 2, { x: 1000, y: 500 }, { width: 3000, height: 1000 });
  assert.deepEqual(zoomed, { x: 500, y: 125, w: 1500, h: 750 });
  // The point stays at the same fraction of the view.
  assert.equal((1000 - zoomed.x) / zoomed.w, (1000 - fit.x) / fit.w);
  // Never closer than two columns, never further than twice the drawing.
  assert.equal(zoomAt(fit, 1000, { x: 0, y: 0 }, { width: 3000, height: 1000 }).w, 240);
  assert.equal(zoomAt(fit, 0.001, { x: 0, y: 0 }, { width: 3000, height: 1000 }).w, 6000);
  const centred = centerOn(fit, { x: 2000, y: 400 });
  assert.equal(centred.x + centred.w / 2, 2000 + BOX.w / 2);
  assert.equal(centred.w, 1400);
});

test('a small drawing is never blown up past 1.5×, and the canvas is as tall as the drawing needs', () => {
  // 1,100 × 600 drawing in a 2,200 px wide canvas: 1.5× at most, so the view is 2,200 / 1.5 wide.
  const fit = fitView(1100, 600, 2200 / 900, 2200 / 1.5);
  assert.ok(Math.abs(fit.w - 2200 / 1.5) < 1e-9);
  assert.ok(fit.x < 0); // centred, with room either side
  assert.equal(canvasHeight(1100, 600, 2200, 280, 900), 900); // 600 × 1.5
  assert.equal(canvasHeight(1100, 100, 2200, 280, 900), 280); // never shorter than the minimum
  assert.equal(canvasHeight(3000, 3000, 1500, 280, 900), 900); // nor taller than the window allows
});
