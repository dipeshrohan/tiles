import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  FILTERS,
  chips,
  currentView,
  filtersOf,
  menuViews,
  sameFilters,
  unset,
  viewHref,
  viewQuery,
  viewTable,
} from '../js/lib/saved-views.ts';

const view = (o) => ({
  id: 'v1',
  page: 'warnings',
  name: 'x',
  query: {},
  table: null,
  shared: false,
  mine: true,
  owner: 'a',
  updated_at: '',
  ...o,
});

test("a page's filters from a query: unknown values and params dropped, the rest at their fallback", () => {
  assert.deepEqual(filtersOf('warnings', { show: 'raised', who: 'boss', extra: '1' }), {
    show: 'raised',
    who: 'anyone',
    signal: 'all',
  });
  assert.deepEqual(filtersOf('signals', { q: 'press', quality: 'bad' }), {
    q: 'press',
    source: '',
    linked: '',
    quality: 'bad',
  });
  assert.equal(filtersOf('documents', { q: 'x'.repeat(300) }).q.length, 200);
});

test('a view keeps only the filters set, and its address writes every one out', () => {
  const f = filtersOf('warnings', { show: 'raised', who: 'me' });
  assert.deepEqual(viewQuery('warnings', f), { show: 'raised', who: 'me' });
  assert.deepEqual(viewQuery('warnings', filtersOf('warnings', {})), {});
  assert.equal(viewHref(view({ query: { who: 'me' } })), '#/warnings?show=unresolved&who=me&signal=all');
  assert.equal(viewHref(view({ page: 'documents', query: {} })), '#/documents?q=');
  // What the address says is read back as the same filters.
  const back = filtersOf(
    'signals',
    Object.fromEntries(new URLSearchParams(viewHref(view({ page: 'signals', query: { q: 'a&b' } })).split('?')[1])),
  );
  assert.equal(back.q, 'a&b');
});

test('a chip for each filter set, in words; Add filter offers the others', () => {
  const f = filtersOf('signals', { q: 'oven', linked: 'no' });
  assert.deepEqual(chips('signals', f), [
    { param: 'q', text: 'Search: “oven”' },
    { param: 'linked', text: 'Ontology link: Not linked' },
  ]);
  assert.deepEqual(
    unset('signals', f).map((d) => d.param),
    ['source', 'quality'],
  );
  assert.deepEqual(chips('warnings', filtersOf('warnings', { show: 'raised' })), [
    { param: 'show', text: 'Status: New' },
  ]);
  for (const page of Object.keys(FILTERS)) assert.deepEqual(chips(page, filtersOf(page, {})), []);
});

test('the view shown is the one whose filters and table settings are the page’s', () => {
  const table = { sort: { key: 'raised', dir: 'desc' }, hidden: [], density: 'compact' };
  const views = [
    view({ id: 'a', query: { who: 'me' }, table }),
    view({ id: 'b', query: { who: 'me' } }),
    view({ id: 'c', page: 'signals', query: {} }),
  ];
  const mine = filtersOf('warnings', { who: 'me' });
  assert.equal(currentView(views, 'warnings', mine, table)?.id, 'a');
  assert.equal(currentView(views, 'warnings', mine, { ...table, density: 'comfortable' })?.id, 'b');
  assert.equal(currentView(views, 'warnings', filtersOf('warnings', {}), table), null);
  assert.ok(sameFilters('warnings', mine, { who: 'me', show: 'unresolved' }));
  assert.deepEqual(viewTable({ sort: null, hidden: ['a'], widths: { a: 100 }, density: 'compact' }), {
    sort: null,
    hidden: ['a'],
    density: 'compact',
  });
});

test('the menu lists yours first, then shared ones, by page and name, at most eight', () => {
  const views = [
    view({ id: '1', page: 'signals', name: 'B', mine: false, shared: true }),
    view({ id: '2', page: 'documents', name: 'A' }),
    view({ id: '3', page: 'warnings', name: 'Z' }),
    view({ id: '4', page: 'warnings', name: 'C', mine: false, shared: true }),
    ...Array.from({ length: 10 }, (_, i) =>
      view({ id: `x${i}`, page: 'documents', name: `n${i}`, mine: false, shared: true }),
    ),
  ];
  const listed = menuViews(views);
  assert.equal(listed.length, 8);
  assert.deepEqual(
    listed.slice(0, 4).map((v) => v.id),
    ['3', '2', '4', '1'],
  );
});
