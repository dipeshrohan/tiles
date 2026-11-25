import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  BOX,
  canvasHeight,
  centerOn,
  fitLabel,
  fitView,
  focusView,
  inBox,
  likelyRel,
  minimapPath,
  stepFrom,
  foldedCounts,
  hiddenByCollapse,
  hiddenUnder,
  hierarchy,
  layout,
  revealPath,
  searchNodes,
  widthOf,
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

test('a folded node counts everything hidden below it, not just its children', () => {
  const big = largePlantGraph();
  const h = hierarchy(big);
  const lines = Object.values(big.nodes)
    .filter((n) => n.type === 'Line')
    .map((n) => n.id);
  const collapsed = new Set(lines);
  const counts = foldedCounts(collapsed, hiddenByCollapse(big, collapsed, h), h);
  assert.equal(counts.get('wc1-line1'), 128); // 8 machines, 8 PLCs, 112 signals
  // A child another open branch still shows isn't counted.
  const c = new Set(['plc']);
  assert.equal(foldedCounts(c, hiddenByCollapse(plant, c), hierarchy(plant)).get('plc'), 1); // sig, not shared
});

test('the drawing ends at its last node; search has no cap; a visible node needs nothing opened', () => {
  const lines = g(
    [
      ['a', 'Line'],
      ['b', 'Line'],
    ],
    [],
  );
  assert.equal(layout(lines, () => true).width, BOX.pad + BOX.w + BOX.pad + 2 * 152); // third column, no blank after
  assert.equal(searchNodes(largePlantGraph(), 'signal').length, 1792);
  assert.deepEqual(revealPath(plant, 'shared', new Set(['plc'])), []); // m2 shows it
});

// ---- the builder (U5.05) ----

const grid = new Map([
  ['a', { x: 0, y: 0 }],
  ['b', { x: 152, y: 0 }],
  ['c', { x: 152, y: 38 }],
  ['d', { x: 0, y: 76 }],
  ['far', { x: 152, y: 400 }],
]);

test('the arrow keys move to the nearest node that way, straight across before one off to the side', () => {
  assert.equal(stepFrom(grid, 'a', 'right'), 'b');
  assert.equal(stepFrom(grid, 'b', 'left'), 'a');
  assert.equal(stepFrom(grid, 'a', 'down'), 'd');
  assert.equal(stepFrom(grid, 'c', 'up'), 'b');
  assert.equal(stepFrom(grid, 'd', 'right'), 'c'); // nearer in its row than b
  assert.equal(stepFrom(grid, 'a', 'left'), null); // the edge
  assert.equal(stepFrom(grid, 'gone', 'left'), null);
});

test('a box selects the nodes it touches, dragged from any corner', () => {
  assert.deepEqual(inBox(grid, { x: -5, y: -5, w: 160, h: 50 }).sort(), ['a', 'b', 'c']);
  assert.deepEqual(inBox(grid, { x: 155, y: 45, w: -160, h: -50 }).sort(), ['a', 'b', 'c']);
  assert.deepEqual(inBox(grid, { x: 500, y: 500, w: 10, h: 10 }), []);
});

test('focus selection shows every node selected with a margin, never closer than a readable width', () => {
  const v = focusView(grid, ['a', 'far'], 2);
  assert.ok(v.x <= 0 && v.y <= 0);
  assert.ok(v.x + v.w >= 152 + BOX.w && v.y + v.h >= 400 + BOX.h);
  assert.equal(Math.round((v.w / v.h) * 100) / 100, 2);
  const one = focusView(grid, ['a'], 2);
  assert.ok(one.w >= 240);
  assert.equal(focusView(grid, ['gone'], 2), null);
});

test('the minimap draws every node as one path', () => {
  const d = minimapPath(grid);
  assert.equal(d.match(/M/g).length, grid.size);
  assert.ok(d.startsWith(`M0 0h${BOX.w}v${BOX.h}`));
  const big = layout(largePlantGraph(), () => true);
  assert.equal(minimapPath(big.pos).match(/M/g).length, big.pos.size);
});

test('a drag between two nodes suggests the relationship the data model uses for their types', () => {
  assert.equal(likelyRel('Line', 'Machine'), 'contains');
  assert.equal(likelyRel('Site', 'Workcenter'), 'contains');
  assert.equal(likelyRel('Machine', 'PLC'), 'controlledBy');
  assert.equal(likelyRel('PLC', 'Signal'), 'emits');
  assert.equal(likelyRel('Machine', 'Process'), 'runs');
  assert.equal(likelyRel('Process', 'Material'), 'consumes');
  assert.equal(likelyRel('Document', 'Machine'), 'describes');
  assert.equal(likelyRel('Model', 'Signal'), 'reads');
  assert.equal(likelyRel('Model', 'Machine'), 'monitors');
  assert.equal(likelyRel('Machine', 'Machine'), 'feeds');
});

test('a column is as wide as its longest label, up to a limit, and the rest moves over (review H-14)', () => {
  const lines = {
    nodes: {
      l1: { id: 'l1', type: 'Line', label: 'L1', props: {} },
      l2: { id: 'l2', type: 'Line', label: 'Line two, long', props: {} },
      m: { id: 'm', type: 'Machine', label: 'M', props: {} },
      p: { id: 'p', type: 'PLC', label: 'P'.repeat(80), props: {} },
    },
    edges: {},
  };
  const need = (n) => n.label.length * 12;
  const { pos, width } = layout(lines, () => true, undefined, need);
  assert.equal(pos.get('l1').w, 14 * 12); // the column's longest label
  assert.equal(pos.get('l2').w, 14 * 12);
  assert.equal(pos.get('m').w, BOX.w); // never narrower
  assert.equal(pos.get('p').w, BOX.maxW); // never wider
  // The gap between columns stays as it was.
  assert.equal(pos.get('m').x, pos.get('l1').x + 14 * 12 + BOX.colGap - BOX.w);
  assert.equal(pos.get('p').x, pos.get('m').x + BOX.colGap);
  assert.equal(width, pos.get('p').x + BOX.maxW + BOX.pad);
  // Box selection, focus, the minimap and centring use each node's width.
  assert.deepEqual(inBox(pos, { x: pos.get('l1').x + 150, y: 0, w: 1, h: 100 }), ['l1', 'l2']); // past BOX.w
  assert.ok(minimapPath(pos).includes(`h${14 * 12}v${BOX.h}`));
  assert.equal(focusView(pos, ['p'], 1, 0).x + focusView(pos, ['p'], 1, 0).w / 2, pos.get('p').x + BOX.maxW / 2);
  assert.equal(centerOn({ x: 0, y: 0, w: 100, h: 100 }, pos.get('p')).x, pos.get('p').x + BOX.maxW / 2 - 50);
  assert.equal(widthOf({ x: 0, y: 0 }), BOX.w); // a place without a width is a box's narrowest
  // Without `need`, every node is BOX.w wide, as before.
  assert.ok([...layout(lines, () => true).pos.values()].every((p) => p.w === BOX.w));
});

test('a label too long for its room keeps whole words from its start, for an ellipsis after them (H-14)', () => {
  const measure = (text) => text.length * 10;
  assert.deepEqual(fitLabel('DC-01 die-casting cell', 300, measure, 10), {
    text: 'DC-01 die-casting cell',
    cut: false,
  });
  // Words that fit with the ellipsis: never part of a word (the name's words, for screen readers).
  assert.deepEqual(fitLabel('DC-01 die-casting cell', 200, measure, 10), { text: 'DC-01 die-casting', cut: true });
  assert.deepEqual(fitLabel('DC-01 die-casting cell', 150, measure, 10), { text: 'DC-01', cut: true });
  // A first word too long is kept whole (the page clips it).
  assert.deepEqual(fitLabel('Hydraulikdruckspeicher links', 100, measure, 10), {
    text: 'Hydraulikdruckspeicher',
    cut: true,
  });
  assert.deepEqual(fitLabel('Hydraulikdruckspeicher', 100, measure, 10), { text: 'Hydraulikdruckspeicher', cut: true });
  // Spaces doubled or leading don't make empty words.
  assert.deepEqual(fitLabel(' A  bb cc', 70, measure, 10), { text: ' A  bb', cut: true });
  assert.deepEqual(fitLabel(' A  bb cc', 69, measure, 10), { text: ' A', cut: true });
});
