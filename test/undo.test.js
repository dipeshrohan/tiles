// Undo instead of confirm (U2.03): what an Undo toast sends, when, and what the next load sends.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isRemoving, keepWaiting, removeLater, removeNow, saveWaiting, SAVED_KEY, takeSaved } from '../js/lib/undo.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
const storage = () => {
  const m = new Map();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
    map: m,
  };
};

// Starts a removal; gives what happened, the toast it showed, and how its send ends.
function start(removal, { refuse = false } = {}) {
  const log = [];
  let shown;
  removeLater({
    toast: (message, opts) => (shown = { message, opts }),
    message: 'Conversation deleted',
    removal,
    hide: () => log.push('hide'),
    restore: () => log.push('restore'),
    send: () => (log.push('send'), refuse ? Promise.reject(new Error('refused')) : Promise.resolve()),
    sent: () => void log.push('sent'),
  });
  return { log, toast: shown };
}

const r = (id) => ({ kind: 'conversation', api: 'http://api', site: 's1', id });

test('an Undo toast hides at once, and Undo puts it back with nothing sent', async () => {
  const { log, toast } = start(r('a'));
  assert.deepEqual(log, ['hide']);
  assert.equal(isRemoving(r('a')), true);
  assert.equal(toast.opts.action.label, 'Undo');
  assert.equal(toast.opts.duration, 8000);
  assert.equal(toast.opts.distinct, true); // never merged with another "Conversation deleted"
  toast.opts.action.run();
  toast.opts.onDone(); // the toaster doesn't call it after the action, but it would do nothing
  await tick();
  assert.deepEqual(log, ['hide', 'restore']);
  assert.equal(isRemoving(r('a')), false);
});

test('when the toast goes, the change is sent once; refused, it comes back', async () => {
  const ok = start(r('b'));
  ok.toast.opts.onDone();
  ok.toast.opts.onDone();
  await tick();
  assert.deepEqual(ok.log, ['hide', 'send', 'sent']);
  assert.equal(isRemoving(r('b')), false);
  // Once sent, leaving the page doesn't save it to be sent again.
  const s = storage();
  saveWaiting(s);
  assert.equal(s.map.has(SAVED_KEY), false);
  ok.toast.opts.action.run(); // too late to undo: nothing happens
  assert.deepEqual(ok.log, ['hide', 'send', 'sent']);

  const no = start(r('c'), { refuse: true });
  no.toast.opts.onDone();
  await tick();
  assert.deepEqual(no.log, ['hide', 'send', 'restore']);
  assert.equal(isRemoving(r('c')), false);
});

test('a page left with a toast showing saves its removals for the next load of the same API', () => {
  const s = storage();
  start(r('d'));
  start({ ...r('e'), api: 'http://other' });
  saveWaiting(s);
  assert.equal(JSON.parse(s.map.get(SAVED_KEY)).length, 2);
  assert.deepEqual(takeSaved(s, 'http://api'), [r('d')]);
  assert.deepEqual(takeSaved(s, 'http://api'), []); // taken: sent once
  assert.deepEqual(takeSaved(s, 'http://other'), [{ ...r('e'), api: 'http://other' }]);
  assert.equal(s.map.has(SAVED_KEY), false);
  // Back from the back/forward cache, the page's own toasts carry on: nothing is kept saved.
  saveWaiting(s);
  keepWaiting(s);
  assert.equal(s.map.has(SAVED_KEY), false);
  // Whatever is stored that isn't a removal is left out.
  s.setItem(SAVED_KEY, JSON.stringify([{ kind: 'warning', api: 'http://api', site: 's', id: 'x' }, 7]));
  assert.deepEqual(takeSaved(s, 'http://api'), []);
  s.setItem(SAVED_KEY, '{not json');
  assert.deepEqual(takeSaved(s, 'http://api'), []);
});

test('archiving with Undo: sent at once, Undo restores, a refusal shows no toast', async () => {
  const toasts = [];
  const log = [];
  const done = await removeNow({
    toast: (message, opts) => toasts.push({ message, opts }),
    message: 'Archived SOP 14',
    send: () => (log.push('archive'), Promise.resolve()),
    undo: () => (log.push('restore'), Promise.resolve()),
    restored: () => log.push('redraw'),
    restoredMessage: 'Restored SOP 14',
  });
  assert.equal(done, true);
  assert.equal(toasts[0].message, 'Archived SOP 14');
  toasts[0].opts.action.run();
  await tick();
  assert.deepEqual(log, ['archive', 'restore', 'redraw']);
  assert.equal(toasts[1].message, 'Restored SOP 14');

  const refused = await removeNow({
    toast: (message) => toasts.push({ message }),
    message: 'Archived #2',
    send: () => Promise.reject(new Error('403')),
    undo: () => Promise.resolve(),
    restored: () => undefined,
    restoredMessage: 'Restored #2',
  });
  assert.equal(refused, false);
  assert.equal(toasts.length, 2);
});
