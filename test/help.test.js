import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_HELP, blocks, generate, inline, pageIds, sections } from '../scripts/help.js';
import { chapter, helpHref, helpItems, pageSection, parentOf, sectionAt } from '../js/lib/help.ts';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('js/help-data.js is made from the user guide as it is now (run npm run build)', () => {
  assert.equal(read('../js/help-data.js'), generate());
});

test('every page has help, at a heading the guide has', () => {
  const pages = pageIds();
  assert.ok(pages.includes('warnings') && pages.includes('help') && pages.includes('import'), pages.join(' '));
  for (const id of pages) assert.ok(id in PAGE_HELP, `${id} has no help`);
  const slugs = new Set(sections(read('../docs/guides/user.md')).map((s) => s.slug));
  for (const [id, slug] of Object.entries(PAGE_HELP)) assert.ok(slugs.has(slug), `${id}: no heading #${slug}`);
});

test('links in the help land on a section of the guide', () => {
  const all = sections(read('../docs/guides/user.md'));
  const slugs = new Set(all.map((s) => s.slug));
  const links = all.flatMap((s) => [...s.html.matchAll(/href="#\/help\/([^"]+)"/g)].map((m) => m[1]));
  assert.ok(links.length > 5, 'the guide links to its own sections');
  for (const l of links) assert.ok(slugs.has(l), `#/help/${l} goes nowhere`);
  assert.ok(!slugs.has('contents'), 'the table of contents is left out');
  assert.equal(all[0].level, 1, 'the introduction comes first');
});

test('inline Markdown: escaped, code kept as written, links into the app', () => {
  assert.equal(inline('a <b> & "c"'), 'a &lt;b&gt; &amp; &quot;c&quot;');
  assert.equal(inline('`x <y> **z**`'), '<code>x &lt;y&gt; **z**</code>');
  assert.equal(inline('**Save** and *then*'), '<strong>Save</strong> and <em>then</em>');
  assert.equal(inline('see [roles](#roles)'), 'see <a href="#/help/roles">roles</a>');
  assert.equal(inline('the [admin guide](admin.md)'), 'the admin guide'); // not in the app
  assert.equal(inline('[the glossary](../ui/glossary.md)'), '<a href="#/glossary">the glossary</a>'); // its page
  assert.equal(
    inline('[spec](https://example.com/a)'),
    '<a href="https://example.com/a" target="_blank" rel="noopener">spec</a>',
  );
  assert.equal(inline('2 * 3 * 4'), '2 * 3 * 4');
});

test('block Markdown: paragraphs, nested and numbered lists, tables, quotes; rules left out', () => {
  const html = blocks(
    [
      'One line',
      'and its next.',
      '',
      '1. First',
      '   - inner',
      '   - more',
      '2. Second',
      '   continued',
      '',
      '| Who | Can |',
      '| --- | --- |',
      '| Viewer | Read |',
      '',
      '> Note',
      '',
      '---',
    ].map(String),
  );
  assert.equal(
    html,
    '<p>One line and its next.</p>' +
      '<ol><li>First<ul><li>inner</li><li>more</li></ul></li><li>Second continued</li></ol>' +
      '<div class="table-wrap"><table class="small"><thead><tr><th scope="col">Who</th><th scope="col">Can</th></tr></thead>' +
      '<tbody><tr><th scope="row">Viewer</th><td>Read</td></tr></tbody></table></div>' +
      '<blockquote><p>Note</p></blockquote>',
  );
});

const data = {
  sections: [
    { slug: 'guide', title: 'Guide', level: 1, html: '<p>Intro</p>', text: 'Intro' },
    { slug: 'warnings', title: 'Warnings', level: 2, html: '', text: '' },
    { slug: 'filtering', title: 'Filtering', level: 3, html: '', text: '' },
    { slug: 'notifications', title: 'Notifications', level: 3, html: '', text: '' },
    { slug: 'plant', title: 'Plant', level: 2, html: '', text: '' },
  ],
  pages: { warnings: 'warnings', plant: 'plant' },
};

test("a page's help is its section with the subsections under it", () => {
  assert.deepEqual(
    pageSection(data, 'warnings').map((s) => s.slug),
    ['warnings', 'filtering', 'notifications'],
  );
  assert.deepEqual(
    pageSection(data, 'plant').map((s) => s.slug),
    ['plant'],
  );
  assert.deepEqual(
    pageSection(data, 'nowhere').map((s) => s.slug),
    ['guide'],
  );
  assert.deepEqual(
    sectionAt(data.sections, 'filtering').map((s) => s.slug),
    ['filtering'],
  );
  assert.equal(parentOf(data.sections, 'notifications')?.slug, 'warnings');
  assert.equal(helpHref('a b'), '#/help/a%20b');
});

test("the guide's headings are found in the command palette, a subsection under its section", () => {
  const opened = [];
  const items = helpItems(data, (href) => opened.push(href));
  assert.deepEqual(
    items.map((i) => [i.id, i.label, i.group, i.hint]),
    [
      ['help:warnings', 'Warnings', 'Help', undefined],
      ['help:filtering', 'Filtering', 'Help', 'Warnings'],
      ['help:notifications', 'Notifications', 'Help', 'Warnings'],
      ['help:plant', 'Plant', 'Help', undefined],
    ],
  );
  items[1].run();
  assert.deepEqual(opened, ['#/help/filtering']);
});

test('the Help page shows one section at a time, with the ones before and after it', () => {
  const at = (slug) => {
    const c = chapter(data.sections, slug);
    return [c.shown.map((s) => s.slug), c.prev?.slug, c.next?.slug];
  };
  assert.deepEqual(at(null), [['guide'], undefined, 'warnings']);
  assert.deepEqual(at('warnings'), [['warnings', 'filtering', 'notifications'], 'guide', 'plant']);
  assert.deepEqual(at('filtering'), [['warnings', 'filtering', 'notifications'], 'guide', 'plant']); // its section
  assert.deepEqual(at('plant'), [['plant'], 'warnings', undefined]);
  assert.deepEqual(at('nowhere'), [['guide'], undefined, 'warnings']);
});
