import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageIds, whatsNew, WHATS_NEW_PAGES } from '../scripts/help.js';
import { hasNews, helpLabel, whatsNewHtml, whatsNewTitle } from '../js/lib/whats-new.ts';
import { VERSION } from '../js/lib/version.ts';

const CHANGELOG = `# Changelog

Intro.

## [1.2.0] - Unreleased

The next one.

### Added

- **Operations:**
  - a shopfloor view for tablets;
  - e-mail <and> Teams notifications.
- **Design studio:** runs and sweeps.

### Fixed

- the warnings inbox kept a stale filter.

## [1.1.0] - 2026-09-01

### Added

- older things.
`;

test("what's new is the changelog's top section, its entries linked to the pages they name", () => {
  const w = whatsNew(CHANGELOG);
  assert.equal(w.version, '1.2.0');
  assert.equal(w.date, null); // unreleased
  assert.match(w.html, /^<p>The next one\.<\/p><h3>Added<\/h3><ul><li><strong>Operations:<\/strong><ul>/);
  assert.match(
    w.html,
    /a shopfloor view for tablets; <a class="whats-new-link" href="#\/shopfloor">Open Shopfloor<\/a>/,
  );
  assert.match(w.html, /e-mail &lt;and&gt; Teams notifications\.<\/li>/); // escaped, no page named
  assert.doesNotMatch(w.html, /Operations:<\/strong> <a/); // a group's heading isn't an entry
  assert.match(w.html, /runs and sweeps\. <a class="whats-new-link" href="#\/design">Open Design studio<\/a>/);
  assert.match(w.html, /<h3>Fixed<\/h3>/);
  assert.doesNotMatch(w.html, /older things/); // only the top section
  assert.equal(whatsNew(CHANGELOG.replace('1.2.0] - Unreleased', '1.2.0] - 2026-10-20')).date, '2026-10-20');
  assert.throws(() => whatsNew('# Changelog\n\nnothing'), /no version section/);
});

test('the real changelog: its top section is this version, and entries link to pages there are', () => {
  const w = whatsNew(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'));
  assert.equal(w.version, VERSION);
  assert.ok((w.html.match(/whats-new-link/g) ?? []).length >= 10);
  const pages = pageIds();
  for (const [, route] of WHATS_NEW_PAGES) assert.ok(pages.includes(route.split('/')[0]), `no page ${route}`);
});

test('the dot: only for someone who saw an earlier version', () => {
  assert.equal(hasNews(null, '0.2.0'), false); // a first visit
  assert.equal(hasNews('0.2.0', '0.2.0'), false);
  assert.equal(hasNews('0.1.0', '0.2.0'), true);
  assert.equal(helpLabel(true, '0.2.0'), 'Help for this page, and what’s new in 0.2.0');
  assert.equal(helpLabel(false, '0.2.0'), 'Help for this page');
});

test('the sheet says the version and whether it is out yet', () => {
  assert.equal(whatsNewTitle({ version: '0.2.0', date: null, html: '' }), 'Version 0.2.0');
  assert.equal(whatsNewTitle({ version: '0.2.0', date: '2026-10-20', html: '' }), 'Version 0.2.0, 2026-10-20');
  assert.match(whatsNewHtml({ version: '0.2.0', date: null, html: '<p>x</p>' }), /Not yet released/);
  assert.doesNotMatch(whatsNewHtml({ version: '0.2.0', date: '2026-10-20', html: '<p>x</p>' }), /Not yet released/);
});
