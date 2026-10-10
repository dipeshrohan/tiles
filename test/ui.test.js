// Shared components (U1.04, U2.04, U2.05) and the command palette's ranking (U4.02).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  apiUnreachable,
  attrs,
  badge,
  breadcrumbs,
  button,
  card,
  chip,
  emptyState,
  errorState,
  field,
  iconButton,
  input,
  kv,
  linkButton,
  loadingState,
  options,
  pageHead,
  skeleton,
  select,
  table,
  tabs,
} from '../js/lib/ui.ts';
import { illustration } from '../js/lib/illustrations.ts';
import { grouped, rank, score } from '../js/lib/palette.ts';

test('an empty state says why, and what to do next, with its text escaped', () => {
  const html = emptyState({
    illustration: 'inbox',
    title: 'No <apps> yet',
    body: 'Make "one"',
    action: '<a class="btn" href="#/apps/new">New app</a>',
  });
  assert.match(html, /^<div class="empty empty-state">/);
  assert.match(html, /<svg class="illustration"[^>]*aria-hidden="true"/);
  assert.match(html, /<h2 class="empty-title">No &lt;apps&gt; yet<\/h2>/);
  assert.match(html, /<p>Make &quot;one&quot;<\/p>/);
  assert.match(html, /<div class="empty-action"><a class="btn" href="#\/apps\/new">New app<\/a><\/div>/);
  // Compact (in a list), an alert (something failed), and no picture.
  const failed = emptyState({ title: 'Failed', compact: true, alert: true });
  assert.match(failed, /class="empty empty-state compact" role="alert"/);
  assert.doesNotMatch(failed, /<svg/);
  // At another heading level, and as an example rather than an alert.
  assert.match(emptyState({ title: 'x', level: 4 }), /<h4 class="empty-title">x<\/h4>/);
  assert.doesNotMatch(errorState({ title: 'x', alert: false }), /role="alert"/);
});

test('loading shows shapes for the eye, after a moment, and words for screen readers', () => {
  const html = loadingState('Loading <runs>…', 2);
  assert.match(html, /^<div class="loading loading-text"><span class="sr-only">Loading &lt;runs&gt;…<\/span>/);
  // The words are beside the busy shapes, which wait until 300 ms after loading began.
  assert.match(html, /<div class="loading-shapes" aria-hidden="true" aria-busy="true" style="--wait:\d+ms">/);
  assert.equal(html.match(/class="skeleton"/g)?.length, 2);
});

test('skeletons come in the shape of what loads', () => {
  // A table: a header row and the rows, each with its cells.
  const table = skeleton.table(3, 4, 'Loading the signals…');
  assert.equal(table.match(/class="skeleton-row/g)?.length, 4);
  assert.equal(table.match(/class="skeleton"/g)?.length, 16);
  assert.match(table, /<span class="sr-only">Loading the signals…<\/span>/);
  assert.match(skeleton.card(), /skeleton-title/);
  assert.match(skeleton.chart('Loading', 180), /class="skeleton skeleton-chart" style="--h:180px"/);
  assert.equal(skeleton.list(2).match(/class="skeleton-item"/g)?.length, 2);
  for (const html of [table, skeleton.card(), skeleton.chart(), skeleton.list(), skeleton.text()])
    assert.match(html, /aria-busy="true"/);
  // Rows differ, as text does; a card can hold a chart.
  const rows = table.split('class="skeleton-row"').slice(1);
  assert.notEqual(rows[0], rows[1]);
  assert.match(skeleton.card('Loading', { chart: 120 }), /skeleton-chart" style="--h:120px"/);
});

test('a busy button keeps its label (and width and name) under a spinner, and waits', () => {
  const html = button('Save', { variant: 'primary', busy: true });
  assert.match(html, /^<button class="btn primary busy" type="button" disabled aria-busy="true">/);
  assert.match(html, /<span class="btn-label">Save<\/span><span class="btn-spinner" aria-hidden="true"><svg/);
});

test('every illustration is a decorative picture that follows the theme', () => {
  for (const name of [
    'connect',
    'inbox',
    'search',
    'chart',
    'documents',
    'chat',
    'select',
    'error',
    'done',
    'launch',
  ]) {
    const svg = illustration(name);
    assert.match(svg, /^<svg class="illustration" viewBox="0 0 160 120"/, name);
    assert.doesNotMatch(svg, /#[0-9a-f]{3,6}\b/i, `${name} has a fixed colour`); // colours come from classes
  }
});

test('the palette ranks a label that starts with the query first, then words, then anywhere, then letters', () => {
  const items = [
    { label: 'Data explorer' },
    { label: 'Warning performance' },
    { label: 'Warnings' },
    { label: 'Settings', keywords: 'preferences account' },
    { label: 'Shopfloor' },
  ];
  assert.deepEqual(
    rank(items, 'warn').map((i) => i.label),
    ['Warning performance', 'Warnings'], // both start with it: their order is kept
  );
  assert.deepEqual(
    rank(items, 'exp').map((i) => i.label),
    ['Data explorer'],
  );
  assert.deepEqual(
    rank(items, 'pref').map((i) => i.label),
    ['Settings'],
  ); // a keyword
  assert.deepEqual(
    rank(items, 'shpfl').map((i) => i.label),
    ['Shopfloor'],
  ); // letters in order
  assert.equal(score({ label: 'Plant' }, 'zz'), 0);
  // Keywords match words, not scattered letters ("warn" in "wizard agent").
  assert.equal(score({ label: 'Set up a site', keywords: 'onboarding wizard agent' }, 'warn'), 0);
  assert.ok(score({ label: 'Set up a site', keywords: 'onboarding wizard agent' }, 'wiz') > 0);
  assert.equal(rank(items, '  ').length, items.length); // nothing typed: everything
});

test('palette results stay together by group, the best group first', () => {
  const items = [
    { label: 'a', group: 'Pages' },
    { label: 'b', group: 'Actions' },
    { label: 'c', group: 'Pages' },
    { label: 'd', group: 'Signals' },
    { label: 'e', group: 'Actions' },
  ];
  assert.deepEqual(
    grouped(items).map((i) => i.label),
    ['a', 'c', 'b', 'e', 'd'],
  );
});

const EVIL = '<b x="1">&\'';
const SAFE = '&lt;b x=&quot;1&quot;&gt;&amp;&#39;';

test('attributes are escaped; true is bare, false and null are left out', () => {
  assert.equal(attrs({ a: EVIL, b: true, c: false, d: null, e: undefined, n: 3 }), ` a="${SAFE}" b n="3"`);
});

test('buttons: variants, sizes, an icon, a type, and every text escaped', () => {
  assert.equal(button('Save'), '<button class="btn" type="button">Save</button>');
  assert.equal(
    button(EVIL, { variant: 'primary', size: 'sm', type: 'submit', disabled: true, attrs: { 'data-x': EVIL } }),
    `<button class="btn sm primary" type="submit" disabled data-x="${SAFE}">${SAFE}</button>`,
  );
  assert.match(
    button('Retry', { icon: 'refresh-cw' }),
    /^<button class="btn" type="button"><svg[^>]*aria-hidden="true"[\s\S]*<\/svg> Retry<\/button>$/,
  );
  // An icon alone is named for screen readers and in a tooltip.
  assert.match(
    iconButton('x', 'Close <it>'),
    /^<button class="btn icon" type="button" aria-label="Close &lt;it&gt;" data-tooltip="Close &lt;it&gt;"><svg/,
  );
  assert.equal(
    linkButton('Settings', '#/settings', { variant: 'ghost' }),
    '<a class="btn ghost" href="#/settings">Settings</a>',
  );
});

test('badges, chips and cards', () => {
  assert.equal(badge(EVIL, 'bad', { title: EVIL }), `<span class="badge bad" title="${SAFE}">${SAFE}</span>`);
  assert.equal(badge('Plain'), '<span class="badge">Plain</span>');
  assert.equal(
    chip('Line', { pressed: false }),
    '<button class="chip" type="button" aria-pressed="false">Line</button>',
  );
  // A card's body is markup the caller built; its attributes are escaped.
  assert.equal(
    card('<p>x</p>', { class: 'stack', attrs: { 'data-y': EVIL } }),
    `<div class="card stack" data-y="${SAFE}"><p>x</p></div>`,
  );
});

test('a page head has an eyebrow, a title, a lead and actions', () => {
  assert.equal(
    pageHead({ eyebrow: 'Data', title: EVIL, lead: 'Why', actionsHtml: '<a>x</a>' }),
    `<div class="page-head"><div><div class="eyebrow">Data</div><h1 class="page-title">${SAFE}</h1><p class="soft">Why</p></div><a>x</a></div>`,
  );
  // An example of one inside a page isn't a second title for it.
  assert.match(pageHead({ title: 'Signals', level: 4 }), /<h4 class="page-title">Signals<\/h4>/);
});

test('fields: the label wraps the control, a hint is read with it', () => {
  assert.equal(input({ name: 'q', value: EVIL }), `<input type="text" name="q" value="${SAFE}">`);
  assert.equal(field('Unit', input({ name: 'u' })), '<label class="field">Unit<input type="text" name="u"></label>');
  const hinted = field('Rate', input({ name: 'r' }), { hint: 'Per <second>' });
  const id = /aria-describedby="([^"]+)"/.exec(hinted)?.[1];
  assert.ok(id);
  assert.match(hinted, new RegExp(`<span class="small soft" id="${id}">Per &lt;second&gt;</span></label>$`));
  assert.equal(
    field('Who', '<select></select>', { inline: true }),
    '<label class="row gap-1_5">Who <select></select></label>',
  );
});

test('selects mark the current option and escape the rest', () => {
  assert.equal(
    options(
      [
        ['a', 'A'],
        [EVIL, EVIL],
      ],
      EVIL,
    ),
    `<option value="a">A</option><option value="${SAFE}" selected>${SAFE}</option>`,
  );
  assert.equal(
    select(null, [['x', 'X']], 'y', { attrs: { 'data-f': 'w' } }),
    '<select data-f="w"><option value="x">X</option></select>',
  );
});

test('tables name their headers; an action column is for screen readers', () => {
  const html = table({
    headers: ['Tag', { label: 'Actions', srOnly: true }],
    rowsHtml: '<tr><td>a</td><td></td></tr>',
  });
  assert.equal(
    html,
    '<div class="table-wrap"><table><thead><tr><th scope="col">Tag</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody><tr><td>a</td><td></td></tr></tbody></table></div>',
  );
  assert.equal(
    kv([[EVIL, EVIL]], { valueClass: 'mono' }),
    `<div class="table-wrap"><table class="small"><tbody><tr><th scope="row">${SAFE}</th><td class="mono">${SAFE}</td></tr></tbody></table></div>`,
  );
});

test('the filter tabs are toggle buttons, the current one pressed', () => {
  const html = tabs({
    label: 'Status',
    items: [
      ['new', 'New'],
      ['all', 'All'],
    ],
    current: 'all',
    data: 'show',
  });
  assert.match(html, /^<div class="tabs" role="group" aria-label="Status">/);
  assert.match(html, /<button class="tab" type="button" aria-pressed="false" data-show="new">New<\/button>/);
  assert.match(html, /<button class="tab active" type="button" aria-pressed="true" data-show="all">All<\/button>/);
});

test('an error state is an alert, with a way to try again', () => {
  const html = errorState({ title: 'Failed', retry: 'retry-docs', compact: true });
  assert.match(html, /role="alert"/);
  assert.match(html, /<button class="btn sm" type="button" data-retry-docs><svg[\s\S]*<\/svg> Try again<\/button>/);
  assert.doesNotMatch(errorState({ title: 'Failed' }), /<button/);
});

test('breadcrumbs link each place above, and mark this one current', () => {
  const html = breadcrumbs([
    { label: 'Home', href: '#/' },
    { label: 'Plant', href: '#/plant' },
    { label: EVIL, href: '#/plant/x' },
  ]);
  assert.match(html, /^<ol><li><a href="#\/">Home<\/a><\/li><li><span class="crumb-sep" aria-hidden="true"><svg/);
  assert.match(
    html,
    new RegExp(`<li><span class="crumb-sep"[^]*?</span><b aria-current="page">${SAFE}</b></li></ol>$`),
  );
  assert.equal(html.match(/aria-current/g)?.length, 1);
  // A place without a link of its own is plain text.
  assert.match(breadcrumbs([{ label: 'New app' }, { label: 'x' }]), /<li><span>New app<\/span><\/li>/);
});

test("a site that didn't load: a failed connection says to check the API, an answer says its reason", () => {
  const down = apiUnreachable("Can't reach the Tiles API at http://127.0.0.1:1: Failed to fetch");
  assert.match(down, /Can&#39;t reach the Tiles API<\/h2>/);
  assert.match(down, /Check that the API is running and its address in Settings is right/);
  assert.doesNotMatch(down, /<p>Can&#39;t reach/); // the title isn't said twice
  const answered = apiUnreachable(
    'The Tiles API has no sites yet. Run `tiles-seed` (Docker Compose does this for you).',
  );
  assert.match(answered, /The site couldn&#39;t be loaded<\/h2>/);
  assert.doesNotMatch(answered, /\)\.\./);
  assert.doesNotMatch(answered, /address/);
  // Ways out: Try again and Settings, and Sign in when signed out; big buttons on the shopfloor.
  assert.match(answered, /data-reconnect/);
  assert.match(answered, /href="#\/settings"/);
  assert.doesNotMatch(answered, /data-app-sign-in/);
  assert.match(apiUnreachable('Sign in first', { signIn: true }), /data-app-sign-in/);
  assert.match(apiUnreachable(null, { size: 'lg' }), /class="btn lg"/);
});

test('the wait counts from when loading began, not from each render', async () => {
  const waitOf = (html) => Number(/--wait:(\d+)ms/.exec(html)?.[1]);
  const first = waitOf(skeleton.text());
  await new Promise((r) => setTimeout(r, 120));
  const again = waitOf(skeleton.list()); // a re-render while still loading
  assert.ok(again <= first - 100, `${first} then ${again}`);
  await new Promise((r) => setTimeout(r, 1100)); // loading stopped, then something new loads
  assert.equal(waitOf(skeleton.card()), 300);
});
