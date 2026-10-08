import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { fitWidth, lineChart } from '../js/lib/svg.ts';

afterEach(() => {
  delete globalThis.document;
});

const withMain = (clientWidth) => {
  globalThis.document = { querySelector: (sel) => (sel === 'main' ? { clientWidth } : null) };
};

test('charts are drawn to the width the page gives them, within limits', () => {
  assert.equal(fitWidth(1040), 1040); // outside a browser: the design width
  withMain(3204); // an ultrawide screen: (3204 - 48) - 40
  assert.equal(fitWidth(1040), 3116);
  assert.equal(fitWidth(480, 0.5), 1440); // half the page would be 1538: capped at three times 480
  assert.equal(fitWidth(600, 0.5), 1538); // (3156 / 2) - 40
  withMain(900); // a small screen: never narrower than designed (the chart scales down instead)
  assert.equal(fitWidth(1040), 1040);
  withMain(10000); // at most three times the design width
  assert.equal(fitWidth(1040), 3120);
});

test('a chart grows at most one and a half times its drawn size', () => {
  const svg = lineChart({ series: [{ values: [1, 2, 3], color: 'red' }], width: 480, height: 200 });
  assert.match(svg, /viewBox="0 0 480 200" style="max-width:720px"/);
});
