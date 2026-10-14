import { test } from 'vitest';
import assert from 'node:assert/strict';
import { cleanPrefs, DEFAULT_PREFS, MAX_PINNED } from '../js/lib/nav.ts';
import {
  applyRole,
  nextHtml,
  roleSetup,
  rolesHtml,
  shouldWelcome,
  welcomeIntro,
  WORK_ROLES,
} from '../js/lib/welcome.ts';

const PAGES = [
  'home',
  'shopfloor',
  'plant',
  'warnings',
  'signals',
  'explorer',
  'correlate',
  'ontology',
  'documents',
  'settings',
  'onboarding',
  'reviews',
];
const title = (p) =>
  ({ shopfloor: 'Shopfloor', warnings: 'Warnings', plant: 'Plant', explorer: 'Data explorer' })[p] ?? p;

test('four roles, each starting on a page and pinning pages the app has', () => {
  assert.deepEqual(
    WORK_ROLES.map((r) => r.id),
    ['engineer', 'maintenance', 'shift-lead', 'admin'],
  );
  for (const r of WORK_ROLES) {
    assert.ok(PAGES.includes(r.start), r.id);
    for (const p of r.pins) assert.ok(PAGES.includes(p), `${r.id}: ${p}`);
  }
  assert.equal(roleSetup('shift-lead')?.start, 'shopfloor');
  assert.equal(roleSetup('nobody'), undefined);
});

test('a role pins its pages first, keeps earlier pins, folds its groups and sets the start page', () => {
  const before = { ...DEFAULT_PREFS, pinned: ['documents', 'warnings'], folded: ['design'] };
  const after = applyRole(before, roleSetup('shift-lead'), PAGES);
  assert.deepEqual(after.pinned, ['shopfloor', 'warnings', 'plant', 'documents']);
  assert.deepEqual(after.folded, ['design', 'data']);
  assert.equal(after.start, 'shopfloor');
  // Never more than the menu holds; a page this build lacks is neither pinned nor started at.
  const full = { ...DEFAULT_PREFS, pinned: PAGES.slice(1, MAX_PINNED + 1) };
  assert.equal(applyRole(full, roleSetup('engineer'), PAGES).pinned.length, MAX_PINNED);
  const lacking = applyRole(DEFAULT_PREFS, roleSetup('maintenance'), ['home', 'plant']);
  assert.deepEqual(lacking.pinned, ['plant']);
  assert.equal(lacking.start, undefined);
});

test('the start page is kept with the menu choices, and only when it is a page', () => {
  assert.equal(cleanPrefs({ start: 'warnings' }, PAGES).start, 'warnings');
  assert.equal(cleanPrefs({ start: 'gone' }, PAGES).start, undefined);
  assert.equal(cleanPrefs({ start: 3 }, PAGES).start, undefined);
});

test('greeted once, and never in an automated browser', () => {
  assert.equal(shouldWelcome(false, false), true);
  assert.equal(shouldWelcome(true, false), false);
  assert.equal(shouldWelcome(false, true), false);
});

test('the welcome says what Tiles shows: the demo plant, or the site', () => {
  assert.match(welcomeIntro({ site: null, title }), /demo plant/);
  assert.match(welcomeIntro({ site: 'Plant <A>', title }), /^You’re on Plant <A>:/);
  const html = rolesHtml({ site: 'Plant <A>', title });
  assert.match(html, /Plant &lt;A&gt;/);
  assert.match(html, /<legend>What do you mostly do\?<\/legend>/);
  assert.equal((html.match(/data-role=/g) ?? []).length, 4);
  assert.match(html, /data-welcome-skip/);
});

test('then what the role set, and where to go: the wizard first for an admin of a new site', () => {
  const c = { site: null, title };
  const maintenance = nextHtml(c, roleSetup('maintenance'), { setUp: false, helpFor: 'warnings' });
  assert.match(
    maintenance,
    /Tiles will open at <b>Warnings<\/b>, with <b>Warnings<\/b>, <b>Plant<\/b> and <b>documents<\/b> pinned/,
  );
  assert.match(maintenance, /class="btn primary" href="#\/warnings">Go to Warnings/);
  assert.match(maintenance, /href="#\/help\/warnings">Read how Warnings works/);
  assert.doesNotMatch(maintenance, /onboarding/);
  const admin = nextHtml(c, roleSetup('admin'), { setUp: true, helpFor: null });
  assert.match(admin, /class="btn primary" href="#\/onboarding">Set up the site/);
  assert.match(admin, /class="btn" href="#\/settings">/);
  assert.doesNotMatch(admin, /Read how/);
});
