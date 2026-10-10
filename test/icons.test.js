// Icons (U1.05): the generated Lucide data is current, every page has its own icon, and icons are
// decorative unless they are given a name.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { generate } from '../scripts/icons.js';
import { icon, isIconName } from '../js/lib/icons.ts';

test('js/lib/icon-data.ts is what scripts/icons.js makes (run `npm run icons`)', () => {
  const committed = readFileSync(resolve(import.meta.dirname, '../js/lib/icon-data.ts'), 'utf8');
  assert.equal(committed, generate());
});

test('every page has an icon of its own', async () => {
  // Every module in js/views that exports a page (a View), so a new page is checked too.
  const dir = resolve(import.meta.dirname, '../js/views');
  const modules = await Promise.all(
    readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map(async (f) => (await import(`../js/views/${f}`)).default),
  );
  const views = modules.filter((v) => v && typeof v.render === 'function' && 'icon' in v);
  assert.ok(views.length >= 20, `${views.length} pages`);
  const icons = views.map((v) => v.icon);
  assert.deepEqual(
    icons.filter((i) => !isIconName(i)),
    [],
  );
  assert.equal(new Set(icons).size, icons.length, `shared icons: ${icons}`);
});

test('an icon is hidden from screen readers unless it is named', () => {
  const plain = icon('search');
  assert.match(plain, /^<svg class="icon icon-search" width="16" height="16"/);
  assert.match(plain, /aria-hidden="true"/);
  assert.match(plain, /stroke="currentColor"/);
  const named = icon('x', { label: 'Close "panel"', size: 20 });
  assert.match(named, /role="img" aria-label="Close &quot;panel&quot;"/);
  assert.match(named, /width="20"/);
  assert.doesNotMatch(named, /aria-hidden/);
});
