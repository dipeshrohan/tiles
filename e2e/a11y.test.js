// Accessibility (T5.18): every page passes axe's WCAG 2.1 A and AA rules, in light and dark, in
// local mode and with the API's data on screen (charts included); the keyboard reaches the content.
// Run with `npm run test:e2e`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createTilesServer } from '../server.js';
import { createFakeApi } from './fake-api.js';

const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core/axe.min.js');

const PAGES = [
  '',
  'chat',
  'shopfloor',
  'plant',
  'plant/m-dc02',
  'ontology',
  'reviews',
  'warnings',
  'performance',
  'work-orders',
  'quality',
  'physics',
  'design',
  'signals',
  'explorer',
  'correlate',
  'insights',
  'import',
  'onboarding',
  'settings',
  'preferences',
  'styleguide',
  'help',
  'help/warnings',
  'glossary',
];
// WCAG 2.1 A and AA, and the best practices that matter to these pages.
const RULES = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
};
const PRACTICES = [
  'page-has-heading-one',
  'landmark-one-main',
  'heading-order',
  'empty-table-header',
  'aria-allowed-role',
];

let browser;
let server;
let httpBase;

before(async () => {
  server = createTilesServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  httpBase = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

// The page has its data: nothing in it is still loading.
async function settled(page) {
  await page.waitForSelector('#view h1');
  await page.waitForFunction(() => !/Loading/.test(document.querySelector('#view')?.textContent ?? ''));
}

// What axe finds on the page as it is now, as readable lines.
async function audit(page) {
  // axe goes in as an inline script, which the app's Content-Security-Policy refuses (as it should):
  // pages that run it bypass the policy, for the test's script only.
  if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ path: AXE });
  // Colours are checked as the page settles: a page fades in when it opens, and axe would measure
  // text half way there. Endless animations (a spinner) aren't waited for.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  const found = await page.evaluate(
    async ([rules, practices]) => {
      const wcag = await window.axe.run(document, rules);
      const best = await window.axe.run(document, { runOnly: { type: 'rule', values: practices } });
      return [...wcag.violations, ...best.violations].map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => `${n.target.join(' ')}: ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`),
      }));
    },
    [RULES, PRACTICES],
  );
  return found.flatMap((v) => v.nodes.slice(0, 3).map((n) => `${v.id} ${n}`));
}

for (const colorScheme of ['light', 'dark']) {
  test(`every page passes the accessibility rules in local mode (${colorScheme})`, async () => {
    const page = await browser.newPage({ colorScheme, viewport: { width: 1360, height: 900 }, bypassCSP: true });
    const problems = [];
    for (const route of PAGES) {
      await page.goto(`${httpBase}#/${route}`);
      await page.waitForSelector('#view h1');
      problems.push(...(await audit(page)).map((p) => `#/${route} ${p}`));
    }
    await page.close();
    assert.deepEqual(problems, []);
  });
}

test('the site wizard on the demo plant passes the accessibility rules, its tags too (U4.10)', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({ colorScheme, viewport: { width: 1360, height: 900 }, bypassCSP: true });
    await page.goto(`${httpBase}#/onboarding`);
    await page.click('[data-demo-agent]');
    await page.waitForSelector('#view tbody tr');
    await page.click('[data-map-tag="dc02.hyd_pressure"]');
    await page.waitForSelector('tr[data-key="tag-dc02.hyd_pressure"] .badge.good');
    await page.waitForSelector('#toast:not(.show)', { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(400);
    assert.deepEqual(await audit(page), [], colorScheme);
    await page.close();
  }
});

test('pages with the API’s data on them pass the accessibility rules, charts included', async (t) => {
  // An admin, so the admins' cards are checked too (the audit log, the organisation's sign-in).
  const fake = createFakeApi({ roles: { 'demo@example.com': 'admin' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const now = Date.now();
  const minute = 60_000;
  const at = (m) => new Date(now - m * minute).toISOString();
  const readings = Array.from({ length: 120 }, (_, i) => ({
    at: at(120 - i),
    value: 1800 + (i > 90 ? 20 * (i - 90) : 0),
  }));
  // A change request waiting for review: an unread item under the bell (U5.07).
  const press = { id: 'machine-press-9', type: 'Machine', label: 'Press 9', props: {} };
  fake.requestReviewAs('maria@example.com', [{ kind: 'addNode', node: press }], 'Add press 9');
  const id = fake.raiseWarning('dc1.friction', readings, {
    started_at: at(29),
    last_at: at(1),
    peak: 2400,
    baseline: 1800,
    threshold: 2200,
    readings: 29,
  });
  // A machine with its setpoint recommendations card (T11.02): a limit set, one recommendation waiting.
  fake.commitAs(
    'maria',
    [{ kind: 'addNode', node: { id: 'dc-rec', type: 'Machine', label: 'Die-caster R', props: { asset: 'DC-R' } } }],
    'Die-caster R',
  );
  // Feedback for the admins' list in Settings (U4.09).
  fake.appFeedback.push({
    id: 1,
    created_at: at(5),
    mood: 'unhappy',
    text: 'The chart is hard to read.',
    page: 'warnings',
    version: '0.2.0',
    browser: 'Chrome',
    user: null,
    screenshot: null,
  });
  for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({ colorScheme, viewport: { width: 1360, height: 900 }, bypassCSP: true });
    const problems = [];
    const check = async (label) => problems.push(...(await audit(page)).map((p) => `${label}: ${p}`));
    await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/warnings`);
    await page.click(`[data-warning="${id}"]`);
    await page.waitForSelector('[data-warning-detail] svg.chart .span');
    // The chart says what it shows: its readings, the threshold and baseline, the warning.
    const label = await page.getAttribute('[data-warning-detail] svg.chart', 'aria-label');
    assert.match(label, /\d+ readings from .* UTC to .* UTC; values 1,800 to 2,380; latest 2,380 at .* UTC/);
    assert.match(label, /threshold 2,200; baseline 1,800/);
    assert.match(label, /1 shaded stretch/);
    await check('warning');
    for (const route of [
      'shopfloor',
      'plant',
      'signals',
      'settings',
      'reviews',
      'import',
      'chat',
      'onboarding',
      'apps',
      'documents',
    ]) {
      await page.evaluate((r) => (location.hash = r), `#/${route}`);
      await settled(page);
      await check(route);
    }
    // A machine's setpoint recommendations: its limits, the form, one waiting for approval (T11.02).
    await page.evaluate(() => (location.hash = '#/plant/dc-rec'));
    await page.waitForSelector('[data-recs] [data-rec-limits]');
    if (!fake.recommendationLimits().length) {
      // The first colour scheme sets them up; the second sees the same.
      await page.fill('#rec-limits [name="min:die_temp_set"]', '222');
      await page.fill('#rec-limits [name="max:die_temp_set"]', '242');
      await page.click('[data-limit-save="die_temp_set"]');
      await page.waitForSelector('[data-rec-new]');
      await page.click('[data-rec-new] summary');
      await page.click('#rec-form button[type=submit]');
    } else await page.click('[data-rec-new] summary');
    await page.waitForSelector('[data-recs] tr[data-rec="1"]');
    await page.waitForSelector('#toast:not(.show)', { state: 'attached', timeout: 10000 });
    await check('machine, setpoint recommendations');
    // Home by role (U5.01): an admin's cards, then customising them.
    await page.evaluate(() => (location.hash = '#/'));
    await page.waitForSelector('#view [data-card="agents"] .home-figure, #view [data-card="agents"] .empty');
    await page.waitForFunction(() => !document.querySelector('#view [data-card] [aria-busy="true"]'));
    await check('home');
    await page.click('[data-home-edit]');
    await page.waitForSelector('[data-card-add-form]');
    await check('home, customising');
    await page.click('[data-home-done]');
    // App Studio: a template's form, and an app's result with its chart.
    await page.evaluate(() => (location.hash = '#/apps/new'));
    await page.click('[data-template="spc-limits"]');
    await page.waitForSelector('#app-form [name=signal] option:not([disabled])', { state: 'attached' });
    await check('app form');
    await page.selectOption('#app-form [name=signal]', { index: 1 });
    await page.click('#app-form button[type=submit]');
    await page.waitForSelector('[data-app-detail] svg.chart');
    // The "App made" toast has faded (axe would read it mid-fade).
    await page.waitForSelector('#toast:not(.show)', { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(400);
    await check('app');
    // Documents: an upload, and a search's matches with their words marked.
    await page.evaluate(() => (location.hash = '#/documents'));
    await page.waitForSelector('[data-doc-list] [data-doc], [data-doc-list] .empty:not(:has-text("Loading"))');
    await page.setInputFiles('#doc-upload [name=file]', {
      name: 'sop.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(`SOP ${colorScheme}\fReplace the plunger tip after 20000 shots.`),
    });
    await page.click('#doc-upload button[type=submit]');
    await page.waitForSelector('#toast:has-text("Uploaded")');
    await page.fill('#doc-search [name=q]', 'plunger');
    await page.click('#doc-search button[type=submit]');
    await page.waitForSelector('[data-matches] mark');
    await page.waitForSelector('#toast:not(.show)', { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(400);
    await check('documents');
    await page.evaluate(() => (location.hash = '#/signals'));
    // Tables v2 (U5.02): a row selected (the bar of bulk actions) and the columns menu open.
    await page.locator('[data-table="signals"] [data-table-row]').first().check();
    await page.waitForSelector('[data-table="signals"] .bulk-bar');
    await page.click('[data-table="signals"] .table-columns summary');
    await check('signals, a row selected');
    await page.click('[data-table="signals"] [data-table-clear]');
    await page.click('a[href^="#/explorer?signal="]');
    await page.waitForSelector('.explorer-chart svg.chart');
    await check('explorer');
    // Charts v2 (U5.03): a chart focused, its crosshair and value shown.
    await page.focus('.explorer-chart svg[data-chart]');
    await page.waitForSelector('.explorer-chart svg g.crosshair');
    await check('explorer, a chart read with the keys');
    // Send feedback (U4.09): the form with its errors, then with a screenshot attached.
    await page.click('#help-open');
    await page.click('dialog.sheet[open] [data-feedback-open]');
    const feedback = page.locator('dialog[open]:has([data-feedback-form])');
    await feedback.locator('button[type=submit]').click();
    await feedback.locator('.error-summary').waitFor();
    await check('feedback errors');
    await feedback.locator('label.mood').first().click();
    await feedback.locator('[data-feedback-shot]').check();
    await feedback.locator('[data-feedback-preview] img').waitFor();
    await check('feedback');
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    // Notifications (U5.07): the bell's count and its sheet with an unread item.
    await page.evaluate(() => (location.hash = '#/warnings'));
    await page.waitForSelector('#inbox-open:not([hidden])');
    await page.click('#inbox-open');
    await page.waitForSelector('dialog.sheet[open] .inbox-item.unread');
    await check('notifications');
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    // Filters and saved views (U5.06): the bar's menus open.
    await page.click('[data-filter-bar="warnings"] [data-views-menu] summary');
    await page.waitForSelector('[data-views-menu][open] [data-view-save]');
    await page.click('[data-filter-bar="warnings"] [data-add-filter] summary');
    await check('filter bar');
    await page.close();
    assert.deepEqual(problems, [], colorScheme);
  }
});

test('dialogs, toasts, tooltips, the command palette, the shortcuts and the help pass the accessibility rules', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({ colorScheme, viewport: { width: 1360, height: 900 }, bypassCSP: true });
    await page.goto(`${httpBase}#/settings`);
    await page.waitForSelector('#view h1');
    await page.click('#profile button[type=submit]'); // a toast
    await page.waitForSelector('.toast-item');
    await page.focus('#theme'); // a tooltip
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await page.waitForSelector('#tooltip:not([hidden])');
    await page.click('[data-reset]'); // a dialog
    await page.waitForSelector('dialog.dialog[open]');
    assert.deepEqual(await audit(page), [], colorScheme);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.dialog', { state: 'detached' });
    await page.keyboard.press('Control+k'); // the command palette
    await page.locator('dialog.palette input').fill('si');
    assert.deepEqual(await audit(page), [], `${colorScheme} palette`);
    await page.locator('dialog.palette input').fill('zzqx'); // nothing matches
    await page.waitForSelector('.palette-status:has-text("Nothing matches")');
    assert.deepEqual(await audit(page), [], `${colorScheme} palette, no match`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.palette', { state: 'detached' });
    await page.focus('#view h1');
    await page.keyboard.press('?'); // the keyboard shortcuts (U4.03)
    await page.waitForSelector('dialog.dialog[open] .shortcut-list');
    assert.deepEqual(await audit(page), [], `${colorScheme} keyboard shortcuts`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.dialog', { state: 'detached' });
    await page.click('#help-open'); // the page's help (U4.04)
    await page.waitForSelector('dialog.sheet[open] .prose');
    assert.deepEqual(await audit(page), [], `${colorScheme} help sheet`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.sheet', { state: 'detached' });
    await page.goto(`${httpBase}#/help`);
    await page.click('[data-show-welcome]'); // the first-run welcome (U4.06), both steps
    await page.waitForSelector('dialog[open] [data-role]');
    assert.deepEqual(await audit(page), [], `${colorScheme} welcome`);
    await page.click('dialog[open] [data-role="engineer"]');
    await page.waitForSelector('dialog[open] [data-welcome] a');
    assert.deepEqual(await audit(page), [], `${colorScheme} welcome, next`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await page.click('[data-start-tour="copilot"]'); // a guided tour's step (U4.07)
    await page.waitForSelector('.tour-pop #tour-title');
    await page.locator('.tour-spot').waitFor({ state: 'visible' });
    assert.deepEqual(await audit(page), [], `${colorScheme} tour`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.tour-pop', { state: 'detached' });
    await page.goto(`${httpBase}#/help`);
    await page.click('[data-whats-new]'); // what's new (U4.08)
    await page.waitForSelector('dialog.sheet[open] .whats-new');
    assert.deepEqual(await audit(page), [], `${colorScheme} what's new`);
    await page.keyboard.press('Escape');
    await page.close();
  }
});

test('the keyboard reaches the content first, and the menu says whether it is open', async () => {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.goto(`${httpBase}#/plant`);
  await page.waitForSelector('#view h1');
  // The first Tab lands on "Skip to content", which moves the focus past the navigation.
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Skip to content');
  assert.ok(await page.locator('.skip-link').isVisible());
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'view');
  assert.match(await page.evaluate(() => location.hash), /^#\/plant/); // not a route of its own
  // The next Tab is inside the page, not the navigation.
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.querySelector('#view')?.contains(document.activeElement)));
  // The current page is marked as such in the navigation.
  assert.equal(await page.getAttribute('#nav a[aria-current="page"]', 'href'), '#/plant');
  // A place opens with the keyboard.
  await page.focus('.place-card');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#crumbs li:nth-child(3) a');
  await page.close();

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(`${httpBase}#/`);
  await phone.waitForSelector('#view h1');
  assert.equal(await phone.getAttribute('#menu', 'aria-expanded'), 'false');
  await phone.click('#menu');
  assert.equal(await phone.getAttribute('#menu', 'aria-expanded'), 'true');
  await phone.click('#nav a[href="#/plant"]');
  assert.equal(await phone.getAttribute('#menu', 'aria-expanded'), 'false');
  // Any link closes it (the brand, too), and so does Escape, giving the focus back to the button.
  await phone.click('#menu');
  await phone.click('.brand');
  await phone.waitForSelector('#sidebar:not(.open)');
  assert.equal(await phone.getAttribute('#menu', 'aria-expanded'), 'false');
  await phone.click('#menu');
  await phone.keyboard.press('Escape');
  await phone.waitForSelector('#sidebar:not(.open)');
  assert.equal(await phone.evaluate(() => document.activeElement?.id), 'menu');
  await phone.close();
});

test('the Shopfloor tells screen readers when its headline changes', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/shopfloor`);
  await page.waitForSelector('.floor-headline:has-text("All clear")');
  // Opening the page reads its heading; nothing is announced.
  assert.equal(await page.textContent('#announcer'), '');
  fake.raiseWarning('dc1.friction', [], {
    started_at: new Date(Date.now() - 60_000).toISOString(),
    last_at: new Date().toISOString(),
    peak: 3,
    baseline: 1,
    threshold: 2,
    readings: 2,
  });
  await page.click('[data-floor-refresh]');
  await page.waitForSelector('.floor-headline:has-text("1 open warning")');
  assert.equal(await page.textContent('#announcer'), '1 open warning: 1 signal still out, 1 nobody has taken');
  // The announcer stays put while the page renders again.
  await page.click('[data-floor-full]');
  await page.click('[data-floor-full]');
  assert.equal(await page.locator('#announcer').count(), 1);
});

// ---- round 2 (U6.04): reflow, focus in every colour scheme, and target size ----------------------

// Pages that need the API (Apps, Documents, the record lists), checked with a fake one holding a
// warning and a change request, besides every page in local mode.
const API_PAGES = ['', 'warnings', 'reviews', 'signals', 'insights', 'apps', 'documents'];

async function withApi(t) {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const now = Date.now();
  const readings = Array.from({ length: 30 }, (_, i) => ({
    at: new Date(now - (30 - i) * 60_000).toISOString(),
    value: 1800 + i,
  }));
  fake.raiseWarning('dc1.friction', readings, {
    started_at: readings[5].at,
    last_at: readings[29].at,
    peak: 1829,
    baseline: 1800,
    threshold: 1820,
    readings: 24,
  });
  const press = { id: 'machine-press-9', type: 'Machine', label: 'Press 9', props: {} };
  fake.requestReviewAs('maria@example.com', [{ kind: 'addNode', node: press }], 'Add press 9');
  return `${httpBase}?api=${encodeURIComponent(apiUrl)}`;
}

// Each page in turn in one tab per setting: [label, url], local mode then the API's pages.
async function eachPage(t, options, check) {
  const api = await withApi(t);
  const page = await browser.newPage({ reducedMotion: 'reduce', ...options });
  const routes = [
    ...PAGES.map((r) => [r || 'home', `${httpBase}#/${r}`]),
    ...API_PAGES.map((r) => [`${r || 'home'} (API)`, `${api}#/${r}`]),
  ];
  for (const [label, url] of routes) {
    await page.goto('about:blank');
    await page.goto(url);
    await page.waitForSelector('#view > *');
    // With the API, its answers in: nothing in the page still loading, and the menu drawn again.
    if (label.endsWith('(API)')) {
      await page.waitForLoadState('networkidle');
      await page.waitForFunction(() => !document.querySelector('#view [aria-busy="true"]'));
    }
    await page.waitForTimeout(200);
    await check(page, label);
  }
  await page.close();
}

// Every page at 320 px wide (1280 px at 400%) and at 640 px (200%): nothing scrolls sideways
// (WCAG 1.4.10; a table or chart scrolls inside its own box, which the page allows). Measured
// against the content's width, inside any scrollbar.
test('every page reflows at 320 px and at 200% zoom: nothing scrolls sideways (U6.04)', async (t) => {
  const wide = [];
  for (const width of [320, 640])
    await eachPage(t, { viewport: { width, height: 512 } }, async (page, label) => {
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (over > 0) wide.push(`${label} at ${width} px: ${over} px too wide`);
    });
  assert.deepEqual(wide, []);
});

// Tab through a page: every control the keyboard reaches shows where the focus is, an outline or a
// ring it hasn't without the focus. In forced colours (Windows High Contrast) shadows are dropped,
// so it must be an outline. The walk ends back where it began; a page with more controls than the
// limit fails rather than going unchecked.
async function unseenFocus(page) {
  // Each control's look at rest, before the walk: the focus must change it.
  await page.evaluate(() => {
    const forced = matchMedia('(forced-colors: active)').matches;
    window.__look = (el) => {
      const s = getComputedStyle(el);
      const outline =
        s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0
          ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} ${s.outlineOffset}`
          : '';
      return { outline, ring: forced || s.boxShadow === 'none' ? '' : s.boxShadow };
    };
    window.__rest = new WeakMap();
    for (const el of document.querySelectorAll('*')) window.__rest.set(el, window.__look(el));
    window.__walked = new WeakSet();
    // Whether the focus shows on the control that has it: waited for up to 600 ms, as a browser may
    // give the look from before the focus for a few frames (seen in forced colours); a control with no
    // focus style never shows one.
    window.__shows = async (el) => {
      const rest = window.__rest.get(el) ?? { outline: '', ring: '' };
      const until = performance.now() + 600;
      for (;;) {
        await new Promise((done) => requestAnimationFrame(done));
        const now = window.__look(el);
        if ((now.outline && now.outline !== rest.outline) || (now.ring && now.ring !== rest.ring)) return true;
        if (performance.now() > until) return false;
      }
    };
  });
  const unseen = [];
  for (let i = 0; ; i++) {
    if (i === 600) return [...unseen, 'more than 600 controls: the walk did not finish'];
    await page.keyboard.press('Tab');
    const at = await page.evaluate(async () => {
      const el = document.activeElement;
      if (!el || el === document.body || window.__walked.has(el)) return null;
      window.__walked.add(el);
      return { what: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`, shown: await window.__shows(el) };
    });
    if (!at) break;
    if (at.shown) continue;
    // Once more, by the keyboard again (a page settling can take the browser's sense of how the focus
    // came): a control with no focus style fails both times.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const again = await page.evaluate(() => window.__shows(document.activeElement));
    if (!again) unseen.push(at.what);
  }
  return unseen;
}

test('the focus is visible on every control, in normal and in forced colours (U6.04)', async (t) => {
  const unseen = [];
  for (const forcedColors of ['none', 'active'])
    await eachPage(t, { viewport: { width: 1280, height: 800 }, forcedColors }, async (page, label) => {
      for (const what of await unseenFocus(page)) unseen.push(`${label} (forced colours ${forcedColors}): ${what}`);
    });
  assert.deepEqual([...new Set(unseen)], []);
});

// In forced colours, what is chosen still shows: the page you're on, the section or step you're at,
// pressed filters, selected rows.
const CHOSEN =
  ".nav-link.active, .seg button.active, [aria-current]:not([aria-current='false']), [aria-pressed='true'], [aria-selected='true']";
test('in forced colours, what is chosen is outlined, not shown by background alone (U6.04)', async (t) => {
  const plain = [];
  const routes = [...PAGES, 'onboarding'];
  await eachPage(t, { viewport: { width: 1280, height: 800 }, forcedColors: 'active' }, async (page, label) => {
    const found = await page.evaluate(
      (sel) =>
        [...document.querySelectorAll(sel)]
          .filter((el) => el.getBoundingClientRect().width > 0 && el.id !== 'view' && el.tagName !== 'H1')
          .filter((el) => {
            const s = getComputedStyle(el.tagName === 'TR' ? el.cells[0] : el);
            return el.tagName === 'TR'
              ? parseFloat(s.borderTopWidth) < 2
              : s.outlineStyle === 'none' || parseFloat(s.outlineWidth) === 0;
          })
          .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`),
      CHOSEN,
    );
    for (const what of found) plain.push(`${label}: ${what}`);
  });
  assert.ok(routes.length);
  assert.deepEqual([...new Set(plain)], []);
});

// WCAG 2.2's target size (2.5.8): a control is 24 by 24 px or more; or it is inline in running text
// (a link or a glossary term in a sentence); or a 24 px circle on its centre touches no other
// control and no other small control's circle. The ontology canvas's nodes are the plant's map:
// their size is the zoom chosen (essential; docs/ui/accessibility.md).
test('controls are 24 px or more, inline in a sentence, or spaced apart (WCAG 2.2, U6.04)', async (t) => {
  const small = [];
  await eachPage(t, { viewport: { width: 1280, height: 800 } }, async (page, label) => {
    const found = await page.evaluate(() => {
      const sel =
        'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"]), summary';
      const els = [...document.querySelectorAll(sel)].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width && r.height && !e.closest('svg[data-canvas], .sr-only') && e.id !== 'view' && e.tagName !== 'H1';
      });
      // A control in its label is aimed at by the whole label (a click on either toggles it).
      const rects = els.map((e) => (e.closest('label') ?? e).getBoundingClientRect());
      // Inline, in a paragraph, list item or definition with words of its own around it.
      const inSentence = (e) => {
        if (!getComputedStyle(e).display.startsWith('inline')) return false;
        const block = e.closest('p, li, dd');
        if (!block || e.closest('td, th')) return false;
        return [...e.parentElement.childNodes].some(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 1,
        );
      };
      const smallOnes = els.map((e, i) => {
        const r = rects[i];
        return r.width < 24 || r.height < 24 ? !inSentence(e) : false;
      });
      const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
      const circleHitsRect = ([cx, cy], r) => {
        const dx = Math.max(r.left - cx, 0, cx - r.right);
        const dy = Math.max(r.top - cy, 0, cy - r.bottom);
        return dx * dx + dy * dy < 12 * 12;
      };
      return els.flatMap((el, i) => {
        if (!smallOnes[i]) return [];
        const c = centre(rects[i]);
        const clash = els.some((other, j) => {
          if (j === i || el.contains(other) || other.contains(el)) return false;
          if (smallOnes[j]) {
            const [ox, oy] = centre(rects[j]);
            return Math.hypot(ox - c[0], oy - c[1]) < 24;
          }
          return circleHitsRect(c, rects[j]);
        });
        const r = rects[i];
        return clash
          ? [
              `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${Math.round(r.width)}×${Math.round(r.height)}`,
            ]
          : [];
      });
    });
    for (const what of found) small.push(`${label}: ${what}`);
  });
  assert.deepEqual(small, []);
});
