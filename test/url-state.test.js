// State in the address (U3.05): the query helpers and the warnings filters' codec.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { queryOf, withQuery } from '../js/lib/url-state.ts';
import { DEFAULT_FILTERS, filtersFromQuery, filtersQuery } from '../js/lib/warnings.ts';

test('a hash keeps its path and gets the query, empty values left out', () => {
  assert.equal(withQuery('#/warnings', { show: 'all', who: null, warning: '' }), '#/warnings?show=all');
  assert.equal(withQuery('#/insights/12?x=1', { status: 'proposed' }), '#/insights/12?status=proposed');
  assert.equal(withQuery('#/signals?q=old', { q: null }), '#/signals');
  assert.equal(withQuery('#/signals', { q: 'press 1 & 2' }), '#/signals?q=press+1+%26+2');
  assert.equal(queryOf('#/signals?q=press+1+%26+2').get('q'), 'press 1 & 2');
  assert.equal([...queryOf('#/signals')].length, 0);
});

test('warnings filters go to the address and back; defaults and nonsense are left out', () => {
  const f = { show: 'all', who: 'me', signal: 'open' };
  assert.deepEqual(filtersFromQuery(new URLSearchParams(withQuery('#/w', filtersQuery(f)).split('?')[1])), f);
  assert.deepEqual(filtersQuery(DEFAULT_FILTERS), { show: null, who: null, signal: null });
  assert.deepEqual(filtersFromQuery(new URLSearchParams('show=everything&who=<script>')), DEFAULT_FILTERS);
});

test("a page's own state is kept for the tab's next load; storage that fails, or junk, keeps nothing", async () => {
  const { loadUi, saveUi } = await import('../js/lib/url-state.ts');
  const store = new Map();
  const storage = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null };
  saveUi(storage, { warnings: { selected: '12' }, design: { tab: 'sweep' } });
  assert.deepEqual(loadUi(storage), { warnings: { selected: '12' }, design: { tab: 'sweep' } });
  store.set('tiles:ui', '{"warnings":3,"signals":{"query":{"q":"x"}},"x":[1]}');
  assert.deepEqual(loadUi(storage), { signals: { query: { q: 'x' } } });
  store.set('tiles:ui', 'not json');
  assert.deepEqual(loadUi(storage), {});
  const failing = {
    setItem: () => {
      throw new Error('full');
    },
    getItem: () => {
      throw new Error('blocked');
    },
  };
  saveUi(failing, { a: {} });
  assert.deepEqual(loadUi(failing), {});
});

test("a page's kept state over its defaults: fields of another kind, nested ones too, come from the defaults", async () => {
  const { mergeKept } = await import('../js/lib/url-state.ts');
  const defaults = { query: { q: '', quality: '' }, selected: null, skipped: [], tab: 'open' };
  // Kept before `quality` was added, with a field since removed and one of the wrong kind.
  const kept = { query: { q: 'press' }, selected: '12', skipped: 'x', tab: 3, gone: true };
  assert.deepEqual(mergeKept(defaults, kept), {
    query: { q: 'press', quality: '' },
    selected: '12',
    skipped: [],
    tab: 'open',
  });
  assert.deepEqual(mergeKept(defaults, 'junk'), defaults);
});
