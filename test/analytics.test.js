// UX analytics, privacy first (U1.09): only names from the vocabulary are kept, nothing while it is
// off, and events go in batches that a failure doesn't lose.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createTracker, keepLeft, LEFT_KEY, newSession, takeLeft, UX_NAME, uxName } from '../js/lib/analytics.ts';
import { countsHtml } from '../js/views/ux-analytics.ts';

const tracker = (send) => {
  let tick = () => {};
  const t = createTracker({ send, schedule: (run) => (tick = run) });
  return { t, tick: () => tick() };
};

test('nothing is kept while it is off, and turning it off drops what waits', () => {
  const sent = [];
  const { t } = tracker(async (e) => sent.push(e));
  t.track('page', 'warnings');
  assert.equal(t.waiting, 0);
  t.setEnabled(true);
  t.track('page', 'warnings');
  assert.equal(t.waiting, 1);
  t.setEnabled(false);
  assert.equal(t.waiting, 0);
});

test('only plain names of the known kinds: never free text, e-mails or ids', () => {
  const { t } = tracker(async () => {});
  t.setEnabled(true);
  for (const name of ['Warnings', 'eng@example.com', 'a b', '', 'x'.repeat(65), '-lead']) t.track('page', name);
  t.track('click', 'warnings');
  assert.equal(t.waiting, 0);
  t.track('task', 'warning.acknowledge');
  t.track('error', 'api.404');
  assert.equal(t.waiting, 2);
  assert.equal(uxName('Signals & tags'), 'signals-tags');
  assert.equal(uxName('Pages'), 'pages');
  assert.match(uxName('Recent pages'), UX_NAME);
  assert.match(newSession(), /^[0-9a-f]{32}$/);
  assert.notEqual(newSession(), newSession());
});

test('events go in batches on the timer; a failed send keeps them for the next', async () => {
  const sent = [];
  let fail = true;
  const { t, tick } = tracker(async (e) => {
    if (fail) throw new Error('offline');
    sent.push(e);
  });
  t.setEnabled(true);
  t.track('page', 'home');
  t.track('page', 'warnings');
  tick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.waiting, 2);
  fail = false;
  await t.flush();
  assert.deepEqual(sent, [
    [
      { kind: 'page', name: 'home' },
      { kind: 'page', name: 'warnings' },
    ],
  ]);
  assert.equal(t.waiting, 0);
  // 50 waiting are sent at once, without the timer.
  for (let k = 0; k < 50; k++) t.track('task', 'signal.plotted');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].length, 50);
});

test('admins see counts, by kind, with the names escaped', () => {
  const html = countsHtml({
    enabled: true,
    days: 30,
    sessions: 3,
    counts: [{ kind: 'task', name: 'warning.<b>', events: 1200, sessions: 2 }],
  });
  assert.match(html, /3 browser session\(s\) in the last 30 days/);
  assert.match(html, /<td>Task done<\/td><td><code>warning\.&lt;b&gt;<\/code><\/td><td class="num">1,200<\/td>/);
  assert.match(countsHtml({ enabled: false, days: 30, sessions: 0, counts: [] }), /hasn’t turned UX analytics on/);
});

test('a batch on its way is out of the queue: turning off meanwhile, or new events, lose nothing else', async () => {
  let release;
  const sent = [];
  const { t } = tracker(
    (e) =>
      new Promise((ok, no) => {
        release = (good) => (good ? (sent.push(e), ok()) : no(new Error('down')));
      }),
  );
  t.setEnabled(true);
  t.track('page', 'home');
  const first = t.flush();
  t.track('page', 'warnings'); // arrives while the first is on its way
  release(true);
  await first;
  assert.equal(t.waiting, 1);
  // Failed, it comes back in front, unless the queue was emptied meanwhile.
  const second = t.flush();
  t.track('page', 'signals');
  release(false);
  await second;
  assert.equal(t.waiting, 2);
  const third = t.flush();
  t.setEnabled(false);
  t.setEnabled(true);
  release(false);
  await third;
  assert.equal(t.waiting, 0);
});

test('what a page leaves unsent is kept for the next load of the same site', () => {
  const m = new Map();
  const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  const left = { api: 'http://api', site: 's1', session: 'abcdef0123456789', events: [{ kind: 'page', name: 'home' }] };
  keepLeft(storage, left);
  assert.equal(takeLeft(storage, 'http://api', 's2'), null); // another site's: let go
  assert.equal(m.has(LEFT_KEY), false);
  keepLeft(storage, left);
  assert.deepEqual(takeLeft(storage, 'http://api', 's1'), left);
  assert.equal(takeLeft(storage, 'http://api', 's1'), null); // once
  // Nothing outside the vocabulary comes back from storage.
  m.set(LEFT_KEY, JSON.stringify({ ...left, events: [{ kind: 'page', name: 'eng@example.com' }] }));
  assert.equal(takeLeft(storage, 'http://api', 's1'), null);
});
