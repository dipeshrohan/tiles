// The menu (U3.06, js/lib/nav.ts): what each person chose, and the menu it draws.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { cleanPrefs, DEFAULT_PREFS, navHtml, toggleFold, togglePin, visited } from '../js/lib/nav.ts';

const PAGES = ['home', 'warnings', 'signals', 'explorer', 'settings'];
const groups = [
  { id: 'g0', title: '', pages: [{ id: 'home', title: 'Home', icon: 'house' }] },
  {
    id: 'data',
    title: 'Data',
    pages: [
      { id: 'signals', title: 'Signals', icon: 'activity' },
      { id: 'explorer', title: 'Data <explorer>', icon: 'chart-line' },
    ],
  },
  { id: 'ops', title: 'Operations', pages: [{ id: 'warnings', title: 'Warnings', icon: 'triangle-alert' }] },
];

test('kept choices are checked: pages that are gone, repeats and junk are left out', () => {
  assert.deepEqual(
    cleanPrefs({ pinned: ['signals', 'gone', 'signals', 3], recent: 'x', rail: 'yes', folded: ['data', 1] }, PAGES),
    {
      folded: ['data'],
      pinned: ['signals'],
      recent: [],
      rail: false,
    },
  );
  assert.deepEqual(cleanPrefs(null, PAGES), DEFAULT_PREFS);
});

test('the last five pages, latest first; Home is not one; pins and folds toggle', () => {
  let p = DEFAULT_PREFS;
  for (const id of ['home', 'warnings', 'signals', 'explorer', 'settings', 'a', 'b', 'warnings']) p = visited(p, id);
  assert.deepEqual(p.recent, ['warnings', 'b', 'a', 'settings', 'explorer']);
  p = togglePin(togglePin(p, 'signals'), 'explorer');
  assert.deepEqual(p.pinned, ['signals', 'explorer']);
  assert.deepEqual(togglePin(p, 'signals').pinned, ['explorer']);
  assert.deepEqual(toggleFold(toggleFold(p, 'data'), 'data').folded, []);
});

test('the menu marks the page shown once, folds groups, and says its counts', () => {
  const html = navHtml({
    groups,
    active: 'signals',
    prefs: { folded: ['ops'], pinned: ['signals'], recent: ['signals', 'warnings'], rail: false },
    badges: { warnings: { count: 120, tone: 'bad', says: '120 open warning(s)' } },
  });
  // The menu's own link is the current page; the pinned copy isn't a second "here".
  assert.equal(html.match(/aria-current="page"/g)?.length, 1);
  assert.match(html, /data-key="nav-pinned-signals"/);
  // Recent: not the page shown, nor a pinned one.
  assert.match(html, /data-key="nav-recent-warnings"/);
  assert.doesNotMatch(html, /data-key="nav-recent-signals"/);
  // A folded group: its heading says so, its list is hidden.
  assert.match(html, /data-nav-fold="ops" aria-expanded="false" aria-controls="nav-list-ops"/);
  assert.match(html, /id="nav-list-ops" hidden/);
  // Counts over 99 shown short, said in full; titles escaped.
  assert.match(html, /aria-hidden="true">99\+<\/span><span class="sr-only">, 120 open warning\(s\)/);
  assert.match(html, /Data &lt;explorer&gt;/);
  assert.match(html, /aria-label="Unpin Signals"/);
  // The rail names each page in a tooltip.
  assert.match(
    navHtml({ groups, active: 'home', prefs: { ...DEFAULT_PREFS, rail: true }, badges: {} }),
    /data-tooltip="Signals"/,
  );
});
