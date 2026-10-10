// Shared components (U1.04, U2.04, U2.05) and the command palette's ranking (U4.02).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  attrs,
  badge,
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
});

test('loading shows bars for the eye and words for screen readers', () => {
  const html = loadingState('Loading <runs>…', 2);
  assert.match(html, /^<div class="empty loading">/);
  assert.match(html, /<span class="sr-only">Loading &lt;runs&gt;…<\/span>/);
  assert.equal(html.match(/class="skeleton"/g)?.length, 2);
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
    `<div class="page-head"><div><div class="eyebrow">Data</div><h1>${SAFE}</h1><p class="soft">Why</p></div><a>x</a></div>`,
  );
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

test('tabs mark the current one for the eye and for screen readers', () => {
  const html = tabs({
    label: 'Status',
    items: [
      ['new', 'New'],
      ['all', 'All'],
    ],
    current: 'all',
    data: 'show',
  });
  assert.match(html, /^<div class="tabs" role="tablist" aria-label="Status">/);
  assert.match(
    html,
    /<button class="tab" type="button" role="tab" aria-selected="false" data-show="new">New<\/button>/,
  );
  assert.match(
    html,
    /<button class="tab active" type="button" role="tab" aria-selected="true" data-show="all">All<\/button>/,
  );
});

test('an error state is an alert, with a way to try again', () => {
  const html = errorState({ title: 'Failed', retry: 'retry-docs', compact: true });
  assert.match(html, /role="alert"/);
  assert.match(html, /<button class="btn sm" type="button" data-retry-docs><svg[\s\S]*<\/svg> Try again<\/button>/);
  assert.doesNotMatch(errorState({ title: 'Failed' }), /<button/);
});
