import { test } from 'vitest';
import assert from 'node:assert/strict';
import { recordHref, resultHint, searchItems } from '../js/lib/site-search.ts';
import { readRecent } from '../js/lib/palette.ts';

test('each record found opens on its page, named in the address', () => {
  assert.equal(recordHref({ kind: 'signal', id: 'a b' }), '#/explorer?signal=a%20b');
  assert.equal(recordHref({ kind: 'node', id: 'plc/1' }), '#/ontology?node=plc%2F1');
  assert.equal(recordHref({ kind: 'warning', id: 'w1' }), '#/warnings?warning=w1'); // the filters stay
  assert.equal(recordHref({ kind: 'insight', id: '4' }), '#/insights/4');
  assert.equal(recordHref({ kind: 'document', id: '2' }), '#/documents/2');
  assert.equal(recordHref({ kind: 'app', id: '7' }), '#/apps/7');
});

test('results become palette items under their group, with what to know of each', () => {
  const opened = [];
  const items = searchItems(
    {
      query: 'friction',
      groups: [
        {
          kind: 'document',
          label: 'Documents',
          more: false,
          results: [
            { kind: 'document', id: '3', title: 'SOP 14', detail: '3 pages', score: 0.3, page: 2, snippet: 'x' },
          ],
        },
        {
          kind: 'signal',
          label: 'Signals',
          more: true,
          results: [
            { kind: 'signal', id: 's1', title: 'dc1.friction', detail: '', score: 0.6, page: null, snippet: null },
          ],
        },
      ],
    },
    (href) => opened.push(href),
  );
  assert.deepEqual(
    items.map((i) => [i.id, i.label, i.group, i.icon, i.hint, i.href]),
    [
      ['document:3', 'SOP 14', 'Documents', 'file-text', '3 pages · page 2', '#/documents/3'],
      ['signal:s1', 'dc1.friction', 'Signals', 'activity', undefined, '#/explorer?signal=s1'],
    ],
  );
  items[1].run();
  assert.deepEqual(opened, ['#/explorer?signal=s1']);
  assert.equal(resultHint({ detail: '', page: null }), undefined);
});

test('the recent picks kept: ids, and records with an address in the app', () => {
  const record = {
    id: 'warning:w1',
    label: 'dc1.friction',
    group: 'Warnings',
    icon: 'triangle-alert',
    href: '#/warnings?warning=w1',
    scope: 'https://tiles.example.com|site-a',
  };
  assert.deepEqual(readRecent(['page:warnings', record]), ['page:warnings', record]);
  // Anything else is left out: another address, missing fields, not a list.
  const bad = [
    { ...record, href: 'https://example.com' },
    { ...record, icon: 'no-such-icon' },
    { ...record, hint: 3 },
    { ...record, scope: undefined },
    { id: 'x' },
    3,
    null,
  ];
  assert.deepEqual(readRecent(bad), []);
  assert.deepEqual(readRecent('page:home'), []);
});
