import { test } from 'vitest';
import assert from 'node:assert/strict';
import { announcement, arrivals, bellCount, bellLabel, inboxHtml } from '../js/lib/inbox.ts';

const item = (o) => ({
  key: 'review:1',
  kind: 'review',
  title: 'Change request #1 waits for your review',
  detail: 'Add press 9 (from maria)',
  href: '#/reviews/1',
  at: new Date().toISOString(),
  read: false,
  ...o,
});

test('the bell counts what is unread, and says it', () => {
  assert.equal(bellCount(3), '3');
  assert.equal(bellCount(120), '99+');
  assert.equal(bellLabel(0), 'Notifications, none unread');
  assert.equal(bellLabel(2), 'Notifications, 2 unread');
});

test('only items unread and new since the last ask are announced; none on the first', () => {
  const a = item({ key: 'a' });
  const b = item({ key: 'b', title: 'Warning on press1.temp assigned to you' });
  assert.deepEqual(arrivals(null, [a, b]), []);
  assert.deepEqual(arrivals(new Set(['a']), [a, b]), [b]);
  assert.deepEqual(arrivals(new Set(), [item({ key: 'c', read: true })]), []);
  assert.equal(announcement([b]), 'New notification: Warning on press1.temp assigned to you');
  assert.equal(announcement([a, b]), '2 new notifications');
  assert.equal(announcement([]), '');
});

test('the inbox lists each item linked, escaped, with Mark read while unread', () => {
  const html = inboxHtml([item({ title: '<b>x</b>' }), item({ key: 'k2', read: true })]);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.equal((html.match(/data-inbox-read=/g) ?? []).length, 1);
  assert.match(html, /href="#\/reviews\/1"/);
  assert.match(html, /<span class="sr-only">Unread: <\/span>/);
  assert.match(inboxHtml([]), /Nothing waits for you here/);
});
