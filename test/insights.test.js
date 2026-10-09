// Saved insights (T3.12), the page's logic: drafts, what a query says, links, who may do what.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  correlationDraft,
  mayDo,
  numberFromHash,
  parseActions,
  readDraft,
  sourceLink,
  sourceText,
} from '../js/lib/insights.ts';

test('actions are one per line, bullets and blank lines dropped, and bounded', () => {
  assert.deepEqual(parseActions(' - Lower tension\n\n• Check rolls \n* Retrain'), [
    'Lower tension',
    'Check rolls',
    'Retrain',
  ]);
  assert.match(String(parseActions(Array.from({ length: 21 }, (_, i) => `a${i}`).join('\n'))), /At most 20/);
  assert.match(String(parseActions('x'.repeat(501))), /500 characters/);
});

test('a draft needs a title and is trimmed', () => {
  assert.equal(readDraft({ title: '  ', summary: '', actions: '' }), 'Give the insight a title');
  assert.match(String(readDraft({ title: 'x'.repeat(201), summary: '', actions: '' })), /200 characters/);
  assert.deepEqual(readDraft({ title: ' Tension ', summary: ' why \n', actions: 'a\nb' }), {
    title: 'Tension',
    summary: 'why',
    actions: ['a', 'b'],
  });
});

test('a correlation drafts its strongest clear effect, or says there was none', () => {
  const result = {
    rows: 720,
    ng: 90,
    ok: 630,
    findings: [],
    explanations: [
      { segment: 'anode', variable: 'tension', text: 'anode: failed batches ran tension higher.' },
      { segment: 'cathode', variable: 'tension', text: 'cathode: failed batches ran tension lower.' },
    ],
  };
  const draft = correlationDraft('Cutter', result);
  assert.equal(draft.title, 'tension separates failed batches (anode)');
  assert.equal(
    draft.summary,
    'Cutter: 720 batch(es), 90 failed.\nanode: failed batches ran tension higher.\ncathode: failed batches ran tension lower.',
  );
  const pooled = { ...result, explanations: [{ segment: 'all', variable: 'speed', text: 'x' }] };
  assert.equal(correlationDraft('Cutter', pooled).title, 'speed separates failed batches');
  assert.equal(correlationDraft('Cutter', { ...result, explanations: [] }).title, 'No clear effect in Cutter');
});

test('a query says what it asked and links back to where it can be asked again', () => {
  const correlation = {
    query: { kind: 'correlation', dataset_id: 'd/1', outcome: 'result', ng_values: ['NG', 'scrap'], split: 'line' },
    evidence: { dataset: { id: 'd/1', name: 'Lots', row_count: 10 } },
  };
  assert.equal(
    sourceText(correlation),
    'Correlation of Lots: outcome result (failed when NG, scrap), split by line, every number column',
  );
  assert.deepEqual(sourceLink(correlation), {
    href: '#/correlate?dataset=d%2F1',
    text: 'Open in the correlation finder',
  });
  const series = {
    query: { kind: 'series', signals: ['a', 'b'], start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' },
    evidence: { series: [{ tag: 'p.temp' }, { tag: 'p.force' }] },
  };
  assert.match(sourceText(series), /^p\.temp, p\.force from /);
  const link = sourceLink(series).href;
  assert.ok(link.startsWith('#/explorer?'));
  const params = new URLSearchParams(link.split('?')[1]);
  assert.deepEqual([params.get('signals'), params.get('from')], ['a,b', '2026-09-01T00:00:00Z']);
});

test('links name an insight by its number', () => {
  assert.equal(numberFromHash('#/insights/12'), 12);
  assert.equal(numberFromHash('#/insights/12?x=1'), 12);
  assert.equal(numberFromHash('#/insights'), null);
  assert.equal(numberFromHash('#/insights/0'), null);
  assert.equal(numberFromHash('#/insights/abc'), null);
  assert.equal(numberFromHash('#/insights/99999999999999999999'), null);
});

test('authors edit, reopen and delete; other engineers review; viewers read', () => {
  const proposed = { status: 'proposed', author_id: 'ann' };
  const rejected = { status: 'rejected', author_id: 'ann' };
  const none = { review: false, edit: false, reopen: false, remove: false };
  assert.deepEqual(mayDo(proposed, 'ann', 'engineer'), { ...none, edit: true, remove: true });
  assert.deepEqual(mayDo(proposed, 'bob', 'engineer'), { ...none, review: true });
  assert.deepEqual(mayDo(proposed, 'bob', 'viewer'), none);
  assert.deepEqual(mayDo(rejected, 'ann', 'engineer'), { ...none, reopen: true, remove: true });
  assert.deepEqual(mayDo(rejected, 'bob', 'engineer'), none);
  assert.deepEqual(mayDo(rejected, 'cat', 'admin'), { ...none, reopen: true, remove: true });
  assert.deepEqual(mayDo(proposed, 'ann', 'viewer'), none); // demoted since
  // Not known yet: nothing that depends on who wrote it.
  assert.deepEqual(mayDo(proposed, null, 'engineer'), none);
  assert.deepEqual(mayDo({ status: 'rejected', author_id: null }, null, 'engineer'), none);
  assert.deepEqual(mayDo({ status: 'proposed', author_id: null }, 'bob', 'engineer'), { ...none, review: true });
});
