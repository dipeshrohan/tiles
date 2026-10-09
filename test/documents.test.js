import { test } from 'vitest';
import assert from 'node:assert/strict';
import { contentTypeOf, pageFragment, sizeText, snippetHtml, titleFrom } from '../js/lib/documents.ts';

test('a file is sent as a PDF, text or Markdown, by its type or name', () => {
  assert.equal(contentTypeOf({ name: 'SOP-14.PDF', type: '' }), 'application/pdf');
  assert.equal(contentTypeOf({ name: 'notes', type: 'text/plain' }), 'text/plain');
  assert.equal(contentTypeOf({ name: 'lessons.md', type: '' }), 'text/markdown');
  assert.equal(contentTypeOf({ name: 'scan.png', type: 'image/png' }), null);
});

test('titles, sizes and pages', () => {
  assert.equal(titleFrom('SOP_14  die-casting start-up.pdf'), 'SOP 14 die-casting start-up');
  assert.equal(sizeText(512), '512 B');
  assert.equal(sizeText(2048), '2 KB');
  assert.equal(sizeText(3.5 * 1024 * 1024), '3.5 MB');
  assert.equal(pageFragment('application/pdf', 3), '#page=3');
  assert.equal(pageFragment('text/plain', 3), '');
});

test('a snippet is escaped, with its matches marked', () => {
  assert.equal(
    snippetHtml('Before start-up, check the \u0002hydraulic\u0003 <pressure> & more'),
    'Before start-up, check the <mark>hydraulic</mark> &lt;pressure&gt; &amp; more',
  );
});
