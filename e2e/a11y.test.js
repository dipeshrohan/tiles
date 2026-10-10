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
  const id = fake.raiseWarning('dc1.friction', readings, {
    started_at: at(29),
    last_at: at(1),
    peak: 2400,
    baseline: 1800,
    threshold: 2200,
    readings: 29,
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
    // App Studio: a template's form, and an app's result with its chart.
    await page.evaluate(() => (location.hash = '#/apps/new'));
    await page.click('[data-template="spc-limits"]');
    await page.waitForSelector('#app-form [name=signal] option:not([disabled])', { state: 'attached' });
    await check('app form');
    await page.selectOption('#app-form [name=signal]', { index: 1 });
    await page.click('#app-form button[type=submit]');
    await page.waitForSelector('[data-app-detail] svg.chart');
    // The "App made" toast has faded (axe would read it mid-fade).
    await page.waitForSelector('#toast:not(.show)', { state: 'attached', timeout: 5000 });
    await page.waitForTimeout(400);
    await check('app');
    // Documents: an upload, and a search's matches with their words marked.
    await page.evaluate(() => (location.hash = '#/documents'));
    await page.waitForSelector('[data-doc-list] .review-row, [data-doc-list] .empty:not(:has-text("Loading"))');
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
    await page.waitForSelector('#toast:not(.show)', { state: 'attached', timeout: 5000 });
    await page.waitForTimeout(400);
    await check('documents');
    await page.evaluate(() => (location.hash = '#/signals'));
    await page.click('a[href^="#/explorer?signal="]');
    await page.waitForSelector('.explorer-chart svg.chart');
    await check('explorer');
    await page.close();
    assert.deepEqual(problems, [], colorScheme);
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
  await page.waitForSelector('.plant-trail a');
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
