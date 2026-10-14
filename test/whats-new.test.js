import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageIds, TASK_PAGES, whatsNew } from '../scripts/help.js';
import {
  compareVersions,
  hasNews,
  helpLabel,
  seenOnFirstLoad,
  whatsNewHtml,
  whatsNewTitle,
} from '../js/lib/whats-new.ts';
import { VERSION } from '../js/lib/version.ts';

const CHANGELOG = `# Changelog

Intro.

## [1.2.0] - Unreleased

The next one.

### Added

- **Operations:**
  - a shopfloor view for tablets
    on the line (T5.16);
  - e-mail <and> Teams notifications (T3.09).
- **App Studio:** templates (T6.10).
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
  // A wrapped entry is one; its task names its page.
  assert.match(
    w.html,
    /a shopfloor view for tablets on the line \(T5\.16\); <a class="whats-new-link" href="#\/shopfloor">Open Shopfloor<\/a>/,
  );
  assert.match(w.html, /e-mail &lt;and&gt; Teams notifications \(T3\.09\)\.<\/li>/); // escaped; its task isn't a page
  assert.doesNotMatch(w.html, /Operations:<\/strong> <a/); // a group's heading isn't an entry
  assert.match(w.html, /templates \(T6\.10\)\. <a class="whats-new-link" href="#\/apps">Open App Studio<\/a>/);
  assert.match(w.html, /<h3>Fixed<\/h3>/); // a heading straight after a list
  // eslint-disable-next-line no-control-regex -- no marker left behind
  assert.doesNotMatch(w.html, /[\u0000-\u0008]/);
  assert.doesNotMatch(w.html, /older things/); // only the top section
  assert.equal(whatsNew(CHANGELOG.replace('1.2.0] - Unreleased', '1.2.0] - 2026-10-20')).date, '2026-10-20');
  assert.throws(() => whatsNew('# Changelog\n\nnothing'), /no version section/);
});

test('the real changelog: its top section is this version, and entries link to pages there are', () => {
  const w = whatsNew(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'));
  assert.equal(w.version, VERSION);
  assert.ok((w.html.match(/whats-new-link/g) ?? []).length >= 10);
  const pages = pageIds();
  for (const [task, [route]] of Object.entries(TASK_PAGES))
    assert.ok(pages.includes(route.split('/')[0]), `${task}: no page ${route}`);
});

test('the dot: only for someone who saw an earlier version', () => {
  assert.equal(hasNews(null, '0.2.0'), false); // a first visit
  assert.equal(hasNews('0.2.0', '0.2.0'), false);
  assert.equal(hasNews('0.1.0', '0.2.0'), true);
  assert.equal(hasNews('0.10.0', '0.9.0'), false); // a rollback isn't news
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  // A first visit notes this version; someone who used Tiles before What's new gets the dot.
  assert.equal(seenOnFirstLoad([], '0.2.0'), '0.2.0');
  assert.equal(hasNews(seenOnFirstLoad(['state-v2', 'nav:local:a'], '0.2.0'), '0.2.0'), true);
  assert.equal(helpLabel(true, '0.2.0'), 'Help for this page, and what’s new in 0.2.0');
  assert.equal(helpLabel(false, '0.2.0'), 'Help for this page');
});

test('the sheet says the version and whether it is out yet', () => {
  assert.equal(whatsNewTitle({ version: '0.2.0', date: null, html: '' }), 'Version 0.2.0');
  assert.equal(whatsNewTitle({ version: '0.2.0', date: '2026-10-20', html: '' }), 'Version 0.2.0, 2026-10-20');
  assert.match(whatsNewHtml({ version: '0.2.0', date: null, html: '<p>x</p>' }), /Not yet released/);
  assert.doesNotMatch(whatsNewHtml({ version: '0.2.0', date: '2026-10-20', html: '<p>x</p>' }), /Not yet released/);
});
