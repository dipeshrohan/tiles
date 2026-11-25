// The correlation finder page's logic (T3.11): reading a batch table, the failed values, the plot.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { forestPlot, freeName, inferColumns, parseNgValues, typedRows } from '../js/lib/datasets.ts';

test('columns are numbers, true/false or text, by what they hold, with names made unique', () => {
  const header = ['batch', ' tension ', 'ok?', '', 'tension', 'empty'];
  const rows = [
    ['B1', '1006.5', 'yes', '3', '1', ''],
    ['B2', '', 'NO', '4', '2', ''],
    ['B3', '1e3', 'True', 'x', '3', ''],
  ];
  assert.deepEqual(inferColumns(header, rows), [
    { name: 'batch', kind: 'text' },
    { name: 'tension', kind: 'number' },
    { name: 'ok?', kind: 'bool' },
    { name: 'column 4', kind: 'text' },
    { name: 'tension (2)', kind: 'number' },
    { name: 'empty', kind: 'text' },
  ]);
  const columns = inferColumns(header, rows);
  assert.deepEqual(typedRows(rows, columns)[1], {
    batch: 'B2',
    tension: null,
    'ok?': false,
    'column 4': '4',
    'tension (2)': 2,
    empty: null,
  });
  assert.equal(typedRows(rows, columns)[2]['ok?'], true);
});

test('names stay unique when a header already holds the made-up one, or long ones share a start', () => {
  const long = 'x'.repeat(95);
  const names = inferColumns(['a', 'a (2)', 'a', `${long}1`, `${long}2`], []).map((c) => c.name);
  assert.deepEqual(names.slice(0, 3), ['a', 'a (2)', 'a (3)']);
  assert.equal(new Set(names).size, 5);
  assert.ok(names.every((n) => n.length <= 100));
});

test('a new batch table is offered a name no other has (review H-10)', () => {
  assert.equal(freeName('batches', []), 'batches');
  assert.equal(freeName('batches', ['Batches', 'other']), 'batches'); // names are told apart by case, as the API does
  assert.equal(freeName('batches', ['batches']), 'batches (2)');
  assert.equal(freeName('batches', ['batches', 'batches (2)', 'batches (3)']), 'batches (4)');
  assert.equal(freeName('', ['']), '');
  const long = 'x'.repeat(200);
  assert.equal(freeName(long, [long]), `${'x'.repeat(196)} (2)`);
});

test('the failed values are read as the outcome column holds them', () => {
  assert.deepEqual(parseNgValues(' NG , scrap,', 'text'), ['NG', 'scrap']);
  assert.deepEqual(parseNgValues('1, 2.5', 'number'), [1, 2.5]);
  assert.match(String(parseNgValues('one', 'number')), /are numbers/);
  assert.deepEqual(parseNgValues('', 'bool'), [true]);
  assert.deepEqual(parseNgValues('no', 'bool'), [false]);
  assert.match(String(parseNgValues('maybe', 'bool')), /true or false/);
  assert.match(String(parseNgValues(' ', 'text')), /Type the value/);
});

test('the forest plot shows each effect with its interval, coloured by direction when clear', () => {
  const f = (segment, variable, effect, lo, hi, clear) => ({
    segment,
    variable,
    effect,
    ci_low: lo,
    ci_high: hi,
    clear,
    ng_mean: 1,
    ok_mean: 0,
    ng_count: 10,
    ok_count: 10,
    r: 0.3,
  });
  const svg = forestPlot(
    [
      f('anode', 'tension', 2.2, 1.8, 2.6, true),
      f('cathode', 'tension <x>', -2, -2.4, -1.6, true),
      f('all', 'speed', 0.1, -0.2, 0.4, false), // a segment that happens to be called "all"
      f('all', 'few', 0, null, null, false),
    ],
    true,
  );
  assert.equal((svg.match(/<circle class="ci bad"/g) ?? []).length, 1);
  assert.equal((svg.match(/<circle class="ci good"/g) ?? []).length, 1);
  assert.equal((svg.match(/<circle class="ci muted"/g) ?? []).length, 1);
  assert.match(svg, /cathode · tension &lt;x&gt;/);
  assert.match(svg, />all · speed</);
  assert.doesNotMatch(svg, /few/);
  assert.match(forestPlot([f('all', 'speed', 0.1, -0.2, 0.4, false)], false), />speed</);
  assert.match(forestPlot([], false), /No effect could be measured/);
});

test('the forest plot writes a true minus and zero without a sign (review H-17)', () => {
  const svg = forestPlot(
    [
      {
        segment: 'all',
        variable: 'speed',
        effect: -0.4,
        ci_low: -0.001,
        ci_high: 0.34,
        clear: false,
        ng_mean: 1,
        ok_mean: 0,
        ng_count: 10,
        ok_count: 10,
        r: -0.1,
      },
    ],
    false,
  );
  assert.match(svg, /d = −0\.40 \(95% CI 0\.00 to 0\.34\)/);
  assert.doesNotMatch(svg, /-0\.00/);
});
