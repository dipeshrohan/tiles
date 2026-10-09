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

// What axe finds on the page as it is now, as readable lines.
async function audit(page) {
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
    const page = await browser.newPage({ colorScheme, viewport: { width: 1360, height: 900 } });
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
  const fake = createFakeApi();
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
    const page = await browser.newPage({ colorScheme, viewport: { width: 1360, height: 900 } });
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
    for (const route of ['shopfloor', 'plant', 'signals', 'settings', 'reviews', 'import', 'chat']) {
      await page.evaluate((r) => (location.hash = r), `#/${route}`);
      await page.waitForSelector('#view h1');
      await page.waitForTimeout(150); // its fetches answered
      await check(route);
    }
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
  await phone.close();
});
