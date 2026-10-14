import { test } from 'vitest';
import assert from 'node:assert/strict';
import { nextRow, recordFromHash, split } from '../js/lib/split.ts';

test('j and k move through the list: from none open, to the first or the last; not past either end', () => {
  assert.equal(nextRow(5, -1, 1), 0);
  assert.equal(nextRow(5, -1, -1), 4);
  assert.equal(nextRow(5, 2, 1), 3);
  assert.equal(nextRow(5, 2, -1), 1);
  assert.equal(nextRow(5, 4, 1), null);
  assert.equal(nextRow(5, 0, -1), null);
  assert.equal(nextRow(0, -1, 1), null);
});

test('a split view: the list and the record pane, with a way back to the list when a record is open', () => {
  const open = split('<p>list</p>', '<p>record</p>', { open: true, back: '#/warnings?show=all', label: 'warnings' });
  assert.match(
    open,
    /^<div class="split has-record"><div class="split-list"><p>list<\/p><\/div><div class="split-record">/,
  );
  assert.match(open, /<a class="split-back" href="#\/warnings\?show=all">.*Back to the warnings<\/a><p>record<\/p>/);
  const closed = split('<p>list</p>', '<p>choose one</p>', { open: false, back: '#/insights' });
  assert.match(closed, /^<div class="split">/);
  assert.doesNotMatch(closed, /split-back/);
  // The address and the words are escaped.
  assert.match(
    split('', '', { open: true, back: '#/x?a="b"', label: '<list>' }),
    /href="#\/x\?a=&quot;b&quot;">.*Back to the &lt;list&gt;/,
  );
});

test('the record an address names, after its page', () => {
  assert.equal(recordFromHash('reviews', '#/reviews/12'), 12);
  assert.equal(recordFromHash('documents', '#/documents/3?x=1'), 3);
  assert.equal(recordFromHash('documents', '#/documents'), null);
  assert.equal(recordFromHash('reviews', '#/reviews/12abc'), null);
  assert.equal(recordFromHash('reviews', '#/insights/12'), null);
});
