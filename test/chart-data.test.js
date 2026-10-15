import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  chartCsv,
  chartData,
  chartId,
  fileName,
  hiddenParts,
  nearest,
  readout,
  registerChart,
  step,
  togglePart,
} from '../js/lib/chart-data.ts';
import { lineChart, timeChart } from '../js/lib/svg.ts';

const data = (o = {}) => ({
  title: 'Press 1 temperature',
  xs: [10, 20, 30, 40, 50],
  labels: ['a', 'b', 'c', 'd', 'e'],
  series: [
    { name: 'Average', ys: [1, 2, null, 4, 5], text: ['1 °C', '2 °C', '', '4 °C', '5 °C'] },
    { name: 'Other', ys: [null, null, 3, null, null], text: ['', '', '3', '', ''] },
  ],
  top: 0,
  bottom: 100,
  csv: { head: ['time', 'value'], rows: [['2026-01-01T00:00:00.000Z', 1]] },
  ...o,
});

test('the reading nearest the pointer, among those shown', () => {
  const d = data();
  assert.equal(nearest(d, 9), 0);
  assert.equal(nearest(d, 24), 1);
  assert.equal(nearest(d, 26), 2); // the other series has one there
  assert.equal(
    nearest(d, 32, (k) => k === 0),
    3,
  ); // only the first: 30 has none, and 40 is nearer than 20
  assert.equal(nearest(d, 1000), 4);
  assert.equal(nearest(data({ xs: [], labels: [], series: [] }), 5), null);
});

test('stepping with the keys skips readings with no value, and stops at the ends', () => {
  const d = data();
  const first = (k) => k === 0;
  assert.equal(step(d, 1, 1, first), 3); // over the gap
  assert.equal(step(d, 3, -1, first), 1);
  assert.equal(step(d, 4, 1, first), 4); // held at the end
  assert.equal(step(d, -1, 1, first), 0); // Home
  assert.equal(step(d, 5, -1, first), 4); // End
  assert.equal(step(d, 0, 10, first), 4); // a page past the end: the last
});

test('a reading is read out as its time and each shown value', () => {
  const d = data();
  assert.equal(readout(d, 1), 'b. Average: 2 °C');
  assert.equal(readout(d, 2), 'c. Other: 3');
  assert.equal(
    readout(d, 2, () => false),
    'c',
  );
});

test('CSV of a chart: quoted where needed, formulas kept from running; a file name from its title', () => {
  const csv = chartCsv(
    data({
      csv: {
        head: ['time', 'note'],
        rows: [
          ['t1', 'a, "b"'],
          ['t2', '=1+1'],
        ],
      },
    }),
  );
  assert.equal(csv, 'time,note\r\nt1,"a, ""b"""\r\nt2,\'=1+1\r\n');
  assert.equal(fileName('Press 1 temperature (°C)', 'png'), 'press-1-temperature-c.png');
  assert.equal(fileName('***', 'csv'), 'chart.csv');
});

test('a chart drawn again gets the same id; its data is kept; a legend hides parts by id', () => {
  const d = data();
  assert.equal(chartId(d), chartId(data()));
  assert.notEqual(chartId(d), chartId(data({ labels: ['a', 'b', 'c', 'd', 'x'] })));
  const id = registerChart(d);
  assert.equal(chartData(id), d);
  assert.equal(togglePart(id, 'band'), true);
  assert.deepEqual([...hiddenParts(id)], ['band']);
  assert.equal(togglePart(id, 'band'), false);
  assert.deepEqual([...hiddenParts(id)], []);
});

test('time and line charts register their readings, read out with units, and come with their tools', () => {
  const T0 = Date.parse('2026-08-01T00:00:00Z');
  const box = timeChart({
    points: [0, 1, 2].map((i) => ({ t: T0 + i * 60_000, v: 10 + i, lo: 9 + i, hi: 11 + i })),
    from: T0,
    to: T0 + 3 * 60_000,
    gap: 120_000,
    yLabel: '°C',
    levels: [{ v: 15, label: 'threshold' }],
  });
  const id = /data-chart="([^"]+)"/.exec(box)?.[1];
  const d = chartData(id);
  assert.equal(d.series[0].name, 'Average');
  assert.equal(d.series[0].text[1], '11 °C (min 10, max 12)');
  assert.deepEqual(d.csv.head, ['time', 'average', 'min', 'max']);
  assert.deepEqual(d.csv.rows[0], ['2026-08-01T00:00:00.000Z', 10, 9, 11]);
  assert.match(box, /data-chart-toggle="band"[^>]*>.*Min to max/);
  assert.match(box, /data-chart-toggle="levels"[^>]*>.*threshold/);
  assert.match(box, /data-chart-png/);
  assert.match(box, /<svg [^>]*tabindex="0"/);
  const line = lineChart({
    series: [
      { values: [1, 2], color: 'red', label: 'Friction' },
      { values: [3, null], color: 'blue', label: 'Load' },
    ],
    xLabel: 'shot',
    yLabel: 'kN',
  });
  const ld = chartData(/data-chart="([^"]+)"/.exec(line)?.[1]);
  assert.deepEqual(ld.labels, ['shot 0', 'shot 1']);
  assert.deepEqual(ld.series[1].ys[1], null);
  assert.equal(ld.series[0].text[1], '2 kN');
  assert.deepEqual(ld.csv.rows, [
    ['0', 1, 3],
    ['1', 2, ''],
  ]);
  assert.match(line, /data-chart-toggle="s1"/);
});
