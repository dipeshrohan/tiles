// Shared components (U1.04, U2.04, U2.05) and the command palette's ranking (U4.02).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { emptyState, loadingState } from '../js/lib/ui.ts';
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
