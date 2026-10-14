import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { canRun, ROLE_TOURS, TOURS, tourOf } from '../js/lib/tours.ts';
import { placePopover } from '../js/lib/tour.ts';
import { WORK_ROLES } from '../js/lib/welcome.ts';

const views = new URL('../js/views/', import.meta.url);
const source = readdirSync(views)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(new URL(f, views), 'utf8'))
  .join('\n');
const pageIds = [...source.matchAll(/^ {2}id: '([\w-]+)',$/gm)].map((m) => m[1]);

test('the four tours the plan names, each a few steps', () => {
  assert.deepEqual(
    TOURS.map((t) => t.id),
    ['triage', 'plot', 'ontology', 'copilot'],
  );
  for (const t of TOURS) assert.ok(t.steps.length >= 2 && t.steps.length <= 6, t.id);
  assert.equal(tourOf('plot')?.title, 'Find and plot a signal');
});

test('every step is on a page there is, and its target is still drawn by a page', () => {
  for (const t of TOURS)
    for (const s of t.steps) {
      const page = s.page.replace(/^#\//, '').split(/[/?]/)[0] || 'home';
      assert.ok(pageIds.includes(page), `${t.id}: no page ${s.page}`);
      assert.ok(
        source.includes(`data-tour="${s.target}"`) || source.includes(`'data-tour': '${s.target}'`),
        `${t.id}: no data-tour="${s.target}"`,
      );
    }
});

test('each role starts with a tour there is; tours of the API’s data need it', () => {
  for (const r of WORK_ROLES) assert.ok(tourOf(ROLE_TOURS[r.id] ?? ''), r.id);
  assert.equal(canRun(tourOf('triage'), false), false);
  assert.equal(canRun(tourOf('triage'), true), true);
  assert.equal(canRun(tourOf('ontology'), false), true);
});

test('the popover goes below its part of the page, above it when there is no room, else at the bottom', () => {
  const view = { width: 1280, height: 800 };
  const pop = { width: 380, height: 200 };
  assert.deepEqual(placePopover({ top: 100, left: 400, width: 200, height: 50 }, pop, view), {
    top: 162,
    left: 310,
    side: 'below',
  });
  assert.deepEqual(placePopover({ top: 560, left: 400, width: 200, height: 50 }, pop, view), {
    top: 348,
    left: 310,
    side: 'above',
  });
  assert.equal(placePopover({ top: 20, left: 0, width: 1280, height: 760 }, pop, view).side, 'bottom');
  // Kept inside the window sideways; on a phone, at the bottom.
  assert.equal(placePopover({ top: 100, left: 1200, width: 60, height: 20 }, pop, view).left, 1280 - 380 - 16);
  assert.equal(placePopover({ top: 100, left: 0, width: 60, height: 20 }, pop, view).left, 16);
  assert.deepEqual(
    placePopover(
      { top: 100, left: 10, width: 60, height: 20 },
      { width: 358, height: 200 },
      { width: 390, height: 844 },
    ),
    {
      top: 628,
      left: 16,
      side: 'bottom',
    },
  );
  assert.equal(placePopover(null, pop, view).side, 'bottom');
});
