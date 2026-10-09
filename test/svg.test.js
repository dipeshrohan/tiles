import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { dumbbell, fitWidth, hbars, heatmap, lineChart, listed, timeChart } from '../js/lib/svg.ts';

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

// What a screen reader is told about a chart: its name, and the numbers a reader takes from it.
const label = (svg) => {
  const name = svg.match(/aria-label="([^"]*)"/)?.[1];
  assert.equal(svg.match(/<title>([^<]*)<\/title>/)?.[1], name, 'the title says the same');
  assert.match(svg, /role="img"/);
  return name;
};

test('a line chart names its lines and their ranges, its windows and its marks', () => {
  const svg = lineChart({
    series: [
      { values: [1, 2, null, 4.5], color: 'red', label: 'Friction' },
      { values: [3, 3, 3, 3], color: 'blue', label: 'Threshold' },
    ],
    bands: [{ from: 1, to: 2, color: 'pink' }],
    markers: [{ x: 3, label: 'Seizure', color: 'red' }],
    xLabel: 'shot',
    yLabel: 'kN',
    title: 'Plunger friction',
  });
  assert.equal(
    label(svg),
    'Plunger friction. 4 points along shot; Friction 1 to 4.5; Threshold 3; 1 shaded window; marked: Seizure',
  );
  assert.match(
    label(lineChart({ series: [{ values: [5, 6], color: 'x' }], yLabel: 'bar' })),
    /^bar\. 2 points; values 5 to 6$/,
  );
});

test('a time chart gives its span, its values and latest, its levels and shaded stretches', () => {
  const t0 = Date.parse('2026-10-09T10:00:00Z');
  const points = [0, 1, 2].map((i) => ({ t: t0 + i * 60_000, v: 100 + i, lo: 100 + i, hi: 100 + i }));
  const svg = timeChart({
    points,
    from: t0,
    to: t0 + 3 * 60_000,
    gap: 120_000,
    yLabel: 'N',
    title: 'dc1.friction',
    levels: [{ v: 150, label: 'threshold' }],
    spans: [{ from: t0, to: t0 + 60_000 }],
  });
  assert.equal(
    label(svg),
    'dc1.friction. 3 readings from 2026-10-09 10:00 UTC to 2026-10-09 10:03 UTC; values 100 to 102; latest 102 at 2026-10-09 10:02 UTC; threshold 150; 1 shaded stretch',
  );
  const empty = timeChart({ points: [], from: t0, to: t0 + 1, gap: 1, yLabel: 'N' });
  assert.equal(label(empty), 'N. No readings from 2026-10-09 10:00 UTC to 2026-10-09 10:00 UTC');
});

test('bars, dumbbells and heatmaps list their values', () => {
  const bars = hbars({
    items: [
      { label: 'Tension', value: 0.9 },
      { label: 'Speed', value: -0.2 },
    ],
    title: 'Effect size',
    format: (v) => v.toFixed(1),
  });
  assert.equal(label(bars), 'Effect size. Tension 0.9 and Speed -0.2');
  const dumb = dumbbell({ rows: [{ label: 'Anode', a: 12, b: 10 }], domain: [0, 20], xLabel: 'Tension (N)' });
  assert.equal(label(dumb), 'Tension (N). Anode: 12 against 10');
  const heat = heatmap({
    xs: [1, 2],
    ys: [10, 20],
    grid: [
      [5, 6],
      [7, 9],
    ],
    min: 5,
    max: 9,
    xLabel: 'speed',
    yLabel: 'force',
    format: (v) => `${v} mm`,
  });
  assert.equal(
    label(heat),
    'Parameter sweep. 2 × 2 grid of speed by force; lowest 5 mm at speed 1.0, force 10.0; highest 9 mm at speed 2.0, force 20.0',
  );
});

test('lists read as a sentence, and long ones say how many more', () => {
  assert.equal(listed([]), '');
  assert.equal(listed(['a']), 'a');
  assert.equal(listed(['a', 'b', 'c']), 'a, b and c');
  assert.equal(listed(['a', 'b', 'c', 'd'], 2), 'a, b and 2 more');
});
