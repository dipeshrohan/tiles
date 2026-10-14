import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  clampWidth,
  cleanPrefs,
  sortRows,
  toCsv,
  VIRTUAL_AFTER,
  visibleColumns,
  windowOf,
} from '../js/lib/data-table.ts';

const cols = [
  { key: 'tag', label: 'Tag', value: (r) => r.tag, cell: (r) => `<code>${r.tag}</code>` },
  { key: 'n', label: 'Count', value: (r) => r.n, cell: (r) => String(r.n), numeric: true },
  { key: 'note', label: 'Note', cell: (r) => `<b>${r.note}</b>` },
  { key: 'act', label: 'Actions', srOnly: true, fixed: true, cell: () => '<button>Edit</button>' },
];
const rows = [
  { tag: 'press10', n: 3, note: 'x' },
  { tag: 'press9', n: null, note: 'a, "b"' },
  { tag: 'Press2', n: 12, note: '=SUM(A1)' },
];

test('sorted by a column: numbers and names as people read them, empty ones last, stable', () => {
  assert.deepEqual(
    sortRows(rows, cols, { key: 'tag', dir: 'asc' }).map((r) => r.tag),
    ['Press2', 'press9', 'press10'],
  );
  assert.deepEqual(
    sortRows(rows, cols, { key: 'n', dir: 'desc' }).map((r) => r.n),
    [12, 3, null], // empty last, either way
  );
  assert.deepEqual(
    sortRows(rows, cols, { key: 'n', dir: 'asc' }).map((r) => r.n),
    [3, 12, null],
  );
  assert.deepEqual(sortRows(rows, cols, null), rows); // as the list came
  assert.deepEqual(sortRows(rows, cols, { key: 'note', dir: 'asc' }), rows); // a column without a value doesn't sort
  const ties = [
    { tag: 'a', n: 1 },
    { tag: 'b', n: 1 },
    { tag: 'c', n: 1 },
  ];
  assert.deepEqual(
    sortRows(ties, cols, { key: 'n', dir: 'desc' }).map((r) => r.tag),
    ['a', 'b', 'c'],
  );
});

test('preferences as kept: only known columns and sane values', () => {
  const keys = cols.map((c) => c.key);
  assert.deepEqual(cleanPrefs(null, keys), { sort: null, hidden: [], widths: {}, density: 'comfortable' });
  assert.deepEqual(
    cleanPrefs(
      {
        sort: { key: 'n', dir: 'desc' },
        hidden: ['note', 'gone', 7],
        widths: { tag: 5000, n: 20, gone: 100, note: 'wide' },
        density: 'compact',
      },
      keys,
    ),
    { sort: { key: 'n', dir: 'desc' }, hidden: ['note'], widths: { tag: 800, n: 64 }, density: 'compact' },
  );
  assert.equal(cleanPrefs({ sort: { key: 'gone', dir: 'asc' } }, keys).sort, null);
  assert.equal(cleanPrefs({ sort: { key: 'n', dir: 'up' } }, keys).sort, null);
  assert.equal(clampWidth(100.4), 100);
});

test('columns shown: the first and fixed ones always', () => {
  const prefs = { ...cleanPrefs(null, []), hidden: ['tag', 'note', 'act'] };
  assert.deepEqual(
    visibleColumns(cols, prefs).map((c) => c.key),
    ['tag', 'n', 'act'],
  );
});

test('virtual rows: the window in view, with some above and below; every row when few', () => {
  assert.deepEqual(windowOf(VIRTUAL_AFTER, 5000, 600, 40), { start: 0, end: VIRTUAL_AFTER });
  assert.deepEqual(windowOf(5000, 0, 600, 40), { start: 0, end: 27 });
  assert.deepEqual(windowOf(5000, 4000, 600, 40), { start: 88, end: 127 });
  assert.deepEqual(windowOf(5000, 1e9, 600, 40), { start: 4999, end: 5000 });
  assert.deepEqual(windowOf(5000, -50, 600, 40), { start: 0, end: 27 });
});

test('CSV of the view: its columns (not actions), every row, quoted where needed, no formulas', () => {
  const text = (html) => html.replace(/<[^>]+>/g, '');
  const csv = toCsv(sortRows(rows, cols, { key: 'tag', dir: 'asc' }), cols, text);
  assert.equal(csv, 'Tag,Count,Note\r\nPress2,12,\'=SUM(A1)\r\npress9,,"a, ""b"""\r\npress10,3,x\r\n');
});
