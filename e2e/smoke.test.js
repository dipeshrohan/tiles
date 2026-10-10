// Browser smoke tests: every page renders, in light, dark and phone layouts,
// over http and file://, with no console errors and no horizontal scroll.
// Run with `npm run test:e2e` (needs a Playwright Chromium install).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createTilesServer } from '../server.js';
import { createFakeApi } from './fake-api.js';
import { largePlantOps } from '../test/fixtures/large-plant.js';
import { generateCutterBatches } from '../js/lib/data.ts';

const PAGES = [
  '',
  'chat',
  'shopfloor',
  'plant',
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
const VARIANTS = [
  { name: 'light desktop', colorScheme: 'light', viewport: { width: 1360, height: 900 } },
  { name: 'dark desktop', colorScheme: 'dark', viewport: { width: 1360, height: 900 } },
  { name: 'phone', colorScheme: 'light', viewport: { width: 390, height: 844 } },
];

let browser;
let server;
let httpBase;
const fileBase = new URL('../index.html', import.meta.url).href;

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

// Presses Undo on the toast that says `text` (U2.03).
async function undoToast(page, text) {
  await page.click(`.toast-item:not([data-state=closed]):has-text("${text}") [data-toast-action]`);
}

// Waits for something the fake API sees.
async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Confirms the dialog a click opened (js/lib/overlay.ts), typing `typed` first when it asks for it.
async function confirmIn(page, typed) {
  const dialog = page.locator('dialog.dialog[open]');
  await dialog.waitFor();
  if (typed) await dialog.locator('input[name=typed]').fill(typed);
  await dialog.locator('[data-confirm]').click();
  await page.waitForSelector('dialog.dialog', { state: 'detached' });
}

async function openPage(options = {}) {
  const page = await browser.newPage(options);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { page, errors };
}

for (const variant of VARIANTS) {
  test(`every page renders (${variant.name})`, async () => {
    const { page, errors } = await openPage({ colorScheme: variant.colorScheme, viewport: variant.viewport });
    for (const route of PAGES) {
      await page.goto(`${httpBase}#/${route}`);
      await page.waitForSelector('#view > *');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `#/${route} scrolls sideways by ${overflow}px`);
    }
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test('works when index.html is opened from disk', async () => {
  const { page, errors } = await openPage();
  for (const route of PAGES) {
    await page.goto(`${fileBase}#/${route}`);
    await page.waitForSelector('#view > *');
  }
  assert.deepEqual(errors, []);
  assert.ok(fileURLToPath(fileBase).endsWith('index.html'));
  await page.close();
});

test('a page fades in when it opens, once: not on a re-render or another record on it', async () => {
  const { page, errors } = await openPage();
  await page.goto(`${httpBase}#/plant`);
  await page.waitForSelector('#view h1');
  const entering = () => page.evaluate(() => document.querySelector('#view').classList.contains('view-enter'));
  assert.equal(await entering(), true);
  await page.waitForFunction(() => !document.querySelector('#view').classList.contains('view-enter'));
  await rerender(page);
  assert.equal(await entering(), false); // a refresh of the same page doesn't move
  await page.goto(`${httpBase}#/plant/m-dc02`);
  await page.waitForSelector('#view h1:has-text("DC-02")');
  assert.equal(await entering(), false); // nor does another place on it
  await page.goto(`${httpBase}#/warnings`);
  await page.waitForSelector('#view h1:has-text("Warnings")');
  assert.equal(await entering(), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('dialogs keep focus, cancel with Escape and give focus back; toasts can be dismissed', async () => {
  const { page, errors } = await openPage();
  await page.goto(`${httpBase}#/settings`);
  await page.waitForSelector('#view h1');
  await page.focus('[data-reset]');
  await page.keyboard.press('Enter');
  const dialog = page.locator('dialog.dialog[open]');
  await dialog.waitFor();
  assert.equal(await dialog.getAttribute('role'), 'alertdialog');
  assert.match(await dialog.innerText(), /Reset this browser’s workspace\?/);
  // What can't be undone waits for its name.
  assert.equal(await dialog.locator('[data-confirm]').isDisabled(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'typed');
  await dialog.locator('input[name=typed]').fill('rese');
  assert.equal(await dialog.locator('[data-confirm]').isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog.dialog', { state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-reset')), true);
  assert.equal(await page.locator('#toast:has-text("Demo data reset")').count(), 0); // nothing reset
  // A click on the backdrop cancels too.
  await page.click('[data-reset]');
  await dialog.waitFor();
  await page.mouse.click(5, 5);
  await page.waitForSelector('dialog.dialog', { state: 'detached' });
  // A drag that starts in the field and ends outside the panel keeps it open.
  await page.click('[data-reset]');
  await dialog.waitFor();
  const field = await dialog.locator('input[name=typed]').boundingBox();
  await page.mouse.move(field.x + 10, field.y + 10);
  await page.mouse.down();
  await page.mouse.move(5, 5);
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal(await dialog.count(), 1);
  // Enter in the typed name confirms, once it matches.
  await dialog.locator('input[name=typed]').fill('reset');
  await dialog.locator('input[name=typed]').press('Enter');
  await page.waitForSelector('#toast:has-text("Demo data reset")');
  await page.waitForSelector('dialog.dialog', { state: 'detached' });
  // Toasts: shown in the stack, dismissed with their button; the others still go on their own.
  await page.click('#profile button[type=submit]');
  const item = page.locator('.toast-item:has-text("Profile saved")');
  await item.waitFor();
  await item.locator('.toast-close').click();
  await item.waitFor({ state: 'detached' });
  await page.mouse.move(5, 5); // off the stack: a toast's button under the pointer holds it
  await page.locator('.toast-item:has-text("Demo data reset")').waitFor({ state: 'detached', timeout: 8000 });
  // A tooltip names an icon button on keyboard focus.
  await page.focus('#theme');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab'); // focused from the keyboard: :focus-visible
  await page.waitForSelector('#tooltip:not([hidden])');
  assert.equal(await page.locator('#tooltip').innerText(), 'Light or dark theme');
  assert.equal(await page.getAttribute('#theme', 'aria-describedby'), 'tooltip');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#tooltip', { state: 'hidden' });
  // One that only repeats the button's name shows, but isn't read again as its description.
  await page.evaluate(() =>
    document
      .querySelector('#theme')
      ?.insertAdjacentHTML('afterend', '<button id="same" aria-label="Close" data-tooltip="Close">x</button>'),
  );
  await page.focus('#theme');
  await page.keyboard.press('Tab');
  await page.waitForSelector('#tooltip:not([hidden]):has-text("Close")');
  assert.equal(await page.getAttribute('#same', 'aria-describedby'), null);
  assert.deepEqual(errors, []);
  await page.close();
});

test('pages that load from the API hold still as they fill: layout shift under 0.05', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('press1.temperature', { unit: '°C' });
  fake.addSignal('dc1.pressure', { unit: 'bar' });
  raiseFrictionWarnings(fake);
  const shifts = {};
  for (const route of [
    'signals',
    'warnings',
    'documents',
    'insights',
    'apps',
    'reviews',
    'correlate',
    'plant',
    'onboarding',
  ]) {
    const { page, errors } = await openPage({ viewport: { width: 1280, height: 800 } });
    // Every layout shift not caused by input, added up (Cumulative Layout Shift, as browsers report it).
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/${route}`);
    await page.waitForSelector('#view h1');
    // Settled: nothing busy, and no request in flight (a phase that loads later shifts it too).
    await page.waitForFunction(() => !document.querySelector('#view [aria-busy=true]'), null, { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    shifts[route] = await page.evaluate(() => window.__cls);
    assert.deepEqual(errors, [], route);
    await page.close();
  }
  t.diagnostic(`layout shift ${JSON.stringify(shifts)}`);
  const over = Object.entries(shifts).filter(([, v]) => v >= 0.05);
  assert.deepEqual(over, [], JSON.stringify(shifts));
});

test('the style guide: from Settings, not in the menu, every section shown', async () => {
  const { page, errors } = await openPage();
  await page.goto(`${httpBase}#/settings`);
  await page.click('#about a:has-text("Style guide")');
  await page.waitForSelector('#view h1:has-text("Style guide")');
  assert.equal(await page.locator('#nav a[href="#/styleguide"]').count(), 0);
  // It sits under Settings: marked in the menu, and before it in the breadcrumbs.
  assert.equal(await page.locator('#nav a.active').getAttribute('href'), '#/settings');
  assert.deepEqual(await page.$$eval('#crumbs li', (lis) => lis.map((li) => li.textContent?.trim())), [
    'Home',
    'Settings',
    'Style guide',
  ]);
  // Its examples are examples: one page title, nothing read out as an alert.
  assert.equal(await page.locator('#view h1').count(), 1);
  assert.equal(await page.locator('#view [role=alert]').count(), 0);
  const chip = page.locator('.sg-pair .chip').first();
  const pressed = await chip.getAttribute('aria-pressed');
  await chip.click();
  assert.notEqual(await chip.getAttribute('aria-pressed'), pressed);
  // Tokens with their values, and each example in both themes.
  assert.ok((await page.locator('[data-sg-value]').count()) >= 80); // every token in :root (test/styleguide.test.js)
  assert.notEqual(await page.locator('[data-sg-value="--accent"]').innerText(), '');
  assert.equal(await page.locator('.sg-pair').count(), await page.locator('.sg-pair .sg-scheme.dark').count());
  // The dark sample is dark whatever the page's theme.
  const bg = (sel) =>
    page
      .locator(sel)
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(await bg('.sg-pair .sg-scheme.light'), await bg('.sg-pair .sg-scheme.dark'));
  await page.click('[data-jump="icons"]');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sg-sec-icons');
  await page.click('[data-sg-toast="error"]');
  await page.waitForSelector('.toast-item[data-type=error]:has-text("req-000042")');
  await page.click('[data-sg-dialog]');
  await page.locator('dialog.dialog [value=cancel]').click();
  await page.waitForSelector('#toast:has-text("You cancelled")');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the command palette: Ctrl K or / opens it, typing ranks, arrows move, Enter goes', async () => {
  const { page, errors } = await openPage();
  await page.goto(`${httpBase}#/`);
  await page.waitForSelector('#view h1');
  await page.keyboard.press('Control+k');
  const palette = page.locator('dialog.palette[open]');
  await palette.waitFor();
  const input = palette.locator('input[role=combobox]');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'combobox');
  await input.fill('warn');
  const options = palette.locator('[role=option]');
  // Both start with it: the menu's order holds.
  assert.deepEqual(await options.allInnerTexts(), ['Warnings\nOperations', 'Warning performance\nOperations']);
  assert.equal(await input.getAttribute('aria-activedescendant'), 'palette-0');
  await page.keyboard.press('ArrowDown');
  assert.equal(await palette.locator('[aria-selected=true]').innerText(), 'Warning performance\nOperations');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.waitForSelector('dialog.palette', { state: 'detached' });
  await page.waitForSelector('#view h1:text-is("Warnings")');
  // "/" opens it too (not while typing in a field); the last pick comes first; Escape closes.
  await page.keyboard.press('/');
  await palette.waitFor();
  assert.match(await palette.locator('.palette-group').first().innerText(), /Recent/);
  assert.match(await options.first().innerText(), /^Warnings/);
  await input.fill('zzqx');
  await palette.locator('.palette-status:has-text("Nothing matches")').waitFor();
  assert.equal(await palette.locator('[role=listbox]').isHidden(), true);
  assert.equal(await input.getAttribute('aria-activedescendant'), null);
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog.palette', { state: 'detached' });
  // The top bar's button opens it, and actions run from it.
  await page.click('#palette-open');
  await palette.waitFor();
  await input.fill('dark theme');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the palette finds the site’s signals through the API', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('press1.temperature', { unit: '°C' });
  const a = await openAs(t, apiUrl, null, '');
  await a.page.keyboard.press('Control+k');
  const palette = a.page.locator('dialog.palette[open]');
  await palette.locator('input').fill('press');
  await palette.locator('.palette-group:has-text("Signals")').waitFor();
  await palette.locator('.palette-item:has-text("press1.temperature")').click();
  // The Explorer opens with it (and tidies the link to #/explorer).
  await a.page.waitForSelector('#view h1:has-text("Data explorer")');
  await a.page.waitForSelector('#view :text("press1.temperature")');
  assert.deepEqual(a.errors, []);
});

test('the palette asks for signals typed before the site has loaded', async (t) => {
  // The sign-in settings answer late, so the site loads after the query is typed.
  const fake = createFakeApi({ slowAuthConfigMs: 1500 });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('press1.temperature', { unit: '°C' });
  const a = await openAs(t, apiUrl, null, '');
  await a.page.keyboard.press('Control+k');
  const palette = a.page.locator('dialog.palette[open]');
  await palette.locator('input').fill('press');
  await palette.locator('.palette-item:has-text("press1.temperature")').waitFor();
  assert.deepEqual(a.errors, []);
});

test('an API error stays with its request ID until dismissed, and is read out once', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('press1.temperature');
  fake.failSearch('broken');
  const a = await openAs(t, apiUrl, null, 'signals');
  await a.page.waitForSelector('#signal-search');
  await a.page.clock.install(); // time is moved on below, rather than waited out
  await a.page.fill('#signal-search [name=q]', 'broken');
  await a.page.press('#signal-search [name=q]', 'Enter');
  const item = a.page.locator('.toast-item[data-type=error]:not([data-state=closed])');
  await item.waitFor();
  await a.page.clock.runFor(500);
  // What happened (the API had a problem), why (its words) and what to do, with the request ID.
  assert.match(
    await item.innerText(),
    /The Tiles API had a problem[\s\S]*The catalogue is busy\. Try again[\s\S]*Request ID\s+req-\d{6}/,
  );
  // Read once, as an alert; the visible stack isn't a live region too.
  assert.match(
    await a.page.locator('[data-toast-announce=alert]').innerText(),
    /had a problem.*catalogue is busy.*req-\d{6}/,
  );
  assert.equal(await a.page.locator('#toast').getAttribute('aria-live'), null);
  // The same failure again refreshes the toast without reading it out again.
  await a.page.evaluate(() => (document.querySelector('[data-toast-announce=alert]').textContent = ''));
  await a.page.press('#signal-search [name=q]', 'Enter');
  await a.page.clock.runFor(500);
  await item.waitFor();
  assert.equal(await a.page.locator('[data-toast-announce=alert]').textContent(), '');
  // It doesn't go on its own.
  await a.page.mouse.move(5, 5);
  await a.page.clock.runFor(60_000);
  assert.equal(await item.count(), 1);
  await item.locator('.toast-close').click();
  await item.waitFor({ state: 'detached' });
  assert.deepEqual(
    a.errors.filter((e) => !/503/.test(e)),
    [],
  );
});

test('copilot answers a suggested question with its steps', async () => {
  const { page, errors } = await openPage();
  await page.goto(`${httpBase}#/chat`);
  await page.click('text=Is the DC-02 plunger at risk of seizing?');
  await page.waitForSelector('.msg.bot .trace');
  assert.match(await page.locator('.msg.bot').last().innerText(), /friction warning/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('ontology change can be staged, committed and reverted', async () => {
  const { page, errors } = await openPage();
  await page.goto(`${httpBase}#/ontology`);
  await page.fill('#node-form [name=label]', 'Alarm stream DC-02');
  await page.selectOption('#node-form [name=type]', 'Signal');
  await page.click('#node-form button');
  await page.fill('#commit-form [name=message]', 'add alarms node');
  await page.click('#commit-form button[type=submit]');
  await page.click('[data-tab=history]');
  const before = await page.locator('.commit').count();
  assert.match(await page.locator('.commit').first().innerText(), /add alarms node/);
  await page.locator('[data-revert]').first().click();
  assert.equal(await page.locator('.commit').count(), before + 1);
  assert.match(await page.locator('.commit').first().innerText(), /Revert "add alarms node"/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('on an ultrawide screen the page and its charts use the whole width', async (t) => {
  const { page, errors } = await openPage({ viewport: { width: 3440, height: 1300 } });
  t.after(() => page.close());
  await page.goto(`${httpBase}#/physics`);
  await page.waitForSelector('#run-chart svg');
  const sizes = () =>
    page.evaluate(() => ({
      main: document.querySelector('main').getBoundingClientRect().width,
      card: document.querySelector('#run-chart').getBoundingClientRect().width,
      chart: document.querySelector('#run-chart svg').getBoundingClientRect().width,
      drawn: document.querySelector('#run-chart svg').viewBox.baseVal.width,
    }));
  const wide = await sizes();
  assert.ok(wide.main > 3100, `main is ${wide.main}px wide`);
  assert.ok(wide.chart > wide.card - 2, 'the run chart fills its card');
  assert.ok(Math.abs(wide.drawn - wide.chart) < 60, 'drawn at its shown size, so its text is not enlarged');
  // A narrower window draws it again, narrower.
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.waitForFunction(() => document.querySelector('#run-chart svg').viewBox.baseVal.width === 1040);
  assert.deepEqual(errors, []);
});

test('a deployment opens its API by default, and a reset keeps it a default', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  const deployed = createTilesServer({ apiUrl });
  await new Promise((resolve) => deployed.listen(0, '127.0.0.1', resolve));
  const { page, errors } = await openPage();
  t.after(() => Promise.all([page.close(), fake.close(), new Promise((r) => deployed.close(r))]));
  await page.goto(`http://127.0.0.1:${deployed.address().port}/#/settings`);
  assert.equal(await page.locator('#datasource [name=mode][value=api]').isChecked(), true);
  assert.equal(await page.inputValue('#datasource [name=apiUrl]'), apiUrl);
  await page.waitForSelector('#notifications'); // the API's site has loaded
  await page.click('[data-reset]');
  await confirmIn(page, 'reset');
  await page.waitForSelector('#toast:has-text("Demo data reset")');
  // Nothing chosen in this browser, so nothing saved: a new address from the deployment still applies.
  assert.equal(await page.evaluate(() => localStorage.getItem('tiles:datasource')), null);
  assert.deepEqual(errors, []);
});

test("a page that can't reach the API says why and what to do, and tries again", async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.failSites(1);
  const { page, errors } = await openAs(t, apiUrl, null, 'warnings');
  // The API answered, with a reason: that is what the card says (not to check the address).
  const card = page.locator('#view [role=alert]:has-text("The site couldn\'t be loaded")');
  await card.waitFor();
  assert.match(await card.innerText(), /The API is starting\./);
  assert.doesNotMatch(await card.innerText(), /address/);
  assert.equal(await card.locator('a:has-text("Open Settings")').getAttribute('href'), '#/settings');
  // Copy details: what support needs to find it.
  assert.match(
    (await card.locator('[data-copy-details]').getAttribute('data-copy-details')) ?? '',
    /^What: The API is starting\nPage: #\/warnings\nTime: .+\nTiles: \d+\.\d+\.\d+$/,
  );
  // The API is up now: Try again connects, and the page fills.
  await card.locator('[data-reconnect]').click();
  await page.waitForSelector('[data-warning-list]');
  assert.deepEqual(
    errors.filter((e) => !/503/.test(e)),
    [],
  );
});

test('errors say what happened and the way out: no access, a conflict, not found, offline', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { out } = raiseFrictionWarnings(fake);
  const a = await openAs(t, apiUrl, null, 'warnings');
  await a.page.click(`[data-warning="${out}"]`);
  await a.page.waitForSelector('[data-act=acknowledge]');
  const toast = (text) => a.page.locator(`.toast-item:not([data-state=closed]):has-text("${text}")`);
  const ack = /\/warnings\/[^/]+\/acknowledge$/;

  // 403: what access is missing, and who gives it.
  fake.failNext('POST', ack, 403, 'Engineers and admins of the site act on warnings');
  await a.page.click('[data-act=acknowledge]');
  await toast("You don't have access to this").waitFor();
  assert.match(
    await toast("You don't have access to this").innerText(),
    /act on warnings\. A site admin can give you the role/,
  );
  // 409: what changed, and Refresh.
  fake.failNext('POST', ack, 409, 'The warning was resolved meanwhile');
  await a.page.click('[data-act=acknowledge]');
  await toast('This changed while you were working').waitFor();
  assert.equal(
    await toast('This changed while you were working').locator('[data-toast-action]').innerText(),
    'Refresh',
  );
  // 404: a way back.
  fake.failNext('GET', new RegExp(`/warnings/${out}$`), 404, 'No such warning');
  await a.page.click('[data-refresh-warnings]');
  await toast('Not found').waitFor();
  assert.equal(await toast('Not found').locator('[data-toast-action]').innerText(), 'Go back');

  // Offline: a banner says so, and a change isn't sent but says why.
  await a.page.context().setOffline(true);
  await a.page.waitForSelector('#offline:not([hidden]):has-text("You\'re offline")');
  assert.match(await a.page.locator('#offline').innerText(), /changes can't be sent until the connection is back/);
  const sent = fake.requests.length;
  await a.page.click('[data-act=acknowledge]');
  await toast("You're offline: nothing was changed").waitFor();
  assert.equal(fake.requests.slice(sent).filter((r) => r.startsWith('POST')).length, 0);
  const before = fake.requests.length;
  await a.page.context().setOffline(false);
  await a.page.waitForSelector('#offline', { state: 'hidden' });
  // Back online, what was on screen stays: the page is drawn again, not the whole site loaded afresh.
  await a.page.waitForSelector('[data-refresh-warnings]');
  assert.equal(fake.requests.slice(before).filter((r) => /\/ontology(\?|$)/.test(r)).length, 0);
  assert.deepEqual(
    a.errors.filter((e) => !/40[349]|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e)),
    [],
  );
});

test('with a slow API, buttons wait and nothing is sent twice; quick changes roll back (U2.08)', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'admin' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { out } = raiseFrictionWarnings(fake);
  const a = await openAs(t, apiUrl, null, 'settings');
  const count = (re) => fake.requests.filter((r) => re.test(r)).length;

  // A form sent twice while its request runs: one request, its button busy meanwhile.
  await a.page.fill('#agent-form [name=name]', 'press-shop-edge');
  fake.slowNext('POST', /\/agents$/, 1200);
  const register = a.page.locator('#agent-form button[type=submit]');
  await register.click();
  assert.equal(await register.getAttribute('aria-busy'), 'true');
  await a.page.locator('#agent-form').evaluate((f) => f.requestSubmit());
  await a.page.waitForSelector('[data-token]');
  assert.equal(count(/^POST .*\/agents$/), 1);

  // Acknowledging shows at once, before the API answers…
  await a.page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/warnings`);
  await a.page.click(`[data-warning="${out}"]`);
  await a.page.waitForSelector('[data-act=acknowledge]');
  const ack = /\/warnings\/[^/]+\/acknowledge$/;
  const badge = a.page.locator('[data-warning-detail] .badge').first();
  fake.slowNext('POST', ack, 1500);
  fake.failNext('POST', ack, 503, 'The API is restarting');
  await a.page.click('[data-act=acknowledge]');
  await a.page.waitForSelector('[data-warning-detail] .badge:has-text("Acknowledged")', { timeout: 1000 });
  assert.equal(await a.page.locator('[data-act=acknowledge]').count(), 0);
  // …and is taken back when the API refuses it, with the reason.
  await a.page.waitForSelector('.toast-item:has-text("The Tiles API had a problem")');
  await a.page.waitForSelector('[data-warning-detail] [data-act=acknowledge]');
  assert.equal(await badge.innerText(), 'New');
  assert.equal(count(new RegExp(`^POST .*${ack.source.slice(2, -1)}`)), 1);
  // Accepted, it stays.
  await a.page.click('[data-act=acknowledge]');
  await a.page.waitForSelector('#toast:has-text("Acknowledged")');
  assert.equal(await a.page.locator('[data-warning-detail] .badge').first().innerText(), 'Acknowledged');
  assert.deepEqual(
    a.errors.filter((e) => !/503/.test(e)),
    [],
  );
});

test('settings can switch to the Tiles API and test the connection', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  const { page, errors } = await openPage();
  t.after(() => Promise.all([page.close(), fake.close()]));
  await page.goto(`${httpBase}#/settings`);
  await page.fill('#datasource [name=apiUrl]', 'http://127.0.0.1:1');
  await page.click('[data-test-api]');
  await page.waitForSelector('[data-api-status]:has-text("Not reachable")');
  assert.match(await page.locator('#toast').innerText(), /Can't reach the Tiles API at http:\/\/127\.0\.0\.1:1/);

  await page.fill('#datasource [name=apiUrl]', apiUrl);
  await page.click('[data-test-api]');
  await page.waitForSelector('[data-api-status]:has-text("Connected: Tiles API fake (test)")');
  await page.check('#datasource [name=mode][value=api]');
  await page.click('#datasource button[type=submit]');
  await page.reload();
  assert.equal(await page.locator('#datasource [name=mode][value=api]').isChecked(), true);
  assert.equal(await page.inputValue('#datasource [name=apiUrl]'), apiUrl);

  // Resetting the workspace keeps the data source.
  await page.click('[data-reset]');
  await confirmIn(page, 'reset');
  await page.reload();
  assert.equal(await page.locator('#datasource [name=mode][value=api]').isChecked(), true);
  // Settled: loading the API's site re-renders the page, which would replace the field mid-fill.
  await page.waitForSelector('#notifications'); // drawn once the site has loaded

  // Something that isn't the Tiles API answering /health is not "Connected".
  const other = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  t.after(() => other.close());
  await page.fill('#datasource [name=apiUrl]', `http://127.0.0.1:${other.address().port}`);
  // A re-render (here as on navigating; the page's background loads re-render it the same way)
  // keeps the address being typed.
  await rerender(page);
  assert.equal(await page.inputValue('#datasource [name=apiUrl]'), `http://127.0.0.1:${other.address().port}`);
  await page.evaluate(() => (location.hash = '#/Settings')); // the same page, routes read in any case
  await page.waitForSelector('#datasource');
  assert.equal(await page.inputValue('#datasource [name=apiUrl]'), `http://127.0.0.1:${other.address().port}`);
  await page.click('[data-test-api]');
  await page.waitForSelector('[data-api-status]:has-text("not the Tiles API")');
  // A re-render (here, leaving and coming back) keeps the answer rather than wiping it.
  await page.evaluate(() => (location.hash = '#/'));
  await page.evaluate(() => (location.hash = '#/settings'));
  await page.waitForSelector('[data-api-status]:has-text("not the Tiles API")');

  // Local mode can be saved without an API address.
  await page.fill('#datasource [name=apiUrl]', '');
  await page.check('#datasource [name=mode][value=local]');
  await page.click('#datasource button[type=submit]');
  await page.waitForSelector('#toast:has-text("Using this browser only")');
  await page.reload();
  assert.equal(await page.locator('#datasource [name=mode][value=local]').isChecked(), true);
  assert.equal(await page.inputValue('#datasource [name=apiUrl]'), apiUrl);

  // The failed connection test logs a network error in the console; nothing else may.
  assert.deepEqual(
    errors.filter((e) => !/Failed to load resource|ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT/.test(e)),
    [],
  );
});

test('ontology page in API mode: import, commit, and see another user’s commits after refresh', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const open = async (email) => {
    const { page, errors } = await openPage();
    t.after(() => page.close());
    if (email) {
      // Another engineer: staged changes are kept per user.
      await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/settings`);
      await page.waitForSelector('#account:has-text("development user")'); // settled: no re-render mid-typing
      await page.fill('#profile [name=email]', email);
      await page.click('#profile button[type=submit]');
      await page.waitForSelector('#toast:has-text("Profile saved")');
      assert.equal(await page.inputValue('#profile [name=email]'), email);
      await page.evaluate(() => (location.hash = '#/ontology'));
    } else await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/ontology`);
    await page.waitForSelector('.source-bar:has-text("Shared through the Tiles API")'); // loaded
    return { page, errors };
  };
  // Refresh, and wait until the page shows what the API answered: each answer's body has arrived
  // (a response event fires on its headers), then the page has rendered.
  const refresh = async (page) => {
    const answered = (path) =>
      page
        .waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith(path))
        .then((r) => r.finished());
    await Promise.all([
      answered('/ontology/graph'),
      answered('/ontology/staged'),
      answered('/ontology/commits'),
      answered('/me'),
      page.click('[data-refresh]'),
    ]);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };

  const a = await open();
  await a.page.click('[data-import-demo]');
  await a.page.waitForSelector('#toast:has-text("Demo ontology imported")');
  assert.match(await a.page.locator('.source-bar').innerText(), /Shared through the Tiles API · Plant 1/);
  await a.page.click('[data-tab=history]');
  assert.match(await a.page.locator('.commit').first().innerText(), /Import demo ontology/);

  // A second browser sees the shared history straight away.
  const b = await open('eng2@example.com');
  await b.page.click('[data-tab=history]');
  assert.match(await b.page.locator('.commit').first().innerText(), /Import demo ontology/);

  // Browser A stages and commits; staged changes stay private until then.
  await a.page.click('[data-tab=canvas]');
  await a.page.fill('#node-form [name=label]', 'Alarm stream DC-02');
  await a.page.selectOption('#node-form [name=type]', 'Signal');
  await Promise.all([
    a.page.waitForResponse((r) => r.request().method() === 'POST' && /\/ontology\/staged/.test(r.url())),
    a.page.click('#node-form button'),
  ]);
  await a.page.waitForSelector('#commit-form');
  await refresh(b.page);
  assert.equal(await b.page.locator('#commit-form').count(), 0);
  await a.page.fill('#commit-form [name=message]', 'add alarms node');
  await a.page.click('#commit-form button[type=submit]');
  await a.page.waitForSelector('#toast:has-text("Committed")');

  // Someone else commits through the API too; B refreshes and sees both.
  fake.commitAs(
    'maria',
    [{ kind: 'addNode', node: { id: 'doc-x', type: 'Document', label: 'Shift notes', props: {} } }],
    'add shift notes',
  );
  await refresh(b.page);
  await b.page.click('[data-tab=history]');
  await b.page.waitForSelector('.commit b:has-text("add shift notes")');
  const messages = await b.page.locator('.commit b').allInnerTexts();
  assert.deepEqual(messages.slice(0, 3), ['add shift notes', 'add alarms node', 'Import demo ontology']);

  // Revert from B goes through the API and A sees it after a refresh.
  await b.page.locator('[data-revert]').first().click();
  await b.page.waitForSelector('#toast:has-text("Commit reverted")');
  await refresh(a.page);
  await a.page.click('[data-tab=history]');
  await a.page.waitForSelector('.commit:has-text(\'Revert "add shift notes"\')');
  assert.match(await a.page.locator('.commit').first().innerText(), /Revert "add shift notes"/);

  assert.deepEqual([...a.errors, ...b.errors], []);
});

test('the signals page says why it has no site, rather than asking to connect again', async (t) => {
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=http://127.0.0.1:1#/signals`);
  // What failed and what to do (check the API, try again), not "Connect to the Tiles API".
  await page.waitForSelector('#view [role=alert]:has-text("Can\'t reach the Tiles API")');
  assert.match(await page.locator('#view [role=alert]').innerText(), /Check that the API is running/);
  assert.equal(await page.locator('#view [data-reconnect]').count(), 1);
  assert.equal(await page.locator('#view:has-text("Connect to the Tiles API")').count(), 0);
  assert.deepEqual(
    errors.filter((e) => !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(e)),
    [],
  );
});

test('ontology page explains when the API is unreachable, and local mode is untouched', async (t) => {
  const { page } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=http://127.0.0.1:1#/ontology`);
  await page.waitForSelector('.source-bar:has-text("Can\'t load the ontology from the Tiles API")');
  await page.goto(`${httpBase}?api=local#/ontology`);
  await page.waitForSelector('#node-form');
  assert.equal(await page.locator('.source-bar').count(), 0);
});

test('switching back to local after a failed API connection restores this browser’s ontology', async (t) => {
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}#/ontology`);
  await page.click('[data-tab=history]');
  const localCommits = await page.locator('.commit').count();
  assert.ok(localCommits > 0);

  // Point at an API that isn't there: the page shows the error state...
  await page.goto(`${httpBase}#/settings`);
  await page.fill('#datasource [name=apiUrl]', 'http://127.0.0.1:1');
  await page.check('#datasource [name=mode][value=api]');
  await page.click('#datasource button[type=submit]');
  await page.goto(`${httpBase}#/ontology`);
  await page.waitForSelector('.source-bar:has-text("Can\'t load the ontology")');

  // ...and going back to local shows the local history again, without a reload.
  await page.goto(`${httpBase}#/settings`);
  await page.check('#datasource [name=mode][value=local]');
  await page.click('#datasource button[type=submit]');
  await page.goto(`${httpBase}#/ontology`);
  await page.click('[data-tab=history]');
  assert.equal(await page.locator('.commit').count(), localCommits);
  assert.deepEqual(
    errors.filter((e) => !/Failed to load resource|ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT/.test(e)),
    [],
  );
});

test('signing in to the Tiles API (OIDC with PKCE), using it, and signing out', async (t) => {
  const fake = createFakeApi({ oidc: true, requireSignIn: true });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openPage();
  t.after(() => page.close());

  // API mode only through ?api=, so the sign-in round trip must bring it back.
  const home = `${httpBase}?api=${encodeURIComponent(apiUrl)}`;
  await page.goto(`${home}#/ontology`);
  await page.waitForSelector('.source-bar [data-sign-in]'); // the API refuses us until we sign in
  await page.goto(`${home}#/settings`);
  await page.waitForSelector('#account:has-text("Sign in to use this Tiles API")');
  await page.click('#account [data-sign-in]');

  // Off to the provider and back: signed in, on the same page, callback params gone.
  await page.waitForSelector('#account:has-text("Signed in as Ana Lopez")');
  const back = new URL(page.url());
  assert.equal(back.searchParams.get('api'), apiUrl);
  assert.equal(back.searchParams.get('code'), null);
  assert.equal(back.hash, '#/settings');
  assert.match(await page.locator('#user').innerText(), /Ana Lopez/);

  // Requests now carry the token, so the ontology works.
  await page.goto(`${home}#/ontology`);
  await page.click('[data-import-demo]');
  await page.waitForSelector('#toast:has-text("Demo ontology imported")');
  await page.click('[data-tab=history]');
  assert.match(await page.locator('.commit').first().innerText(), /ana/);
  assert.ok(fake.requests.includes('POST /idp/token'));

  // A link to another API must not receive our token.
  const other = createFakeApi();
  const otherUrl = await other.listen();
  t.after(() => other.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(otherUrl)}#/ontology`);
  await page.waitForSelector('.source-bar:has-text("Shared through")');
  assert.deepEqual(other.bearersSeen, []);
  assert.ok(fake.bearersSeen.length > 0);

  // Signing out ends the session (and visits the provider's logout).
  await page.goto(`${home}#/settings`);
  const logout = page.waitForRequest((r) => r.url().includes('/idp/logout'));
  await page.click('#account [data-sign-out]');
  await logout;
  await page.waitForURL((u) => !u.pathname.startsWith('/idp'));
  await page.waitForSelector('#account:has-text("Sign in to use this Tiles API")');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tiles:oidc-session')), null);
  // Back on the same page, still pointed at the same API.
  const after = new URL(page.url());
  assert.equal(after.searchParams.get('api'), apiUrl);
  assert.equal(after.hash, '#/settings');

  // Only the expected 401s from before signing in reach the console.
  assert.deepEqual(
    errors.filter((e) => !/Failed to load resource: the server responded with a status of 401/.test(e)),
    [],
  );
});

test('staged changes invalidated by someone else’s commit can be discarded', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.commitAs(
    'maria',
    [{ kind: 'addNode', node: { id: 'm1', type: 'Machine', label: 'Press 1', props: {} } }],
    'add press',
  );
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/ontology`);
  await page.click('[data-node="m1"]');
  await page.fill('#prop-form [name=key]', 'vendor');
  await page.fill('#prop-form [name=value]', 'Acme');
  await page.click('#prop-form button');
  await page.waitForSelector('#commit-form');

  // Maria deletes the machine; our staged setProp on it no longer applies.
  fake.commitAs('maria', [{ kind: 'removeNode', id: 'm1' }], 'remove press');
  await page.click('[data-refresh]');
  await page.waitForSelector('.staged-bar:has-text("no longer fit")');
  assert.match(await page.locator('.staged-bar').innerText(), /Node m1 not found/);
  await page.click('.staged-bar [data-discard]');
  await page.waitForSelector('#toast:has-text("Changes discarded")');
  assert.equal(await page.locator('.staged-bar').count(), 0);
  assert.deepEqual(errors, []);
});

test('API placeholders and late API answers never replace this browser’s ontology', async (t) => {
  const fake = createFakeApi({ slowWritesMs: 1500 });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}#/ontology`);
  await page.click('[data-tab=history]');
  const localCommits = await page.locator('.commit').count();

  // 1. Saving the profile while the API is unreachable keeps the local ontology.
  await page.goto(`${httpBase}?api=http://127.0.0.1:1#/settings`);
  await page.waitForSelector('#profile');
  await page.fill('#profile [name=name]', 'Renamed User');
  await page.click('#profile button[type=submit]');

  // 2. A slow API write that lands after switching back to local is ignored.
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/ontology`);
  await page.click('[data-import-demo]'); // answered after 1.5 s
  await page.evaluate(() => (location.hash = '#/settings'));
  await page.check('#datasource [name=mode][value=local]');
  await page.click('#datasource button[type=submit]');
  await page.waitForTimeout(2500);

  await page.goto(`${httpBase}?api=local#/ontology`);
  await page.click('[data-tab=history]');
  assert.equal(await page.locator('.commit').count(), localCommits);
  assert.equal(await page.locator('#commit-form').count(), 0); // nothing from the API was staged locally
});

test('viewers see the shared ontology read-only', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.commitAs(
    'maria',
    [{ kind: 'addNode', node: { id: 'm1', type: 'Machine', label: 'Press 1', props: {} } }],
    'add press',
  );
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/ontology`);
  await page.waitForSelector('.source-bar:has-text("View only")');
  assert.equal(await page.locator('#node-form').count(), 0);
  assert.match(await page.locator('#inspector').innerText(), /Your role on this site is viewer/);
  // Inspecting works; editing controls are gone.
  await page.click('[data-node="m1"]');
  await page.waitForSelector('#inspector:has-text("Press 1")');
  for (const sel of ['#prop-form', '#link-form', '[data-delete]', '[data-unset]']) {
    assert.equal(await page.locator(sel).count(), 0, sel);
  }
  await page.click('[data-tab=history]');
  assert.equal(await page.locator('.commit').count(), 1);
  assert.equal(await page.locator('[data-revert]').count(), 0);
  assert.deepEqual(errors, []);
});

test('a viewer can discard changes staged before their demotion', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.stageAs('demo@example.com', [
    { kind: 'addNode', node: { id: 'old', type: 'Machine', label: 'Old press', props: {} } },
  ]);
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/ontology`);
  await page.waitForSelector('#viewer-staged:has-text("1 uncommitted")');
  assert.equal(await page.locator('#commit-form').count(), 0);
  await page.click('#viewer-staged [data-discard]');
  await page.waitForSelector('#viewer-staged', { state: 'detached' });
  assert.equal(await page.locator('[data-node="old"]').count(), 0);
  assert.deepEqual(errors, []);
});

test('Refresh picks up a role change made by an admin', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/ontology`);
  await page.waitForSelector('#node-form');
  fake.setRole('demo@example.com', 'viewer');
  await page.click('[data-refresh]');
  await page.waitForSelector('.source-bar:has-text("View only")');
  assert.equal(await page.locator('#node-form').count(), 0);
  fake.setRole('demo@example.com', 'engineer');
  await page.click('[data-refresh]');
  await page.waitForSelector('#node-form');
  assert.deepEqual(errors, []);
});

test('UX analytics: off until an organisation admin turns it on; then counts, and nothing about who', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'admin' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('press1.temperature', { unit: '°C' });
  const { out } = raiseFrictionWarnings(fake);
  const sent = () => fake.requests.filter((r) => /^POST .*\/ux-events$/.test(r)).length;

  // Off: pages are used and nothing is sent.
  const a = await openAs(t, apiUrl, null, 'settings');
  await a.page.waitForSelector('#ux-analytics:has-text("Nothing recorded in the last 30 days")');
  assert.equal(await a.page.isChecked('[data-ux-enabled]'), false);
  await a.page.evaluate(() => (location.hash = '#/warnings'));
  await a.page.waitForSelector('[data-warning-list]');
  assert.equal(sent(), 0);

  // On (organisation admins), at once in this tab.
  await a.page.evaluate(() => (location.hash = '#/settings'));
  await a.page.check('[data-ux-enabled]');
  await a.page.waitForSelector('#toast:has-text("UX analytics on")');
  await a.page.evaluate(() => (location.hash = '#/warnings'));
  await a.page.click(`[data-warning="${out}"]`);
  await a.page.click('[data-act=acknowledge]');
  await a.page.waitForSelector('#toast:has-text("Acknowledged")');
  await a.page.keyboard.press('Control+k');
  const palette = a.page.locator('dialog.palette[open]');
  await palette.locator('input').fill('press');
  await palette.locator('.palette-item:has-text("press1.temperature")').click();
  await a.page.waitForSelector('#view h1:has-text("Data explorer")');
  // Left before its batch is sent (every 10 s), the next load sends it.
  assert.equal(fake.uxEvents.length, 0);
  await a.page.reload();
  await waitFor(() => fake.uxEvents.some((e) => e.kind === 'palette'));

  const kept = new Set(fake.uxEvents.map((e) => `${e.kind}:${e.name}`));
  for (const want of [
    'page:explorer',
    'page:warnings',
    'task:warning.acknowledge',
    'palette:open',
    'palette:chose.signals',
  ])
    assert.ok(kept.has(want), want);
  // Nothing about who, or which record: no e-mail, no warning or signal id, no tag.
  const all = JSON.stringify(fake.uxEvents);
  for (const secret of ['demo@example.com', out, 'press1.temperature']) assert.ok(!all.includes(secret), secret);
  assert.equal(new Set(fake.uxEvents.map((e) => e.session)).size, 1); // the first load's; the second's wait to be sent

  // Admins see the counts.
  await a.page.evaluate(() => (location.hash = '#/settings'));
  await a.page.waitForSelector('#ux-analytics [data-ux-sessions]');
  assert.match(await a.page.locator('#ux-analytics table').innerText(), /Task done\s+warning\.acknowledge\s+1\s+1/);
  assert.match(await a.page.locator('[data-ux-sessions]').innerText(), /^1 browser session\(s\)/);
  assert.deepEqual(a.errors, []);

  // Engineers don't see the card.
  const engineer = createFakeApi();
  const engineerUrl = await engineer.listen();
  t.after(() => engineer.close());
  await a.page.goto(`${httpBase}?api=${encodeURIComponent(engineerUrl)}#/settings`);
  await a.page.waitForSelector('#account');
  await a.page.waitForSelector('#ux-analytics', { state: 'detached' });
});

test('site admins see the audit log in settings; others do not', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'admin' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openPage();
  t.after(() => page.close());
  const home = `${httpBase}?api=${encodeURIComponent(apiUrl)}`;
  await page.goto(`${home}#/ontology`);
  await page.click('[data-import-demo]');
  await page.waitForSelector('#toast:has-text("Demo ontology imported")');
  await page.goto(`${home}#/settings`);
  await page.waitForSelector('#audit table');
  assert.match(await page.locator('#audit').innerText(), /demo\s+Committed “Import demo ontology”/);
  assert.deepEqual(errors, []);

  // When it fails: what and why, and Try again loads it.
  fake.failNext('GET', /\/audit$/, 500, 'Database unavailable');
  await page.reload();
  await page.waitForSelector('#audit [role=alert]:has-text("The audit log could not be loaded")');
  await page.click('#audit [data-reconnect]');
  await page.waitForSelector('#audit table');
  errors.length = 0; // the failed request, on purpose

  const engineer = createFakeApi();
  const engineerUrl = await engineer.listen();
  t.after(() => engineer.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(engineerUrl)}#/settings`);
  await page.waitForSelector('#account');
  assert.equal(await page.locator('#audit').count(), 0);
});

test('organisation admins set their own sign-in and SCIM tokens; people sign in through it', async (t) => {
  const admins = { 'demo@example.com': 'admin', 'ana@example.com': 'admin' };
  const fake = createFakeApi({ oidc: true, roles: admins });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openPage();
  t.after(() => page.close());
  const home = `${httpBase}?api=${encodeURIComponent(apiUrl)}`;
  await page.goto(`${home}#/settings`);
  await page.waitForSelector('#org-sign-in:has-text("signs in through this deployment")');

  // The provider: the fake's own /idp stands in for an Entra ID tenant.
  const scope = 'openid profile email offline_access api://8a2b/access';
  const tenant = 'https://login.microsoftonline.com/6f1d0a59-0000-4000-8000-000000000001/v2.0';
  await page.fill('#org-provider-form [name=issuer]', 'http://idp.example.com');
  await page.fill('#org-provider-form [name=clientId]', 'spa-client');
  await page.fill('#org-provider-form [name=audience]', 'api-app');
  await page.fill('#org-provider-form [name=scope]', scope);
  await page.fill('#org-provider-form [name=groupRoles]', 'moulding-engineers = engineer');
  await page.click('#org-provider-form button[type=submit]');
  await page.waitForSelector('#toast:has-text("The issuer is an https address")'); // refused here
  await page.fill('#org-provider-form [name=issuer]', tenant);
  await page.click('#org-provider-form button[type=submit]');
  await page.waitForSelector('#toast:has-text("Organisation sign-in saved")');
  await page.waitForSelector('[data-org-provider-pending]'); // until an admin signs in through it
  assert.equal(await page.inputValue('#org-provider-form [name=groupRoles]'), 'moulding-engineers = engineer');

  // A SCIM token, shown once, with the tenant URL to give the provider.
  assert.match(await page.locator('#org-sign-in').innerText(), new RegExp(`${apiUrl}/scim/v2`));
  await page.fill('#scim-token-form [name=name]', 'Entra ID provisioning');
  await page.click('#scim-token-form button[type=submit]');
  await page.waitForSelector('[data-scim-token]');
  assert.match(await page.locator('[data-scim-token] pre').innerText(), /^tiles_scim_/);
  await page.click('[data-scim-token-done]');
  await page.waitForSelector('[data-scim-token]', { state: 'detached' });
  await page.click('[data-revoke-scim]');
  await confirmIn(page);
  await page.waitForSelector('#org-sign-in:has-text("No SCIM tokens yet")');

  // Signing in through the organisation's own provider asks for its scope.
  await page.fill('#org-sign-in-form [name=org]', 'Demo');
  await page.click('#org-sign-in-form button[type=submit]');
  await page.waitForSelector('#account:has-text("through demo\'s own sign-in")');
  assert.deepEqual(fake.scopesAsked, [scope]);
  await page.waitForSelector(`#org-sign-in:has-text("Signs in through ${tenant}")`); // confirmed
  // An organisation without one is told so.
  await page.click('#account [data-sign-out]');
  await page.waitForSelector('#account [data-sign-in]');
  assert.equal(await page.inputValue('#org-sign-in-form [name=org]'), 'demo'); // remembered
  await page.fill('#org-sign-in-form [name=org]', 'acme');
  await page.click('#org-sign-in-form button[type=submit]');
  await page.waitForSelector('#toast:has-text("acme has no sign-in of its own")');
  assert.deepEqual(
    errors.filter((e) => !/status of 404/.test(e)),
    [],
  );

  // Not an organisation admin: no card.
  const engineer = createFakeApi();
  const engineerUrl = await engineer.listen();
  t.after(() => engineer.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(engineerUrl)}#/settings`);
  await page.waitForSelector('#account');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#org-sign-in').isVisible(), false);
});

test('App Studio: an engineer makes an SPC app from its template, runs it, changes and archives it', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('oven.zone2_temp');
  const { page, errors } = await openPage();
  t.after(() => page.close());
  const home = `${httpBase}?api=${encodeURIComponent(apiUrl)}`;
  await page.goto(`${home}#/apps`);
  await page.waitForSelector('[data-app-list]:has-text("No apps yet")');
  await page.click('[data-new-app]');
  // The templates to start from, then the form made from the chosen one's settings.
  await page.click('[data-template="spc-limits"]');
  await page.waitForSelector('#app-form');
  // Sent without a signal, and limits out of range: each error under its field.
  await page.fill('#app-form [name=__name]', 'Oven zone 2');
  await page.fill('#app-form [name=sigmas]', '9');
  await page.click('#app-form button[type=submit]');
  await page.waitForSelector('#app-form .error-summary:has-text("Check these 2 fields")');
  assert.equal(await page.getAttribute('#app-form [name=signal]', 'aria-invalid'), 'true');
  // Named by its label alone, not the help beside it.
  assert.equal(await page.locator('#app-form .field-error').first().innerText(), 'Choose the signal');
  assert.match(await page.locator('#app-form .field-error').nth(1).innerText(), /^Enter 6 or less$/);
  await page.fill('#app-form [name=sigmas]', '3');
  await page.selectOption('#app-form [name=signal]', { label: 'oven.zone2_temp' });
  assert.equal(await page.inputValue('#app-form [name=sigmas]'), '3'); // the template's default
  await page.uncheck('#app-form [name=rules][value=trend_of_six]');
  await page.click('#app-form button[type=submit]');
  await page.waitForSelector('#toast:has-text("App #1 made")');
  await page.waitForSelector('[data-app-status]:has-text("Out of control")');
  assert.equal(new URL(page.url()).hash, '#/apps/1');
  assert.equal(await page.locator('#crumbs [aria-current=page]').innerText(), '#1');
  assert.equal(await page.getAttribute('#crumbs a:has-text("App Studio")', 'href'), '#/apps');
  assert.match(await page.locator('[data-app-text]').innerText(), /Out of control: 1 signal/);
  assert.equal(await page.locator('[data-app-detail] svg.chart .span').count(), 1);
  assert.deepEqual(fake.studioApps[0].config.rules, ['beyond_limits']);
  // Settings in words.
  await page.click('[data-app-detail] summary');
  assert.match(await page.locator('[data-app-settings]').innerText(), /Signal: oven.zone2_temp/);

  // Changing it: the form holds the template's limits, so the browser checks them before sending.
  await page.click('[data-edit-app]');
  await page.waitForSelector('#app-form:has-text("Change #1 Oven zone 2")');
  await page.fill('#app-form [name=sigmas]', '9');
  await page.click('#app-form button[type=submit]');
  assert.equal(await page.$eval('#app-form [name=sigmas]', (el) => el.validity.rangeOverflow), true);
  assert.equal(fake.studioApps[0].config.sigmas, 3); // not sent
  await page.fill('#app-form [name=sigmas]', '2.5');
  await page.click('#app-form button[type=submit]');
  await page.waitForSelector('#toast:has-text("App saved")');
  assert.equal(fake.studioApps[0].config.sigmas, 2.5);
  // Cancel drops what was typed: the next change starts from the saved settings.
  await page.click('[data-edit-app]');
  await page.fill('#app-form [name=sigmas]', '4');
  await page.click('#app-form a.btn:has-text("Cancel")');
  await page.waitForSelector('[data-app-detail]');
  await page.click('[data-edit-app]');
  assert.equal(await page.inputValue('#app-form [name=sigmas]'), '2.5');
  await page.click('#app-form a.btn:has-text("Cancel")');

  // Archived at once, with Undo (U2.03): Undo brings it back; left alone, it stays archived.
  await page.click('[data-archive-app]');
  await page.waitForSelector('[data-app-list]:has-text("No apps yet")');
  await undoToast(page, 'Archived #1');
  await page.waitForSelector('[data-app-list]:has-text("Oven zone 2")');
  await page.waitForSelector('#toast:has-text("Restored #1")');
  await page.click('[data-app="1"]');
  await page.click('[data-archive-app]');
  await page.waitForSelector('[data-app-list]:has-text("No apps yet")');
  assert.deepEqual(errors, []);

  // A list that fails to load says so, and loads again on request.
  fake.failApps(2);
  await page.reload();
  await page.waitForSelector('[data-app-list]:has-text("The apps could not be loaded")');
  await page.click('[data-retry-apps]');
  await page.waitForSelector('[data-app-list]:has-text("No apps yet")');

  // Viewers see the apps, but don't make them.
  const viewer = createFakeApi({ roles: { 'demo@example.com': 'viewer' } });
  const viewerUrl = await viewer.listen();
  t.after(() => viewer.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(viewerUrl)}#/apps`);
  await page.waitForSelector('[data-app-list]:has-text("Engineers make them")');
  assert.equal(await page.locator('[data-new-app]').count(), 0);
});

test('Documents: an engineer uploads an SOP, searches it, and opens the page a match is on', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openPage();
  t.after(() => page.close());
  const home = `${httpBase}?api=${encodeURIComponent(apiUrl)}`;
  await page.goto(`${home}#/documents`);
  await page.waitForSelector('[data-doc-list]:has-text("No documents yet")');
  const sop =
    'SOP 14: die-casting start-up\fCheck the hydraulic pressure: 140 to 160 bar.\fReplace the plunger tip after 20000 shots.';
  await page.setInputFiles('#doc-upload [name=file]', {
    name: 'SOP_14 start-up.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(sop),
  });
  await page.click('#doc-upload button[type=submit]');
  await page.waitForSelector('#toast:has-text("Uploaded SOP 14 start-up: 3 page(s)")');
  await page.waitForSelector('[data-doc-list]:has-text("SOP 14 start-up")');
  assert.equal(fake.siteDocuments[0].content.toString(), sop); // sent as it is

  // A search: each match with its page, the words marked.
  await page.fill('#doc-search [name=q]', 'plunger tips');
  await page.click('#doc-search button[type=submit]');
  await page.waitForSelector('[data-matches]');
  assert.match(await page.locator('[data-matches]').innerText(), /SOP 14 start-up[\s\S]*Open page 3/);
  assert.deepEqual(await page.locator('[data-matches] mark').allInnerTexts(), ['plunger', 'tip']);
  const popup = page.waitForEvent('popup');
  await page.click('[data-matches] [data-open]');
  await popup;
  await page.fill('#doc-search [name=q]', 'spindle');
  await page.click('#doc-search button[type=submit]');
  await page.waitForSelector('[data-no-matches]');
  // A search that fails says so (not "nothing matches"), and runs again on request.
  fake.failDocumentSearch(1);
  await page.fill('#doc-search [name=q]', 'hydraulic');
  await page.click('#doc-search button[type=submit]');
  await page.click('[data-retry-search]');
  await page.waitForSelector('[data-matches]:has-text("Open page 2")');

  // Archived at once, with Undo (U2.03).
  await page.click('[data-archive-doc="1"]');
  await page.waitForSelector('[data-doc-list]:has-text("No documents yet")');
  await undoToast(page, 'Archived');
  await page.waitForSelector('[data-doc-list] [data-archive-doc="1"]');
  await page.click('[data-archive-doc="1"]');
  await page.waitForSelector('[data-doc-list]:has-text("No documents yet")');
  assert.deepEqual(
    errors.filter((e) => !/status of 503/.test(e)),
    [],
  );

  // Viewers search, but don't upload.
  const viewer = createFakeApi({ roles: { 'demo@example.com': 'viewer' } });
  const viewerUrl = await viewer.listen();
  t.after(() => viewer.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(viewerUrl)}#/documents`);
  await page.waitForSelector('[data-doc-list]:has-text("No documents yet")');
  assert.equal(await page.locator('#doc-upload').count(), 0);
});

test('site admins register edge agents and see them come online', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'admin' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openPage();
  t.after(() => page.close());
  const home = `${httpBase}?api=${encodeURIComponent(apiUrl)}`;
  await page.goto(`${home}#/settings`);
  await page.waitForSelector('#agents:has-text("No edge agents yet")');
  await page.fill('#agent-form [name=name]', 'press-shop-edge');
  await page.click('#agent-form button[type=submit]');
  // The token is shown once, with a config file to copy.
  const token = (await page.locator('[data-token]').innerText()).trim();
  assert.match(token, /^tla_/);
  assert.match(await page.locator('#agents').innerText(), new RegExp(`url = "${apiUrl}"`));
  assert.match(await page.locator('#agents tbody').innerText(), /press-shop-edge\s+never seen/);
  await page.click('[data-token-done]');
  assert.equal(await page.locator('[data-token]').count(), 0);

  fake.heartbeat(
    token,
    'edge-host-7',
    [{ name: 'press-line', kind: 'opcua', status: 'down', detail: 'the server certificate is not the pinned one' }],
    { queued: 1200, oldest_at: null, sent: 5, dropped: 0, rejected: 0, problem: "can't reach Tiles" },
  );
  await page.reload();
  await page.waitForSelector('#agents tbody:has-text("online")');
  assert.match(await page.locator('#agents tbody').innerText(), /edge-host-7/);
  const connector = page.locator('#agents .badge:has-text("press-line down")');
  assert.equal(await connector.getAttribute('title'), 'opcua: the server certificate is not the pinned one');
  const buffered = page.locator('#agents .badge:has-text("1,200 queued")');
  assert.match(await buffered.getAttribute('title'), /1200 waiting\. 5 sent.*can't reach Tiles$/);
  await page.click('[data-revoke-agent]');
  await confirmIn(page);
  await page.waitForSelector('#agents:has-text("No edge agents yet")');
  assert.deepEqual(errors, []);
});

test('forms show errors on their fields: missing, in the wrong form, and refused by the API (U2.07)', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'admin' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/settings`);
  await page.waitForSelector('#agents table, #agents .empty, #agents p');
  const name = page.locator('#agent-form [name=name]');
  const posts = () => fake.requests.filter((r) => /^POST .*\/agents$/.test(r)).length;

  // Sent empty: the error is under the field, and a summary at the top takes the focus. Nothing sent.
  await page.click('#agent-form button[type=submit]');
  await page.waitForSelector('#agent-form .error-summary:has-text("Check this field")');
  assert.equal(await name.getAttribute('aria-invalid'), 'true');
  const errorId = await name.getAttribute('aria-describedby');
  assert.match(await page.locator(`#${errorId}`).innerText(), /^Enter the new agent name$/);
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'error-summary');
  assert.equal(posts(), 0);
  // Its link moves to the field, not to another page.
  await page.click('#agent-form .error-summary a');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'name');
  assert.match(page.url(), /#\/settings$/);

  // Checked again as it is left (not while typing): the format, then put right.
  await name.fill('bad name!');
  assert.match(await page.locator('#agent-form .field-error').innerText(), /^Enter the new agent name$/);
  await name.blur();
  await page.waitForSelector('#agent-form .field-error:has-text("Letters, digits, dot, dash or underscore")');
  await name.fill('press-shop-edge');
  await name.blur();
  await page.waitForSelector('#agent-form .field-error', { state: 'detached' });
  assert.equal(await name.getAttribute('aria-invalid'), null);
  assert.equal(await page.locator('#agent-form .error-summary').count(), 0);

  // The API refuses the name: its words, on the field (no toast).
  fake.failNext('POST', /\/agents$/, 422, [{ loc: ['body', 'name'], msg: 'An agent of that name exists' }]);
  await page.click('#agent-form button[type=submit]');
  await page.waitForSelector('#agent-form .field-error:has-text("An agent of that name exists")');
  assert.equal(await page.locator('.toast-item:has-text("accepted")').count(), 0);

  // The signal form: its own checks and the API's, under the field, also once it is drawn again.
  fake.addSignal('press1.temperature', { source: 'edge:press-shop-edge' });
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.locator('tr', { hasText: 'press1.temperature' }).first().locator('[data-edit]').click();
  await page.fill('#signal-form [name=rate]', '0');
  await page.click('#signal-form button[type=submit]');
  await page.waitForSelector('#signal-form .field-error:has-text("readings per second, above 0")');
  assert.equal(await page.locator('#signal-form [name=rate]').getAttribute('aria-invalid'), 'true');
  // Leaving the field unchanged keeps the page's own error (the browser alone finds nothing wrong).
  await page.focus('#signal-form [name=rate]');
  await page.locator('#signal-form [name=rate]').blur();
  assert.equal(await page.locator('#signal-form [name=rate]').getAttribute('aria-invalid'), 'true');
  await page.fill('#signal-form [name=rate]', '10');
  fake.failNext('PATCH', /\/signals\/[^/]+$/, 422, [{ loc: ['body', 'sample_rate_hz'], msg: 'Must be at most 1000' }]);
  await page.click('#signal-form button[type=submit]');
  await page.waitForSelector('#signal-form .field-error:has-text("Must be at most 1000")');
  assert.equal(await page.locator('#signal-form [name=rate]').getAttribute('aria-invalid'), 'true');
  assert.deepEqual(
    errors.filter((e) => !/422/.test(e)),
    [],
  );
});

test('a revealed agent token never follows you to another API', async (t) => {
  const first = createFakeApi({ roles: { 'demo@example.com': 'admin' } });
  const second = createFakeApi({ roles: { 'demo@example.com': 'admin' } });
  const [a, b] = [await first.listen(), await second.listen()];
  t.after(() => Promise.all([first.close(), second.close()]));
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(a)}#/settings`);
  await page.waitForSelector('#agents:has-text("No edge agents yet")');
  await page.fill('#agent-form [name=name]', 'edge-01');
  await page.click('#agent-form button[type=submit]');
  await page.waitForSelector('[data-token]');
  // Switch to another API in Settings, in the same page (no reload): the token stays behind.
  await page.fill('#datasource [name=apiUrl]', b);
  await page.click('#datasource button[type=submit]');
  await page.waitForSelector('#toast:has-text("Using the Tiles API")');
  await page.waitForSelector('#agents:has-text("No edge agents yet")');
  assert.equal(await page.locator('[data-token]').count(), 0);
  assert.deepEqual(errors, []);
});

test('non-admins see the edge agents but cannot register them', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/settings`);
  await page.waitForSelector('#agents:has-text("No edge agents yet")');
  assert.equal(await page.locator('#agent-form').count(), 0);
  assert.deepEqual(errors, []);
});

test('an engineer imports a CSV file, mapped to signals, and importing it again adds nothing', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/import`);
  await page.waitForSelector('[data-import-history]:has-text("No imports yet")');
  const csv =
    'Zeitstempel;Presse 1 Temperatur;Presse 1 Druck;Bemerkung\n01.10.2026 08:00;21,5;3,5;ok\n01.10.2026 08:01;22,0;;Bad\n';
  const file = { name: 'presse-1.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) };
  await page.setInputFiles('[data-import-file]', file);
  await page.waitForSelector('#import-mapping');
  // Suggested: day-first times, decimal comma, the two numeric columns; the comment column left out.
  assert.equal(await page.inputValue('[name=timeFormat]'), 'dmy');
  assert.equal(await page.isChecked('[name=decimalComma]'), true);
  assert.equal(await page.inputValue('[name=tag-1]'), 'presse-1-temperatur');
  assert.equal(await page.isChecked('[name=use-3]'), false);
  // A time zone that isn't one is marked on its field (U2.07), and goes once put right.
  await page.fill('[name=timeZone]', 'Mars/Base');
  await page.locator('[name=timeZone]').dispatchEvent('change');
  await page.waitForSelector('#import-mapping .field-error:has-text("isn\'t a time zone")');
  assert.equal(await page.getAttribute('[name=timeZone]', 'aria-invalid'), 'true');
  await page.fill('[name=timeZone]', 'Europe/Berlin');
  await page.locator('[name=timeZone]').dispatchEvent('change');
  assert.equal(await page.locator('#import-mapping .field-error').count(), 0);
  await page.fill('[name=tag-2]', 'press1.pressure');
  await page.locator('[name=tag-2]').dispatchEvent('change');
  assert.match(
    await page.locator('[data-import-summary]').innerText(),
    /^3 readings for 2 signal\(s\) in 2 rows from 2026-10-01 06:00:00 to 2026-10-01 06:01:00 UTC\.$/,
  );
  await page.click('[data-import-run]');
  await page.waitForSelector('[data-import-progress]:has-text("Done. 3 new readings stored")');
  assert.deepEqual([...fake.samples.entries()].sort(), [
    ['press1.pressure|2026-10-01T06:00:00.000000Z', 3.5],
    ['presse-1-temperatur|2026-10-01T06:00:00.000000Z', 21.5],
    ['presse-1-temperatur|2026-10-01T06:01:00.000000Z', 22],
  ]);
  await page.waitForSelector('[data-import-history] td:has-text("presse-1.csv")');
  assert.match(await page.locator('[data-import-history] tbody tr').first().innerText(), /finished/);

  await page.click('[data-import-run]'); // the same file again
  await page.waitForSelector('[data-import-progress]:has-text("Done. 0 new readings stored (3 sent")');
  assert.equal(fake.samples.size, 3);
  assert.deepEqual(errors, []);
});

test('a historian export with one row per reading maps each row by its tag', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/import`);
  const csv = 'TagName,TimeStamp,Value\nTT-101,2026-10-01T08:00:00Z,21.5\nPT-7,2026-10-01T08:00:00Z,3.5\n';
  await page.setInputFiles('[data-import-file]', {
    name: 'pi-export.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page.waitForSelector('#import-mapping');
  assert.equal(await page.isChecked('[name=shape][value=long]'), true);
  assert.match(await page.locator('[data-import-summary]').innerText(), /^2 readings for 2 signal\(s\)/);
  await page.click('[data-import-run]');
  await page.waitForSelector('[data-import-progress]:has-text("Done. 2 new readings stored")');
  assert.deepEqual([...fake.samples.keys()].sort(), [
    'pt-7|2026-10-01T08:00:00.000000Z',
    'tt-101|2026-10-01T08:00:00.000000Z',
  ]);
  assert.deepEqual(errors, []);
});

test('an import that cannot be marked finished says so, rather than done', async (t) => {
  const fake = createFakeApi({ failImportFinish: true });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/import`);
  const csv = 'time,temp\n2026-10-01T08:00:00Z,21.5\n';
  await page.setInputFiles('[data-import-file]', { name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.click('[data-import-run]');
  await page.waitForSelector('[data-import-progress]:has-text("All readings sent, but not finished")');
  assert.match(
    await page.locator('[data-import-progress]').innerText(),
    /could not be marked finished \(Tiles is restarting\)/,
  );
  await page.waitForSelector('[data-import-history] td:has-text("not finished")');
});

test('viewers see past imports but cannot run one', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const eng = { 'content-type': 'application/json', 'x-tiles-user': 'eng@example.com' };
  const sites = `${apiUrl}/sites/11111111-1111-1111-1111-111111111111/imports`;
  const run = await (await fetch(sites, { method: 'POST', headers: eng, body: '{"name":"line-2.csv"}' })).json();
  await fetch(`${sites}/${run.id}/finish`, { method: 'POST', headers: eng });
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/import`);
  await page.waitForSelector('[data-import-history] td:has-text("line-2.csv")');
  assert.match(await page.locator('#view').innerText(), /Your role on this site is viewer/);
  assert.equal(await page.locator('[data-import-file]').count(), 0);
  assert.deepEqual(errors, []);
});

test('the signal catalogue: search, describe a signal and link it to its ontology node', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.commitAs(
    'maria',
    [
      {
        kind: 'addNode',
        node: { id: 'sig-p1-temp', type: 'Signal', label: 'Press 1 temperature', props: { unit: '°C' } },
      },
    ],
    'add signal node',
  );
  fake.addSignal('press1.temperature', { source: 'edge:press-shop-edge' });
  fake.addSignal('press1.force', { source: 'edge:press-shop-edge' });
  fake.addSignal('oven.temp', { source: 'import:oven.csv' });
  fake.samples.set('press1.temperature|2026-10-08T06:00:00.000000Z', 21.5);
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.waitForSelector('[data-signal-count]:has-text("3 signal(s)")');
  await page.fill('#signal-search [name=q]', 'press1');
  await page.waitForSelector('[data-signal-count]:has-text("2 signal(s)")');
  await page.selectOption('#signal-search [name=linked]', 'no');
  await page.waitForSelector('[data-signal-count]:has-text("2 signal(s)")');

  const row = page.locator('tr', { hasText: 'press1.temperature' }).first();
  assert.match(await row.innerText(), /Edge agent press-shop-edge/);
  await row.locator('[data-edit]').click();
  await page.fill('#signal-form [name=unit]', '°C');
  await page.fill('#signal-form [name=rate]', '10');
  await page.fill('#signal-form [name=description]', 'Platen, upper');
  await page.selectOption('#signal-form [name=node]', 'sig-p1-temp');
  await page.click('#signal-form button[type=submit]');
  // Linked now, it leaves the "Not linked" list.
  await page.waitForSelector('[data-signal-count]:has-text("1 signal(s)")');
  assert.equal(await page.locator('tr', { hasText: 'press1.temperature' }).count(), 0);
  assert.equal(await page.locator('#signal-form').count(), 0);

  await page.selectOption('#signal-search [name=linked]', 'yes');
  await page.waitForSelector('[data-signal-results] a:has-text("Press 1 temperature")');
  assert.match(await page.locator('tr', { hasText: 'press1.temperature' }).first().innerText(), /21\.5 °C/);
  assert.deepEqual(errors, []);
});

test("switching to another Tiles API never shows the previous one's signals", async (t) => {
  const first = createFakeApi();
  const second = createFakeApi();
  const [firstUrl, secondUrl] = await Promise.all([first.listen(), second.listen()]);
  t.after(() => Promise.all([first.close(), second.close()]));
  first.addSignal('first.tag');
  second.addSignal('second.tag');
  second.slowSearch('', 1500);
  const { page, errors } = await openPage();
  t.after(() => page.close());
  const show = (hash) => page.evaluate((h) => (location.hash = h), hash); // the same page, not a reload
  const useApi = async (url) => {
    await show('#/settings');
    await page.waitForSelector('#datasource');
    await page.fill('#datasource [name=apiUrl]', url);
    await page.check('#datasource [name=mode][value=api]');
    await page.click('#datasource button[type=submit]');
  };
  await page.goto(`${httpBase}#/settings`);
  await useApi(firstUrl);
  await show('#/signals');
  await page.waitForSelector('[data-signal-results] code:has-text("first.tag")');
  await useApi(secondUrl);
  await show('#/signals');
  await page.waitForSelector('[data-signal-results]:has-text("Loading")');
  assert.equal(await page.locator('[data-signal-results] code:has-text("first.tag")').count(), 0);
  await page.waitForSelector('[data-signal-results] code:has-text("second.tag")');
  assert.deepEqual(errors, []);
});

test('leaving the signals page mid-search never leaves it loading', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('press1.temperature');
  fake.addSignal('oven.temp');
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.waitForSelector('[data-signal-count]:has-text("2 signal(s)")');
  fake.slowSearch('oven', 600);
  await page.fill('#signal-search [name=q]', 'oven');
  // Away and back before the typed search is sent, while the page's own search is still waiting.
  await page.evaluate(() => {
    location.hash = '#/import';
    location.hash = '#/signals';
  });
  await page.waitForSelector('[data-signal-count]:has-text("1 signal(s)")');
  await page.waitForTimeout(800);
  assert.match(await page.locator('[data-signal-results]').innerText(), /oven\.temp/);
  assert.deepEqual(errors, []);
});

test('an edit started while the list refreshes survives the refresh, and a failed one', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('oven.temp');
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.waitForSelector('[data-signal-count]:has-text("1 signal(s)")');
  await page.evaluate(() => (location.hash = '#/import'));
  // Back on the page: the last list shows at once while a slow refresh runs.
  fake.slowSearch('', 1200);
  await page.evaluate(() => (location.hash = '#/signals'));
  await page.click('[data-edit]');
  await page.fill('#signal-form [name=unit]', 'bar');
  await page.waitForTimeout(1500); // the refresh lands
  assert.equal(await page.inputValue('#signal-form [name=unit]'), 'bar');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'unit');
  // A refresh that fails keeps the list and the form.
  fake.failSearch('');
  await page.evaluate(() => (location.hash = '#/import'));
  await page.evaluate(() => (location.hash = '#/signals'));
  await page.fill('#signal-form [name=unit]', 'kPa'); // the form is still open
  await page.waitForSelector('#toast:has-text("The catalogue is busy")');
  assert.equal(await page.inputValue('#signal-form [name=unit]'), 'kPa');
  assert.match(await page.locator('[data-signal-results]').innerText(), /oven\.temp/);
  assert.deepEqual(
    errors.filter((e) => !/status of 503/.test(e)), // the browser logs the failed request
    [],
  );
});

test("a refresh keeps only the fields being edited, and another engineer's change shows", async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('oven.temp', { description: 'Zone 1' });
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.waitForSelector('[data-signal-count]:has-text("1 signal(s)")');
  await page.evaluate(() => (location.hash = '#/import'));
  fake.slowSearch('', 1200);
  await page.evaluate(() => (location.hash = '#/signals'));
  await page.click('[data-edit]');
  fake.addSignal('oven.temp', { description: 'Zone 1, upper' }); // another engineer, meanwhile
  await page.fill('#signal-form [name=unit]', '°C');
  await page.waitForTimeout(1500); // the refresh lands
  assert.equal(await page.inputValue('#signal-form [name=unit]'), '°C');
  assert.equal(await page.inputValue('#signal-form [name=description]'), 'Zone 1, upper');
  assert.deepEqual(errors, []);
});

test('a description with line breaks is not rewritten by an edit to another field', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const sig = fake.addSignal('oven.temp', { description: 'Zone 1\nupper heater' }); // as the API allows
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.click('[data-edit]');
  await page.fill('#signal-form [name=rate]', '5');
  await page.click('#signal-form button[type=submit]');
  await page.waitForSelector('#toast:has-text("Saved oven.temp")');
  assert.equal(sig.sample_rate_hz, 5);
  assert.equal(sig.description, 'Zone 1\nupper heater');
  assert.deepEqual(errors, []);
});

test('the edit form is locked while its change is saved', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('oven.temp');
  fake.slowSave(800);
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.click('[data-edit]');
  await page.fill('#signal-form [name=unit]', '°C');
  await page.click('#signal-form button[type=submit]');
  await page.waitForSelector('#signal-form button[type=submit][aria-busy=true]');
  assert.equal(await page.locator('#signal-form [name=description]').isDisabled(), true);
  await page.locator('#signal-form').evaluate((f) => f.requestSubmit()); // a second submit is ignored
  await page.waitForSelector('#toast:has-text("Saved oven.temp")');
  assert.equal(fake.requests.filter((r) => r.startsWith('PATCH ')).length, 1);
  assert.deepEqual(errors, []);
});

test('a save that finishes late never closes another signal opened meanwhile', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('a.flow');
  fake.addSignal('b.flow');
  fake.slowSave(800);
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.locator('tr', { hasText: 'a.flow' }).first().locator('[data-edit]').click();
  await page.fill('#signal-form [name=unit]', 'm³/h');
  await page.click('#signal-form button[type=submit]');
  await page.locator('tr', { hasText: 'b.flow' }).first().locator('[data-edit]').click(); // while a.flow saves
  await page.fill('#signal-form [name=description]', 'Return line');
  await page.click('#signal-form button[type=submit]'); // b.flow can't be saved until a.flow is
  await page.waitForSelector('#toast:has-text("Wait for a.flow to be saved, then save this one")');
  await page.waitForSelector('#toast:has-text("Saved a.flow")');
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue('#signal-form [name=description]'), 'Return line');
  assert.match(await page.locator('[data-signal-results]').innerText(), /m³\/h/);
  assert.deepEqual(errors, []);
});

test('changing a filter just before leaving never shows the old results on return', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('oven.temp', { source: 'import:oven.csv' });
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.waitForSelector('[data-signal-results] code:has-text("oven.temp")');
  fake.slowSearch('', 1500);
  await page.selectOption('#signal-search [name=source]', 'edge');
  await page.evaluate(() => (location.hash = '#/import')); // within the debounce
  await page.evaluate(() => (location.hash = '#/signals'));
  await page.waitForSelector('[data-signal-results]:has-text("Loading")');
  assert.equal(await page.locator('[data-signal-results] code:has-text("oven.temp")').count(), 0);
  await page.waitForSelector('[data-signal-results]:has-text("No signals match")');
  // The empty state's way out: clear the search.
  await page.click('[data-clear-search]');
  await page.waitForSelector('[data-signal-results] code:has-text("oven.temp")');
  assert.equal(await page.inputValue('#signal-search [name=source]'), '');
  assert.deepEqual(errors, []);
});

test('a search typed just before leaving the signals page is never sent', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('oven.temp');
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.waitForSelector('[data-signal-count]:has-text("1 signal(s)")');
  const searches = () => fake.requests.filter((r) => /^GET \/sites\/[^/]+\/signals$/.test(r)).length;
  const before = searches();
  await page.fill('#signal-search [name=q]', 'oven');
  await page.evaluate(() => (location.hash = '#/settings'));
  await page.waitForTimeout(600); // past the debounce
  assert.equal(searches(), before);
  assert.deepEqual(errors, []);
});

test('a slow answer to an earlier search never replaces the current one', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('press1.temperature', { source: 'edge:press-shop-edge' });
  fake.addSignal('oven.temp', { source: 'import:oven.csv' });
  fake.slowSearch('press', 1500);
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.waitForSelector('[data-signal-count]:has-text("2 signal(s)")');
  await page.fill('#signal-search [name=q]', 'press');
  await page.waitForTimeout(400); // the slow search is sent
  await page.fill('#signal-search [name=q]', 'oven');
  await page.waitForSelector('[data-signal-count]:has-text("1 signal(s)")');
  await page.waitForTimeout(1600); // the slow answer arrives, and is dropped
  assert.match(await page.locator('[data-signal-results] tbody').innerText(), /oven\.temp/);
  assert.doesNotMatch(await page.locator('[data-signal-results] tbody').innerText(), /press1/);
  assert.deepEqual(errors, []);
});

test('quality badges: check the signals listed, read a report, filter by badge', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('press1.temperature', { source: 'edge:press-shop-edge', unit: '°C' });
  fake.addSignal('press1.force', { source: 'edge:press-shop-edge' });
  fake.qualityWillBe('press1.force', {
    badge: 'bad',
    issues: [{ check: 'silent', severity: 'bad', message: 'No reading for 2.5 h; the edge agent may be down' }],
  });
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.waitForSelector('[data-signal-count]:has-text("2 signal(s)")');
  assert.equal(await page.locator('[data-signal-results] .badge:has-text("Not checked")').count(), 2);

  await page.click('[data-check-quality]');
  await page.waitForSelector('#toast:has-text("Checked 2 signal(s): 1 good, 0 with warnings, 1 with problems")');
  await page.waitForSelector('[data-signal-results] .badge.bad:has-text("Problems")');
  await page.locator('tr', { hasText: 'press1.force' }).first().locator('[data-quality]').click();
  await page.waitForSelector('.quality-row:has-text("No reading for 2.5 h")');

  await page.selectOption('#signal-search [name=quality]', 'good');
  await page.waitForSelector('[data-signal-count]:has-text("1 signal(s)")');
  assert.match(await page.locator('[data-signal-results] tbody').innerText(), /press1\.temperature/);

  // The expected range is set in the edit form.
  await page.selectOption('#signal-search [name=quality]', '');
  await page.waitForSelector('[data-signal-count]:has-text("2 signal(s)")');
  await page.locator('tr', { hasText: 'press1.temperature' }).first().locator('[data-edit]').click();
  await page.fill('#signal-form [name=min]', '5');
  await page.fill('#signal-form [name=max]', '5');
  await page.click('#signal-form button[type=submit]');
  // Said under the field to change (U2.07), not in a toast.
  await page.waitForSelector(
    '#signal-form .field-error:has-text("The expected range\'s maximum must be above its minimum.")',
  );
  assert.equal(await page.getAttribute('#signal-form [name=max]', 'aria-invalid'), 'true');
  await page.fill('#signal-form [name=max]', '250');
  await page.click('#signal-form button[type=submit]');
  await page.waitForSelector('#toast:has-text("Saved press1.temperature")');
  assert.deepEqual(errors, []);
});

test('a quality check still shows as running after leaving the page and coming back', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('oven.temp');
  fake.slowCheck(1200);
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.waitForSelector('[data-signal-count]:has-text("1 signal(s)")');
  await page.click('[data-check-quality]');
  await page.evaluate(() => (location.hash = '#/import'));
  await page.evaluate(() => (location.hash = '#/signals'));
  await page.waitForSelector('[data-check-quality][aria-busy=true]');
  assert.equal(await page.locator('[data-check-quality]').isDisabled(), true);
  await page.waitForSelector('#toast:has-text("Checked 1 signal(s)")');
  await page.waitForSelector('[data-check-quality]:not([aria-busy]):not([disabled])');
  assert.equal(await page.locator('[data-check-quality]').isDisabled(), false);
  assert.deepEqual(errors, []);
});

test('the data explorer: plot signals, zoom in by dragging, zoom out into buckets', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const temp = fake.addSignal('press1.temperature', { source: 'edge:press-shop-edge', unit: '°C' });
  fake.addSignal('oven.temp', { source: 'import:oven.csv', unit: '°C' });
  // Four days of readings every five minutes, ending 2026-09-05 06:00 UTC.
  const end = Date.parse('2026-09-05T06:00:00Z');
  for (let i = 0; i < 1152; i++) {
    const at = new Date(end - i * 300_000).toISOString().replace('Z', '000Z');
    fake.samples.set(`press1.temperature|${at}`, 20 + (i % 12));
  }
  fake.samples.set('oven.temp|2026-09-05T05:00:00.000000Z', 180);
  temp.last_at = new Date(end).toISOString();
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  // The Signals page links each tag to the explorer.
  await page.click('[data-signal-results] a:has-text("press1.temperature")');
  await page.waitForSelector('[data-series-note]:has-text("288 reading(s)")'); // the day up to the latest
  assert.match(await page.locator('[data-charts] svg').first().innerHTML(), /<path d="M/);

  // Drag across the middle half of the chart: about half a day.
  const box = await page.locator('[data-zoom] svg').first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const note = document.querySelector('[data-series-note]')?.textContent ?? '';
    const n = Number(note.replace(/[^0-9]/g, ''));
    return /reading\(s\)/.test(note) && n > 80 && n < 200;
  });

  // More readings than the chart's points: the API averages them.
  await page.click('[data-preset="data"]');
  await page.waitForSelector('[data-series-note]:has-text("288 reading(s)")');
  for (let i = 0; i < 3; i++) await page.click('[data-zoom-out]'); // eight days, around the same middle
  await page.waitForSelector('[data-series-note]:has-text("1,152 readings, as")');
  assert.match(await page.locator('[data-zoom] svg').first().innerHTML(), /fill-opacity/);

  // Add a second signal from the search, then remove it.
  await page.fill('#explorer-search [name=q]', 'oven');
  await page.click('[data-explorer-found] [data-add]');
  await page.waitForSelector('[data-picked] .badge:has-text("oven.temp")');
  assert.equal(await page.locator('[data-charts] > .card').count(), 2);
  await page.click('[data-remove]:right-of(:text("oven.temp"))');
  await page.waitForFunction(() => document.querySelectorAll('[data-charts] > .card').length === 1);
  assert.deepEqual(errors, []);
});

test('on a wide screen, drag-zoom keeps the stretch dragged, and search text survives adding', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const temp = fake.addSignal('press1.temperature', { unit: '°C' });
  fake.addSignal('press1.force');
  const end = Date.parse('2026-09-05T06:00:00Z');
  for (let i = 0; i < 288; i++)
    fake.samples.set(`press1.temperature|${new Date(end - i * 300_000).toISOString()}`, 20 + (i % 12));
  temp.last_at = new Date(end).toISOString();
  const { page, errors } = await openPage({ viewport: { width: 2400, height: 1000 } });
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/explorer`);
  await page.fill('#explorer-search [name=q]', 'press1');
  await page.click('[data-explorer-found] [data-add]:has-text("press1.temperature")');
  await page.waitForSelector('[data-series-note]:has-text("288 reading(s)")');
  assert.equal(await page.inputValue('#explorer-search [name=q]'), 'press1'); // still there to add the next
  // Drag over the second fifth of the chart: about a fifth of the day.
  const box = await page.locator('[data-zoom] svg').first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const note = document.querySelector('[data-series-note]')?.textContent ?? '';
    const n = Number(note.replace(/[^0-9]/g, ''));
    return /reading\(s\)/.test(note) && n > 30 && n < 90;
  });
  assert.deepEqual(errors, []);
});

test('mapping suggestions: stage a new node, commit it, then link its tag', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.commitAs(
    'maria',
    [
      {
        kind: 'addNode',
        node: { id: 'sig-oven', type: 'Signal', label: 'Oven temperature', props: { unit: '°C', tag: 'oven.temp' } },
      },
    ],
    'add oven signal',
  );
  fake.addSignal('oven.temp', { unit: '°C' });
  fake.addSignal('press1.temperature', { unit: '°C' });
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.click('[data-suggest]');
  await page.waitForSelector('[data-suggestion]:has-text("press1.temperature") .badge:has-text("New node")');
  // Link the tag whose node exists.
  await page.locator('[data-suggestion]', { hasText: 'oven.temp' }).locator('[data-accept]').click();
  await page.waitForSelector('#toast:has-text("Linked oven.temp")');
  await page.waitForSelector('[data-signal-results] a:has-text("Oven temperature")');
  // Stage the new node for the other; it waits on the Ontology page to be committed.
  await page.locator('[data-suggestion]', { hasText: 'press1.temperature' }).locator('[data-accept]').click();
  await page.waitForSelector('#toast:has-text("Staged press1.temperature")');
  assert.equal(await page.locator('[data-suggestion]').count(), 0);
  // Suggesting again doesn't offer it twice: it waits for the commit.
  await page.click('[data-suggest]');
  await page.waitForSelector(
    '[data-mapping-results]:has-text("Your staged change adds a node for press1.temperature")',
  );
  assert.equal(await page.locator('[data-suggestion]').count(), 0);
  await page.evaluate(() => (location.hash = '#/ontology'));
  await page.waitForSelector('#commit-form:has-text("1 uncommitted")');
  await page.fill('#commit-form [name=message]', 'add press1.temperature');
  await page.click('#commit-form button[type=submit]');
  await page.waitForSelector('#toast:has-text("Committed")');
  // Back on Signals, the tag now links to its node in one step.
  await page.evaluate(() => (location.hash = '#/signals'));
  await page.click('[data-suggest]');
  await page.waitForSelector('[data-suggestion]:has-text("press1.temperature") .badge:has-text("Link to")');
  await page.locator('[data-suggestion]').locator('[data-accept]').click();
  await page.waitForSelector('#toast:has-text("Linked press1.temperature")');
  assert.deepEqual(errors, []);
});

test('viewers browse the signal catalogue but cannot edit it', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addSignal('press1.temperature', { source: 'edge:press-shop-edge', unit: '°C' });
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.waitForSelector('[data-signal-count]:has-text("1 signal(s)")');
  assert.equal(await page.locator('[data-edit]').count(), 0);
  assert.equal(await page.locator('[data-check-quality]').count(), 0);
  assert.deepEqual(errors, []);
});

test('background updates never wipe what the user is typing', async (t) => {
  const fake = createFakeApi({ slowAuthConfigMs: 1500 });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/settings`);
  await page.waitForSelector('#account:has-text("Checking")');
  // Edit the form while the sign-in settings are still loading...
  await page.fill('#datasource [name=apiUrl]', 'http://typed.example:9000');
  await page.check('#datasource [name=mode][value=local]');
  await page.focus('#datasource [name=apiUrl]');
  // ...then the answer arrives and the page re-renders around the edits.
  await page.waitForSelector('#account:has-text("development user")');
  assert.equal(await page.inputValue('#datasource [name=apiUrl]'), 'http://typed.example:9000');
  assert.equal(await page.locator('#datasource [name=mode][value=local]').isChecked(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'apiUrl');
  assert.deepEqual(errors, []);
});

// Opens Tiles on the fake API as `email` (the development user when not given), on `route`.
async function openAs(t, apiUrl, email, route) {
  const { page, errors } = await openPage();
  t.after(() => page.close());
  if (email) {
    await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/settings`);
    // Settled: signed in and the site loaded (each re-renders the page, which would put the old email
    // back mid-typing, and this would quietly stay the default engineer).
    await page.waitForSelector('#account:has-text("development user")');
    await page.waitForSelector('#notifications');
    await page.fill('#profile [name=email]', email);
    await page.click('#profile button[type=submit]');
    await page.waitForSelector('#toast:has-text("Profile saved")');
    await page.waitForSelector(`#user:has-text("${email}")`);
    await page.evaluate((r) => (location.hash = r), `#/${route}`);
  } else await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/${route}`);
  return { page, errors };
}

test('change reviews: request a review, reject it, rework it, approve it', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.commitAs(
    'maria',
    [{ kind: 'addNode', node: { id: 'line-1', type: 'Line', label: 'Line 1', props: {} } }],
    'add line 1',
  );
  const b = await openAs(t, apiUrl, 'eng2@example.com', 'reviews'); // a member, so A can ask them
  await b.page.waitForSelector('[data-review-list]:has-text("Nothing waits for a review")');
  fake.requireReview();

  const a = await openAs(t, apiUrl, null, 'ontology');
  await a.page.waitForSelector('.source-bar:has-text("Every change needs a review")');
  await a.page.fill('#node-form [name=label]', 'Alarm stream DC-02');
  await a.page.selectOption('#node-form [name=type]', 'Signal');
  await a.page.selectOption('#node-form [name=from]', 'line-1');
  await a.page.click('#node-form button');
  await a.page.waitForSelector('#commit-form');
  // The site requires a review: there is no Commit, only Request review.
  assert.equal(await a.page.locator('#commit-form [value=commit]').count(), 0);
  await a.page.fill('#commit-form [name=message]', 'add alarms node');
  await a.page.selectOption('#commit-form [name=reviewer]', 'eng2@example.com');
  await a.page.press('#commit-form [name=message]', 'Enter');
  await a.page.waitForSelector('#toast:has-text("Sent for review")');
  assert.equal(await a.page.locator('#commit-form').count(), 0);

  // B reads the diff and rejects it, saying why.
  await b.page.click('[data-state=closed]');
  await b.page.click('[data-state=open]');
  await b.page.click('[data-review="1"]');
  await b.page.waitForSelector('[data-review-detail]:has-text("#1 add alarms node")');
  const diff = await b.page.locator('.review-diff').innerText();
  assert.match(diff, /\+ Signal “Alarm stream DC-02”/);
  assert.match(diff, /\+ Line 1 —contains→ Alarm stream DC-02/);
  await b.page.click('[data-act=reject]');
  await b.page.waitForSelector('#toast:has-text("Say why you reject it")');
  await b.page.fill('#review-form textarea', 'Call it Alarms DC-02');
  await b.page.click('[data-act=reject]');
  await b.page.waitForSelector('#toast:has-text("#1 rejected")');
  await b.page.waitForSelector('[data-review-detail] .comment:has-text("Call it Alarms DC-02")');

  // A takes it back into their staged changes, fixes it and sends it again.
  await a.page.evaluate(() => (location.hash = '#/reviews'));
  await a.page.click('[data-state=closed]');
  await a.page.click('[data-review="1"]');
  await a.page.waitForSelector('[data-review-detail]:has-text("Call it Alarms DC-02")');
  assert.equal(await a.page.locator('[data-act=approve]').count(), 0); // not your own
  await a.page.click('[data-act=rework]');
  await a.page.waitForSelector('#commit-form:has-text("2 uncommitted")');
  await a.page.click('[data-node="signal-alarm-stream-dc-02"]');
  await a.page.fill('#prop-form [name=key]', 'name');
  await a.page.fill('#prop-form [name=value]', 'Alarms DC-02');
  await a.page.click('#prop-form button');
  await a.page.waitForSelector('#commit-form:has-text("3 uncommitted")');
  await a.page.fill('#commit-form [name=message]', 'add alarms node, named');
  await a.page.click('[data-request-review]');
  await a.page.waitForSelector('#toast:has-text("Sent for review")');

  // B approves it: it is committed, with A as author and B as reviewer.
  await b.page.click('[data-state=closed]');
  await b.page.click('[data-state=open]');
  await b.page.click('[data-review="2"]');
  await b.page.waitForSelector('[data-review-detail]:has-text("#2 add alarms node, named")');
  assert.match(await b.page.locator('.review-diff').innerText(), /\+ Alarm stream DC-02 · name = “Alarms DC-02”/);
  await b.page.fill('#review-form textarea', 'Good');
  await b.page.click('[data-act=approve]');
  await b.page.waitForSelector('#toast:has-text("#2 approved and committed")');
  await b.page.click('[data-history]');
  await b.page.waitForSelector('.commit:has-text("add alarms node, named")');
  assert.match(await b.page.locator('.commit').first().innerText(), /demo · approved by eng2/);
  // Reverting it goes through a review too.
  assert.equal(await b.page.locator('[data-revert]').first().innerText(), 'Request revert');
  await b.page.locator('[data-revert]').first().click();
  await b.page.waitForSelector('#toast:has-text("Revert sent for review")');

  assert.deepEqual([...a.errors, ...b.errors], []);
});

test('site admins require reviews; then nobody commits directly', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'admin' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.stageAs('demo@example.com', [{ kind: 'addNode', node: { id: 'm', type: 'Machine', label: 'M', props: {} } }]);
  const { page, errors } = await openAs(t, apiUrl, null, 'reviews');
  await page.check('[data-policy]');
  await page.waitForSelector('#toast:has-text("Every change now needs a review")');
  await page.evaluate(() => (location.hash = '#/ontology'));
  await page.waitForSelector('#commit-form');
  assert.equal(await page.locator('#commit-form [value=commit]').count(), 0);
  await page.evaluate(() => (location.hash = '#/reviews'));
  await page.uncheck('[data-policy]');
  await page.waitForSelector('#toast:has-text("Reviews are optional again")');
  await page.evaluate(() => (location.hash = '#/ontology'));
  await page.waitForSelector('#commit-form [value=commit]');
  assert.deepEqual(errors, []);
});

test('in local mode the reviews page explains that reviews need the Tiles API', async (t) => {
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}#/reviews`);
  await page.waitForSelector('#view:has-text("they need the Tiles API")');
  assert.deepEqual(errors, []);
});

test("coming back to change reviews shows others' new requests; a revert request is withdrawn, not staged", async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.commitAs(
    'maria',
    [{ kind: 'addNode', node: { id: 'line-1', type: 'Line', label: 'Line 1', props: {} } }],
    'add line 1',
  );
  const { page, errors } = await openAs(t, apiUrl, null, 'reviews');
  await page.waitForSelector('[data-review-list]:has-text("Nothing waits for a review")');
  await page.evaluate(() => (location.hash = '#/ontology'));
  await page.waitForSelector('.source-bar');
  fake.requestReviewAs(
    'maria@example.com',
    [{ kind: 'addNode', node: { id: 'm', type: 'Machine', label: 'Press 2', props: {} } }],
    'add press 2',
  );
  await page.evaluate(() => (location.hash = '#/reviews'));
  await page.waitForSelector('[data-review="1"]:has-text("add press 2")');

  // Ask to revert a commit, then think better of it.
  await page.evaluate(() => (location.hash = '#/ontology'));
  await page.click('[data-tab=history]');
  fake.requireReview();
  await page.click('[data-refresh]');
  await page.waitForSelector('[data-revert]:has-text("Request revert")');
  await page.locator('[data-revert]').first().click();
  await page.waitForSelector('#toast:has-text("Revert sent for review")');
  await page.evaluate(() => (location.hash = '#/reviews'));
  await page.click('[data-review="2"]');
  await page.waitForSelector('[data-review-detail]:has-text(\'#2 Revert "add line 1"\')');
  await page.click('[data-act=rework]:has-text("Withdraw")');
  await page.waitForSelector('#toast:has-text("#2 withdrawn")');
  await page.evaluate(() => (location.hash = '#/ontology'));
  await page.waitForSelector('.source-bar');
  assert.equal(await page.locator('#commit-form').count(), 0); // nothing staged
  assert.deepEqual(errors, []);
});

test('ontology export as JSON and CSV, and import of a file as staged changes', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.commitAs(
    'maria',
    [
      { kind: 'addNode', node: { id: 'line-1', type: 'Line', label: 'Line 1', props: {} } },
      { kind: 'addNode', node: { id: 'old', type: 'Document', label: 'Old manual', props: {} } },
    ],
    'add line 1',
  );
  const { page, errors } = await openAs(t, apiUrl, null, 'ontology');
  await page.waitForSelector('[data-export=json]');
  const saved = async (format) => {
    const [file] = await Promise.all([page.waitForEvent('download'), page.click(`[data-export=${format}]`)]);
    assert.equal(file.suggestedFilename(), `plant-1-ontology.${format}`);
    const chunks = [];
    for await (const chunk of await file.createReadStream()) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  };
  const json = JSON.parse(await saved('json'));
  assert.deepEqual(
    json.nodes.map((n) => n.id),
    ['line-1', 'old'],
  );
  assert.match(await saved('csv'), /^kind,id,type,label,from,rel,to\nnode,line-1,Line,Line 1,,,\n/);

  // Import a file: a new machine on line 1 and a property on the line.
  const file = {
    nodes: [
      { id: 'line-1', type: 'Line', label: 'Line 1', props: { shift: 'A' } },
      { id: 'press-2', type: 'Machine', label: 'Press 2', props: { vendor: 'Acme' } },
    ],
    edges: [{ id: 'line-1-contains-press-2', from: 'line-1', rel: 'contains', to: 'press-2' }],
  };
  const upload = (name, content) =>
    page.setInputFiles('[data-import-file]', { name, mimeType: 'application/json', buffer: Buffer.from(content) });
  await upload('plant.json', JSON.stringify(file));
  await page.waitForSelector('[data-import-summary]');
  assert.equal(
    await page.locator('[data-import-summary]').innerText(),
    '1 new node, 1 property set, 1 new relationship.',
  );
  assert.match(await page.locator('#import-card .review-diff').innerText(), /\+ Machine “Press 2”/);
  // Replace would also remove what the file doesn't have.
  await page.selectOption('[data-import-mode]', 'replace');
  await page.waitForSelector('[data-import-summary]:has-text("1 node removed")');
  await page.selectOption('[data-import-mode]', 'merge');
  await page.waitForSelector('[data-import-summary]:not(:has-text("removed"))');
  // Someone commits after the preview: staging is refused and the preview shows the new plan.
  fake.commitAs('maria', [{ kind: 'setProp', id: 'line-1', key: 'shift', value: 'A' }], 'shift A');
  await page.click('[data-import-stage]');
  await page.waitForSelector('#toast:has-text("changed since the preview")');
  await page.waitForSelector('[data-import-summary]:has-text("1 new node, 1 new relationship.")');
  await page.click('[data-import-stage]');
  await page.waitForSelector('#toast:has-text("Staged the changes from plant.json")');
  await page.waitForSelector('#commit-form:has-text("2 uncommitted")');
  assert.equal(await page.locator('#import-card').count(), 0);
  assert.equal(await page.locator('[data-import-file]').isDisabled(), true); // staged changes first

  // A file that can't be imported says why, and nothing is staged.
  await page.click('[data-discard]');
  await page.waitForSelector('#toast:has-text("Changes discarded")');
  await upload('bad.json', JSON.stringify({ nodes: [{ id: 'line-1', type: 'Line', label: 'Line One' }] }));
  await page.waitForSelector('#toast:has-text("rename it by hand")');
  assert.equal(await page.locator('#import-card').count(), 0);
  assert.deepEqual(
    errors.filter((e) => !/status of (409|422)/.test(e)), // the browser logs the refused imports
    [],
  );
});

test('a 2,000-node ontology: folded, zoomed, panned and searched on the canvas', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.commitAs('maria', largePlantOps(), 'import the big plant');
  const { page, errors } = await openPage({ viewport: { width: 1600, height: 1000 } });
  t.after(() => page.close());
  const started = Date.now();
  await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/ontology`);
  // Large ontologies open with each PLC's signals folded into it.
  await page.waitForSelector('.statusbar:has-text("Nodes: 2069 (277 shown)")');
  assert.ok(Date.now() - started < 8000, `opened in ${Date.now() - started} ms`);
  assert.equal(await page.locator('[data-fold-level]').inputValue(), 'PLC');
  assert.equal(await page.locator('[data-node="wc1-line1-m1-plc"] .fold').textContent(), '+14');
  const viewBox = async () => (await page.getAttribute('svg[data-canvas]', 'viewBox')).split(' ').map(Number);

  // Wheel zooms in where the pointer is; dragging moves the view and selects nothing.
  const box = await page.locator('svg[data-canvas]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await viewBox();
  await page.mouse.wheel(0, -600);
  const zoomed = await viewBox();
  assert.ok(zoomed[2] < before[2] / 2, `zoomed in: ${before} → ${zoomed}`);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2 - 100, { steps: 5 });
  await page.mouse.up();
  const panned = await viewBox();
  assert.ok(panned[0] > zoomed[0] && panned[1] > zoomed[1], `panned: ${zoomed} → ${panned}`);
  assert.ok(Math.abs(panned[2] - zoomed[2]) < 0.01, 'panning keeps the zoom'); // view boxes are 32-bit floats
  assert.equal(await page.locator('#inspector [data-deselect]').count(), 0); // no node selected

  // Zoomed in, opening a PLC keeps it in view, though every PLC moves (columns get a row longer).
  const inView = async (id) => {
    const node = await page.locator(`[data-node="${id}"]`).boundingBox();
    const area = await page.locator('svg[data-canvas]').boundingBox();
    const [cx, cy] = [node.x + node.width / 2, node.y + node.height / 2]; // its centre is on screen
    return cx >= area.x && cx <= area.x + area.width && cy >= area.y && cy <= area.y + area.height;
  };
  await page.click('[data-zoom=fit]');
  const plc = await page.locator('[data-node="wc4-line4-m8-plc"]').boundingBox();
  await page.mouse.move(plc.x + plc.width / 2, plc.y + plc.height / 2);
  await page.mouse.wheel(0, -900);
  assert.ok(await inView('wc4-line4-m8-plc'));
  await page.dblclick('[data-node="wc4-line4-m8-plc"]');
  await page.waitForSelector('.statusbar:has-text("(291 shown)")');
  assert.ok(await inView('wc4-line4-m8-plc'), 'the opened PLC is still in view');

  // Search reaches a folded signal: its PLC opens, it is selected and brought into view.
  await page.fill('[data-onto-search]', 'signal 2.3.4.5');
  await page.waitForSelector('[data-search-count]:has-text("found (")'); // folded away so far
  await page.press('[data-onto-search]', 'Enter');
  await page.waitForSelector('#inspector h2:has-text("Signal 2.3.4.5")');
  await page.waitForSelector('[data-node="wc2-line3-m4-plc-s5"].sel.match');
  const centred = await viewBox();
  assert.ok(centred[2] <= 1400);
  assert.equal(await page.locator('[data-onto-search]').evaluate((el) => el === document.activeElement), true);
  await page.waitForSelector('.statusbar:has-text("(305 shown)")'); // that PLC's 14 signals opened too

  // Fold levels, and double-click to open one node.
  await page.selectOption('[data-fold-level]', 'Line');
  await page.waitForSelector('.statusbar:has-text("(21 shown)")');
  // The badge counts all a line holds: 8 machines, their PLCs and 112 signals.
  assert.equal(await page.locator('[data-node="wc1-line1"] .fold').textContent(), '+128');
  await page.dblclick('[data-node="wc1-line1"]');
  // Only the line was folded: its 8 machines, their PLCs and the PLCs' 112 signals show.
  await page.waitForSelector('.statusbar:has-text("(149 shown)")');
  await page.selectOption('[data-fold-level]', '');
  await page.waitForSelector('.statusbar:has-text("Nodes: 2069")');
  assert.equal(await page.locator('.statusbar:has-text("shown")').count(), 0);
  assert.equal(await page.locator('svg[data-canvas] [data-node]').count(), 2069);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
  assert.deepEqual(errors, []);
});

// A friction signal that climbs out of its band an hour ago, and a second warning that is over.
function raiseFrictionWarnings(fake) {
  const now = Date.now();
  const minute = 60_000;
  const at = (m) => new Date(now - m * minute).toISOString();
  const readings = Array.from({ length: 240 }, (_, i) => {
    const m = 240 - i; // minutes ago
    return { at: at(m), value: m > 60 ? 1800 + 30 * Math.sin(i) : 2400 + (60 - m) * 20 };
  });
  const out = fake.raiseWarning('dc1.friction', readings, {
    started_at: at(57),
    last_at: at(1),
    peak: 3580,
    baseline: 1800,
    threshold: 2200,
    readings: 57,
  });
  const over = fake.raiseWarning('dc2.friction', [], {
    started_at: at(600),
    last_at: at(590),
    ended_at: at(589),
    peak: 2600,
    baseline: 1800,
    threshold: 2300,
    readings: 11,
  });
  return { out, over };
}

test('the warnings inbox: see a warning on its signal, acknowledge, assign, resolve and reopen it', async (t) => {
  const fake = createFakeApi({ roles: { 'viewer@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { out } = raiseFrictionWarnings(fake);
  const b = await openAs(t, apiUrl, 'eng2@example.com', 'warnings'); // a member, so A can assign them

  const a = await openAs(t, apiUrl, null, 'warnings');
  await a.page.waitForSelector('[data-warning-list] [data-warning]');
  assert.equal(await a.page.locator('[data-warning-list] [data-warning]').count(), 2);
  await a.page.click(`[data-warning="${out}"]`);
  await a.page.waitForSelector('[data-warning-detail] .chart .span');
  const detail = a.page.locator('[data-warning-detail]');
  assert.match(await detail.innerText(), /Signal still out/);
  assert.match(await detail.locator('[data-how-far]').innerText(), /Peak 3,580, above the threshold of 2,200/);
  assert.equal(await detail.locator('.chart .level').count(), 2); // threshold and baseline
  assert.match(await detail.locator('.thread').innerText(), /Raised by the detector/);

  // A comment needs words; acknowledging doesn't.
  await a.page.click('[data-act=comment]');
  await a.page.waitForSelector('#toast:has-text("Write the comment first")');
  await a.page.click('[data-act=acknowledge]');
  await a.page.waitForSelector('#toast:has-text("Acknowledged")');
  await a.page.waitForSelector('[data-warning-detail] .badge:has-text("Acknowledged")');
  assert.equal(await a.page.locator('[data-act=acknowledge]').count(), 0);

  // Assigned to eng2, who finds it under "assigned to me".
  await a.page.selectOption('#warning-form [name=assignee]', 'eng2@example.com');
  await a.page.fill('#warning-form textarea', 'Your line today');
  await a.page.click('[data-act=assign]');
  await a.page.waitForSelector('#toast:has-text("Assigned to eng2")');
  await a.page.waitForSelector('[data-warning-detail] .thread:has-text("demo assigned it to eng2")');
  await b.page.selectOption('[data-filter=who]', 'me');
  await b.page.waitForSelector(`[data-warning-list] [data-warning="${out}"]`);
  assert.equal(await b.page.locator('[data-warning-list] [data-warning]').count(), 1);

  // eng2 resolves it as a true alarm: it leaves "To do", and is under "Resolved".
  await b.page.click(`[data-warning="${out}"]`);
  await b.page.waitForSelector('#warning-form [name=outcome]');
  await b.page.selectOption('#warning-form [name=outcome]', 'true_alarm');
  await b.page.fill('#warning-form textarea', 'Plunger seized; tip replaced');
  await b.page.click('[data-act=resolve]');
  await b.page.waitForSelector('#toast:has-text("Resolved as true alarm")');
  await b.page.waitForSelector('[data-warning-detail]:has-text("True alarm, resolved by eng2")');
  await b.page.waitForSelector('[data-warning-list] .empty:has-text("No warnings match these filters")');
  assert.equal(await b.page.locator('[data-warning-list] [data-clear-filters]').count(), 1);
  await b.page.click('[data-show=resolved]');
  await b.page.waitForSelector(`[data-warning-list] [data-warning="${out}"]:has-text("True alarm")`);

  // Reopened, it is acknowledged again, and back in "To do".
  await b.page.click('[data-act=reopen]');
  await b.page.waitForSelector('#toast:has-text("Reopened")');
  await b.page.click('[data-show=unresolved]');
  await b.page.waitForSelector(`[data-warning-list] [data-warning="${out}"]:has-text("For eng2")`);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test('viewers read warnings but cannot act on them; local mode explains the API is needed', async (t) => {
  const fake = createFakeApi({ roles: { 'viewer@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { over } = raiseFrictionWarnings(fake);
  const v = await openAs(t, apiUrl, 'viewer@example.com', 'warnings');
  await v.page.click(`[data-warning="${over}"]`);
  await v.page.waitForSelector('[data-warning-detail]:has-text("Engineers and admins of the site act on warnings")');
  assert.equal(await v.page.locator('#warning-form').count(), 0);
  // The signal came back: no "still out" badge, and the filter for signals still out leaves it out.
  assert.doesNotMatch(await v.page.locator('[data-warning-detail]').innerText(), /Signal still out/);
  await v.page.selectOption('[data-filter=signal]', 'open');
  await v.page.waitForSelector(`[data-warning-list] [data-warning]:not([data-warning="${over}"])`);
  assert.equal(await v.page.locator(`[data-warning-list] [data-warning="${over}"]`).count(), 0);

  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}#/warnings`);
  await page.waitForSelector('#view:has-text("Warnings come from detectors running on the Tiles API")');
  assert.deepEqual([...v.errors, ...errors], []);
});

test('the shopfloor view: warnings first on their machines, taken and resolved with big buttons', async (t) => {
  const fake = createFakeApi({ roles: { 'viewer@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const node = (id, type, label, props = {}) => ({ kind: 'addNode', node: { id, type, label, props } });
  const edge = (from, rel, to) => ({ kind: 'addEdge', edge: { id: `${from}-${rel}-${to}`, from, rel, to } });
  fake.commitAs(
    'maria',
    [
      node('wc-cast', 'Workcenter', 'Casting'),
      node('ln-dc', 'Line', 'DC line 1'),
      node('m-dc1', 'Machine', 'Die-caster DC-01'),
      node('m-dc2', 'Machine', 'Die-caster DC-02'),
      node('plc-dc1', 'PLC', 'PLC DC-01', { protocol: 'OPC UA' }),
      node('sig-fr', 'Signal', 'Plunger friction', { unit: 'N', tag: 'dc1.friction' }),
      edge('wc-cast', 'contains', 'ln-dc'),
      edge('ln-dc', 'contains', 'm-dc1'),
      edge('ln-dc', 'contains', 'm-dc2'),
      edge('m-dc1', 'controlledBy', 'plc-dc1'),
      edge('plc-dc1', 'emits', 'sig-fr'),
    ],
    'the casting line',
  );
  const { out, over } = raiseFrictionWarnings(fake);

  const { page, errors } = await openAs(t, apiUrl, null, 'shopfloor');
  await page.setViewportSize({ width: 768, height: 1024 }); // a tablet, upright
  const headline = page.locator('.floor-headline');
  await page.waitForSelector('.floor-headline:has-text("2 open warnings: 1 signal still out, 2 nobody has taken")');
  // Still out first, on its machine; the other is named by its tag, which the ontology doesn't place.
  const cards = page.locator('.floor-card');
  await page.waitForSelector('.floor-card:first-child:has-text("Casting › DC line 1")');
  assert.match(await cards.nth(0).innerText(), /Die-caster DC-01[\s\S]*dc1\.friction[\s\S]*Signal still out/);
  assert.match(await cards.nth(1).innerText(), /dc2\.friction[\s\S]*Nobody has it/);
  // Gloves: every button is at least 64 px each way (measured once the page has settled).
  await page.waitForFunction(() => !document.querySelector('#view').classList.contains('view-enter'));
  for (const box of await page.locator('.floor-btn').evaluateAll((els) => els.map((e) => e.getBoundingClientRect())))
    assert.ok(box.height >= 64 && box.width >= 64, `a ${box.width}×${box.height} button`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);

  // Taken: acknowledged and assigned to whoever pressed it.
  await page.click(`[data-take="${out}"]`);
  await page.waitForSelector('#toast:has-text("It\'s yours: dc1.friction")');
  await page.waitForSelector('.floor-card:first-child:has-text("demo has it")');
  assert.equal(await page.locator(`[data-take="${out}"]`).count(), 0);
  await page.waitForSelector('.floor-headline:has-text("2 open warnings: 1 signal still out, 1 nobody has taken")');

  // Resolved with what it was: it leaves the floor.
  await page.click(`[data-resolve="${over}"]`);
  await page.waitForSelector('.floor-ask:has-text("What was it?")');
  await page.click(`[data-outcome=false_alarm][data-id="${over}"]`);
  await page.waitForSelector('#toast:has-text("Resolved as false alarm")');
  await page.waitForSelector('.floor-headline:has-text("1 open warning: 1 signal still out")');
  assert.equal(await cards.count(), 1);
  assert.match(await headline.getAttribute('class'), /bad/);

  // A colleague's warning: taking it from them asks first.
  const theirs = fake.raiseWarning('dc1.pressure', [], {
    started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    last_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    ended_at: new Date(Date.now() - 3 * 60_000).toISOString(),
    peak: 300,
    baseline: 200,
    threshold: 250,
    readings: 3,
    acknowledged_at: new Date().toISOString(),
    acknowledged_by: 'eng2@example.com',
    assignee_id: 'eng2@example.com',
  });
  await page.click('[data-floor-refresh]');
  await page.click(`[data-ask-take="${theirs}"]`);
  await page.waitForSelector('.floor-ask:has-text("Take it from eng2?")');
  await page.click('[data-cancel]');
  await page.waitForSelector(`.floor-card:has([data-ask-take="${theirs}"]):has-text("eng2 has it")`);
  await page.click(`[data-ask-take="${theirs}"]`);
  await page.click(`[data-take="${theirs}"]`);
  await page.waitForSelector('#toast:has-text("It\'s yours: dc1.pressure")');
  await page.waitForSelector(`.floor-card:has([data-resolve="${theirs}"]):has-text("demo has it")`);

  // A question about a warning someone else resolves meanwhile goes with it.
  await page.click(`[data-resolve="${theirs}"]`);
  await page.waitForSelector('.floor-ask:has-text("What was it?")');
  const b = await openAs(t, apiUrl, 'eng2@example.com', 'warnings');
  await b.page.click(`[data-warning="${theirs}"]`);
  await b.page.selectOption('#warning-form [name=outcome]', 'unknown');
  await b.page.click('[data-act=resolve]');
  await b.page.waitForSelector('#toast:has-text("Resolved as unknown")');
  await page.click('[data-floor-refresh]');
  await page.waitForSelector('.floor-headline:has-text("1 open warning: 1 signal still out")');
  assert.equal(await page.locator('.floor-ask').count(), 0);
  assert.deepEqual(b.errors, []);

  // The machines: DC-01 has its warning, DC-02 is fine.
  await page.waitForSelector('.floor-tile.s-out:has-text("Die-caster DC-01")');
  assert.notEqual(
    await page.$eval('.floor-tile.s-out', (el) => getComputedStyle(el).borderLeftColor),
    await page.$eval('.floor-tile.s-ok', (el) => getComputedStyle(el).borderLeftColor),
  );
  await page.waitForSelector('.floor-tile.s-ok:has-text("Die-caster DC-02")');

  // Full view hides the navigation, and gives it back.
  assert.ok((await page.locator('#sidebar').isVisible()) || (await page.locator('#menu').isVisible()));
  await page.click('[data-floor-full]');
  await page.waitForSelector('body.floor-full');
  assert.equal(await page.locator('.topbar').isVisible(), false);
  await page.click('[data-floor-full]');
  await page.waitForSelector('body:not(.floor-full) .topbar');

  // Details: the Warnings page, open on it.
  await page.click(`[data-open="${out}"]`);
  await page.waitForSelector('[data-warning-detail]:has-text("dc1.friction")');
  assert.deepEqual(errors, []);

  // Viewers see the floor but leave the steps to engineers.
  const v = await openAs(t, apiUrl, 'viewer@example.com', 'shopfloor');
  await v.page.waitForSelector('.floor-card:has-text("An engineer of the site acts on it")');
  assert.equal(await v.page.locator('[data-take], [data-resolve]').count(), 0);
  assert.deepEqual(v.errors, []);
});

test("the shopfloor view in local mode shows the demo detector's warnings, read-only", async (t) => {
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}#/shopfloor`);
  await page.waitForSelector('.floor-headline:has-text("open warning")');
  await page.waitForSelector('.floor-card:has-text("Die-caster DC-02")');
  await page.waitForSelector('.floor-card:has-text("Connect to the Tiles API in Settings")');
  await page.waitForSelector('.floor-tile.s-new:has-text("Die-caster DC-02")');
  await page.waitForSelector('.floor-tile.s-ok:has-text("Notching Cutter C-01")');
  assert.deepEqual(errors, []);
});

test('the plant navigator: drill from the workcenter to a machine, with its warnings and signals', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const node = (id, type, label, props = {}) => ({ kind: 'addNode', node: { id, type, label, props } });
  const edge = (from, rel, to) => ({ kind: 'addEdge', edge: { id: `${from}-${rel}-${to}`, from, rel, to } });
  fake.commitAs(
    'maria',
    [
      node('wc-cast', 'Workcenter', 'Casting'),
      node('ln-dc', 'Line', 'DC line 1'),
      node('m-dc1', 'Machine', 'Die-caster DC-01', { vendor: 'Vendor C' }),
      node('m-dc2', 'Machine', 'Die-caster DC-02'),
      node('plc-dc1', 'PLC', 'PLC DC-01', { protocol: 'OPC UA' }),
      node('sig-fr', 'Signal', 'Plunger friction', { unit: 'N' }),
      node('doc-dc1', 'Document', 'DC-01 manual'),
      edge('wc-cast', 'contains', 'ln-dc'),
      edge('ln-dc', 'contains', 'm-dc1'),
      edge('ln-dc', 'contains', 'm-dc2'),
      edge('m-dc1', 'controlledBy', 'plc-dc1'),
      edge('plc-dc1', 'emits', 'sig-fr'),
      edge('doc-dc1', 'describes', 'm-dc1'),
      edge('m-dc1', 'feeds', 'm-dc2'),
    ],
    'the casting line',
  );
  const { out } = raiseFrictionWarnings(fake);
  // The friction tag is linked to its Signal node in the catalogue, as an engineer would on the Signals page.
  const eng = { 'content-type': 'application/json', 'x-tiles-user': 'eng@example.com' };
  const signals = `${apiUrl}/sites/11111111-1111-1111-1111-111111111111/signals`;
  const [friction] = (await (await fetch(`${signals}?q=dc1.friction`, { headers: eng })).json()).signals;
  const linked = await fetch(`${signals}/${friction.id}`, {
    method: 'PATCH',
    headers: eng,
    body: JSON.stringify({ node_id: 'sig-fr' }),
  });
  assert.equal(linked.status, 200);

  const { page, errors } = await openAs(t, apiUrl, null, 'plant');
  // One place at the top: the page opens on it.
  await page.waitForSelector('.page-head h1:has-text("Casting")');
  await page.waitForSelector('.place-card:has-text("DC line 1"):has-text("1 warning")');
  await page.click('.place-card:has-text("DC line 1")');
  // The breadcrumbs say where: links above, this place current; a reload shows the same.
  const trail = async () =>
    page.$$eval('#crumbs li', (lis) =>
      lis.map(
        (li) =>
          `${li.querySelector('a') ? 'a' : 'b'}:${li.textContent?.trim()}${li.querySelector('[aria-current=page]') ? '*' : ''}`,
      ),
    );
  await page.waitForSelector('#crumbs [aria-current=page]:has-text("DC line 1")');
  assert.deepEqual(await trail(), ['a:Home', 'a:Plant', 'a:Casting', 'b:DC line 1*']);
  assert.match(await page.evaluate(() => location.hash), /^#\/plant\/ln-dc$/);
  await page.reload();
  await page.waitForSelector('#crumbs [aria-current=page]:has-text("DC line 1")');
  assert.deepEqual(await trail(), ['a:Home', 'a:Plant', 'a:Casting', 'b:DC line 1*']);
  await page.waitForSelector('.place-card.s-out:has-text("Die-caster DC-01")');
  await page.waitForSelector('.place-card.s-ok:has-text("Die-caster DC-02")');
  // The state shows as the card's colour, not only in its badge.
  const border = (sel) => page.$eval(sel, (el) => getComputedStyle(el).borderLeftColor);
  const bad = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('i'));
    probe.style.color = 'var(--bad)';
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  assert.equal(await border('.place-card.s-out'), bad);
  assert.notEqual(await border('.place-card.s-ok'), bad);

  // The machine: its warning, its signal with the latest reading and a link to plot it, what it has.
  await page.click('.place-card:has-text("Die-caster DC-01")');
  await page.waitForSelector('.page-head h1:has-text("Die-caster DC-01")');
  await page.waitForSelector('.plant-warning:has-text("dc1.friction")');
  const signalRow = page.locator('tr:has-text("Plunger friction")');
  await page.waitForSelector('tr:has-text("Plunger friction"):has-text("dc1.friction"):has-text("N")');
  assert.match(await signalRow.innerText(), /\d/); // the latest reading
  assert.equal(
    await signalRow.locator('a:has-text("Plot")').getAttribute('href'),
    `#/explorer?signal=${encodeURIComponent(friction.id)}`,
  );
  const sheet = await page.locator('.plant-sheet').innerText();
  for (const text of ['Vendor C', 'PLC DC-01', 'OPC UA', 'DC-01 manual', 'Die-caster DC-02'])
    assert.ok(sheet.includes(text), `${text} missing`);

  // Back up the trail, and on to the next machine through what it feeds.
  await page.click('#crumbs a:has-text("DC line 1")');
  await page.waitForSelector('.place-grid');
  await page.goBack();
  await page.click('.plant-sheet a:has-text("Die-caster DC-02")');
  await page.waitForSelector('.page-head h1:has-text("Die-caster DC-02")');

  // Finding a place: typing carries on while the list renders; Enter goes to the best match.
  await page.click('[data-plant-search] input');
  await page.keyboard.type('dc');
  await page.waitForSelector('[data-plant-results] a:has-text("Die-caster DC-02")');
  await page.keyboard.type('-01');
  assert.equal(await page.inputValue('[data-plant-search] input'), 'dc-01');
  await page.waitForSelector('[data-plant-results]:not(:has-text("Die-caster DC-02"))');
  await page.waitForSelector('[data-plant-results] a:has-text("Die-caster DC-01")');
  await page.press('[data-plant-search] input', 'Enter');
  await page.waitForSelector('.page-head h1:has-text("Die-caster DC-01")');
  assert.equal(await page.locator('[data-plant-results]').count(), 0);
  await page.fill('[data-plant-search] input', 'kiln');
  await page.waitForSelector('[data-plant-results]:has-text("No place is called")');

  // Details: the warning on the Warnings page.
  await page.click(`[data-open-warning="${out}"]`);
  await page.waitForSelector('[data-warning-detail]:has-text("dc1.friction")');

  // A link to a place the ontology no longer has.
  await page.evaluate(() => (location.hash = '#/plant/gone'));
  await page.waitForSelector('[role=alert]:has-text("isn’t in the ontology any more")');
  assert.deepEqual(errors, []);
});

test('the plant navigator in local mode walks the demo plant', async (t) => {
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}#/plant`);
  await page.waitForSelector('.page-head h1:has-text("Demo Cell Plant")');
  await page.waitForSelector('.place-card:has-text("Housing Casting"):has-text("3 warnings")');
  await page.click('.place-card:has-text("Housing Casting")');
  await page.click('.place-card:has-text("Die-cast Line 1")');
  await page.click('.place-card:has-text("Die-caster DC-02")');
  await page.waitForSelector('tr:has-text("Plunger velocity"):has-text("m/s")');
  await page.waitForSelector('.plant-sheet:has-text("Plunger friction virtual sensor")');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
  assert.deepEqual(errors, []);
});

test('setting up a site: outline the plant, connect an agent, map a tag, open the first dashboard', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'admin', 'viewer@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openAs(t, apiUrl, null, 'onboarding');
  await page.waitForSelector('.wizard-panel h2:has-text("Outline the plant")'); // the first step not done
  assert.match(await page.locator('.wizard-steps li.done').first().innerText(), /Create the site/);

  // Another site, by an admin: the slug follows the name.
  await page.click('[data-step=site]');
  await page.fill('#new-site [name=name]', 'Plant 2');
  assert.equal(await page.inputValue('#new-site [name=slug]'), 'plant-2');
  await page.click('#new-site button[type=submit]');
  await page.waitForSelector('#toast:has-text("Plant 2 created")');
  await page.waitForSelector('[data-open-site]:has-text("Set up Plant 2 now")');
  await page.click('#new-site button[type=submit]');
  await page.fill('#new-site [name=name]', 'Plant 2');
  await page.click('#new-site button[type=submit]');
  await page.waitForSelector('#toast:has-text("already has a site called plant-2")');

  // The plant outlined: a line of two machines, each with its PLC.
  await page.click('[data-step=outline]');
  await page.fill('#outline [name=line]', 'Line 1');
  await page.fill('#outline [name=machines]', 'Press 1\nPress 2');
  await page.click('#outline button[type=submit]');
  await page.waitForSelector('#toast:has-text("Line 1 added to the ontology")');
  await page.waitForSelector('.wizard-steps li.done:has-text("2 machines in the ontology")');
  await page.waitForSelector('.wizard-panel h2:has-text("Connect an edge agent")');

  // An agent: its token once, with its config; the page sees its first heartbeat by itself.
  await page.click('#new-agent button[type=submit]');
  await page.waitForSelector('[data-agent-token]');
  const token = (await page.locator('[data-agent-token] pre').first().innerText()).trim();
  assert.match(token, /^tla_/);
  assert.match(await page.locator('[data-agent-token]').innerText(), new RegExp(`url = "${apiUrl}"`));
  await page.waitForSelector('[role=status]:has-text("Waiting for the agent’s first heartbeat")');
  // The page checks every 5 s, and leaves what is being typed alone until there is news.
  await page.click('[data-step=outline]');
  await page.fill('#outline [name=line]', 'Line 2');
  await page.waitForTimeout(6_000);
  assert.equal(await page.inputValue('#outline [name=line]'), 'Line 2');
  await page.click('[data-step=agent]');
  fake.heartbeat(token);
  await page.waitForSelector('.wizard-steps li.done:has-text("1 agent has called in")', { timeout: 15_000 });
  await page.waitForSelector('.wizard-panel h2:has-text("Map the tags")');
  await page.waitForSelector('.wizard-panel:has-text("No tags have arrived yet")');

  // A tag arrives and is mapped to a Signal node of Press 1's PLC: Press 1 is the first dashboard.
  fake.commitAs(
    'maria',
    [
      { kind: 'addNode', node: { id: 'sig-force', type: 'Signal', label: 'Force', props: { unit: 'kN' } } },
      { kind: 'addEdge', edge: { id: 'e-force', from: 'plc-press-1', rel: 'emits', to: 'sig-force' } },
    ],
    'force',
  );
  fake.addSignal('p1.force', { source: 'edge:edge-01' });
  await page.click('[data-onboarding-refresh]');
  await page.waitForSelector('.wizard-panel:has-text("0 of 1 tags are mapped")');
  fake.addSignal('p1.force', { node_id: 'sig-force' });
  await page.click('[data-onboarding-refresh]');
  await page.waitForSelector('.wizard-panel h2:has-text("Open the first dashboard")');
  await page.waitForSelector('.wizard-panel [role=status]:has-text("This site is set up")');
  assert.equal(await page.locator('.wizard-steps li.done').count(), 5);
  await page.click('.wizard-panel a:has-text("Open Press 1")');
  await page.waitForSelector('.page-head h1:has-text("Press 1")');
  await page.waitForSelector('tr:has-text("Force"):has-text("p1.force")');
  assert.deepEqual(
    errors.filter((e) => !/status of 409/.test(e)), // the second Plant 2, refused
    [],
  );

  // Viewers follow the progress but leave the steps to engineers and admins.
  const v = await openAs(t, apiUrl, 'viewer@example.com', 'onboarding');
  await v.page.click('[data-step=outline]');
  await v.page.waitForSelector('.wizard-panel:has-text("Engineers and admins of the site outline the plant")');
  await v.page.click('[data-step=agent]');
  await v.page.waitForSelector('.wizard-panel:has-text("Admins of the site register edge agents")');
  assert.equal(await v.page.locator('#outline, #new-agent').count(), 0);
  assert.deepEqual(v.errors, []);

  // In local mode, the page says the API is needed.
  const local = await openPage();
  t.after(() => local.page.close());
  await local.page.goto(`${httpBase}#/onboarding`);
  await local.page.waitForSelector('#view:has-text("Setting up a site needs the Tiles API")');
});

test('assigning never unassigns someone the list of people lacks, and a no-op assign says so', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const id = fake.raiseWarning('dc3.friction', [], {
    started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    last_at: new Date(Date.now() - 60_000).toISOString(),
    peak: 3000,
    baseline: 1800,
    threshold: 2200,
    readings: 29,
    acknowledged_at: new Date().toISOString(),
    acknowledged_by: 'gone@example.com',
    assignee_id: 'gone@example.com', // someone who has left the site: not among its members
  });
  const a = await openAs(t, apiUrl, null, 'warnings');
  await a.page.click(`[data-warning="${id}"]`);
  await a.page.waitForSelector('#warning-form [name=assignee]');
  assert.equal(await a.page.locator('#warning-form [name=assignee]').inputValue(), 'gone@example.com');
  await a.page.click('[data-act=assign]');
  await a.page.waitForSelector('#toast:has-text("Already assigned to gone")');
  assert.match(await a.page.locator('[data-warning-detail]').innerText(), /for gone/);
  assert.deepEqual(a.errors, []);
});

test('the inbox pages through older warnings, and a warning that fails to load stays selected', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const ids = Array.from({ length: 105 }, (_, i) =>
    fake.raiseWarning(`line${String(i).padStart(3, '0')}.friction`, [], {
      started_at: new Date(Date.now() - (200 - i) * 60_000).toISOString(),
      last_at: new Date(Date.now() - (199 - i) * 60_000).toISOString(),
      peak: 3000,
      baseline: 1800,
      threshold: 2200,
      readings: 2,
    }),
  );
  const a = await openAs(t, apiUrl, null, 'warnings');
  await a.page.waitForSelector('[data-more-warnings]');
  assert.equal(await a.page.locator('[data-warning-list] [data-warning]').count(), 100);
  await a.page.click('[data-more-warnings]');
  await a.page.waitForSelector(`[data-warning="${ids[0]}"]`); // the oldest
  assert.equal(await a.page.locator('[data-warning-list] [data-warning]').count(), 105);
  assert.equal(await a.page.locator('[data-more-warnings]').count(), 0);

  fake.failWarningGets(1);
  await a.page.click(`[data-warning="${ids[0]}"]`);
  await a.page.waitForSelector('[data-warning-detail]:has-text("could not be loaded")');
  assert.equal(await a.page.locator(`[data-warning="${ids[0]}"].sel`).count(), 1); // still selected
  await a.page.click('[data-refresh-warnings]');
  await a.page.waitForSelector('[data-warning-detail]:has-text("line000.friction")');
  await a.page.waitForSelector('#crumbs [aria-current=page]:has-text("line000.friction")');
  // The failed read showed a toast; nothing else went wrong.
  assert.deepEqual(
    a.errors.filter((e) => !/503/.test(e)),
    [],
  );
});

test('people promoted while you were elsewhere can be assigned when you come back', async (t) => {
  const fake = createFakeApi({ roles: { 'viewer@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { out } = raiseFrictionWarnings(fake);
  await openAs(t, apiUrl, 'viewer@example.com', 'warnings'); // a member of the site, as a viewer
  const a = await openAs(t, apiUrl, null, 'warnings');
  await a.page.click(`[data-warning="${out}"]`);
  await a.page.waitForSelector('#warning-form [name=assignee]');
  assert.equal(await a.page.locator('#warning-form [name=assignee] option[value="viewer@example.com"]').count(), 0);
  fake.setRole('viewer@example.com', 'engineer');
  // Away and straight back: both navigations' events run once the hash is back on Warnings.
  await a.page.evaluate(() => {
    location.hash = '#/signals';
    location.hash = '#/warnings';
  });
  await a.page.waitForSelector('#warning-form [name=assignee] option[value="viewer@example.com"]', {
    state: 'attached',
  });
  assert.deepEqual(a.errors, []);
});

test('notifications: people choose their emails; admins set the Teams channel and see what failed', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'admin', 'viewer@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.addDelivery({
    recipient: 'eng2@example.com',
    signal_tag: 'dc1.friction',
    sent_at: new Date().toISOString(),
    attempts: 1,
  });
  fake.addDelivery({
    channel: 'teams',
    recipient: 'Teams channel',
    signal_tag: 'dc1.friction',
    attempts: 6,
    failed_at: new Date().toISOString(),
    last_error: 'Teams answered 404',
  });
  const a = await openAs(t, apiUrl, null, 'settings');
  await a.page.waitForSelector('#notify-prefs [data-notify-email]:has-text("Emails go to demo@example.com")');
  assert.equal(await a.page.isChecked('#notify-prefs [name=on_assigned]'), true);
  assert.equal(await a.page.isChecked('#notify-prefs [name=on_raised]'), false);
  await a.page.check('#notify-prefs [name=on_raised]');
  // The page re-renders as the API answers; a choice not yet saved survives it.
  await rerender(a.page);
  await a.page.waitForSelector('#notify-prefs [data-notify-email]:has-text("Emails go to")');
  assert.equal(await a.page.isChecked('#notify-prefs [name=on_raised]'), true);
  await a.page.click('#notify-prefs button[type=submit]');
  await a.page.waitForSelector('#toast:has-text("Notification preferences saved")');

  // The Teams channel: a URL elsewhere is refused; a Teams one is kept, and only its host shown.
  await a.page.waitForSelector('[data-teams-status]:has-text("No channel yet")');
  await a.page.fill('#teams-form [name=url]', 'https://intranet.example.com/hook');
  await a.page.click('#teams-form button[type=submit]');
  await a.page.waitForSelector('#toast:has-text("Not a Microsoft Teams webhook")');
  const hook = 'https://acme.webhook.office.com/webhookb2/secret-part/IncomingWebhook/1/2';
  await a.page.fill('#teams-form [name=url]', hook);
  await rerender(a.page);
  await a.page.waitForSelector('[data-teams-status]:has-text("No channel yet")');
  assert.equal(await a.page.inputValue('#teams-form [name=url]'), hook);
  await a.page.click('#teams-form button[type=submit]');
  await a.page.waitForSelector('[data-teams-status]:has-text("Connected to a channel at acme.webhook.office.com")');
  assert.equal(fake.teamsUrl(), hook);
  assert.equal(await a.page.inputValue('#teams-form [name=url]'), '');
  assert.doesNotMatch(await a.page.content(), /secret-part/);
  // Pausing it needs no URL again: the one set is kept.
  await a.page.uncheck('#teams-form [name=on_raised]');
  await a.page.click('#teams-form button[type=submit]');
  await a.page.waitForSelector('[data-teams-status]:has-text("posting nothing for now")');
  assert.equal(fake.teamsUrl(), hook);

  // What was sent, and what failed with why.
  const rows = a.page.locator('[data-deliveries] tbody tr');
  await rows.first().waitFor();
  assert.match(
    await rows.nth(0).innerText(),
    /New warning · dc1\.friction\s+Teams channel\s+Gave up\s+Teams answered 404/,
  );
  assert.match(await rows.nth(1).innerText(), /eng2@example\.com\s+Sent/);

  // A reload shows the choices saved.
  await a.page.reload();
  await a.page.waitForSelector('#notify-prefs [data-notify-email]:has-text("Emails go to")');
  assert.equal(await a.page.isChecked('#notify-prefs [name=on_raised]'), true);

  const v = await openAs(t, apiUrl, 'viewer@example.com', 'settings');
  await v.page.waitForSelector('#notifications:has-text("Engineers and admins of the site choose")');
  assert.equal(await v.page.locator('#teams-form').count(), 0);
  assert.deepEqual(
    [...a.errors, ...v.errors].filter((e) => !/422/.test(e)),
    [],
  );
});

// Re-renders the current page, as the app does when an answer from the API arrives.
async function rerender(page) {
  await page.evaluate(() => {
    document.querySelector('#view').insertAdjacentHTML('beforeend', '<i data-rerender-mark></i>');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await page.waitForFunction(() => !document.querySelector('[data-rerender-mark]')); // drawn afresh
}

function performanceReport() {
  const now = Date.now();
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const scores = (extra = {}) => ({
    warnings: 3,
    true_warnings: 3,
    false_warnings: 0,
    pending_warnings: 0,
    events: 4,
    caught: 3,
    recall: 0.75,
    precision: 1,
    false_per_day: 0,
    warning_seconds: { count: 3, min: 6080, p10: 6175, median: 6555, p90: 7543, max: 7790 },
    confirmed: { true_alarm: 1, false_alarm: 0, unknown: 0, unresolved: 2 },
    ...extra,
  });
  return {
    start: iso(30 * 24 * 60),
    end: iso(0),
    horizon_seconds: 28_800,
    totals: scores(),
    detectors: [
      { id: 'd1', name: 'dc1-friction', signal_tag: 'dc1.friction', asset: 'DC-01', matched: true, ...scores() },
      {
        id: 'd2',
        name: 'dc2-friction',
        signal_tag: 'dc2.friction',
        asset: null,
        matched: false,
        ...scores({ warnings: 1, events: 0 }),
      },
    ],
    unwatched: [{ asset: 'DC-02', events: 1 }],
    events: [
      {
        at: iso(30),
        asset: 'DC-01',
        kind: 'scrap',
        signal_tag: 'mes.dc1.scrap',
        code: '3',
        warned_at: null,
        warning_seconds: null,
        detector: null,
      },
      {
        at: iso(120),
        asset: 'DC-01',
        kind: 'downtime',
        signal_tag: 'mes.dc1.downtime',
        code: 'DT-SEIZURE',
        warned_at: iso(229),
        warning_seconds: 6555,
        detector: 'dc1-friction',
      },
    ],
  };
}

test('warning performance: what the warnings caught, per detector, for the codes chosen', async (t) => {
  const fake = createFakeApi({ roles: { 'viewer@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.setPerformance(performanceReport());
  const a = await openAs(t, apiUrl, null, 'performance');
  await a.page.waitForSelector('[data-kpis]');
  const tiles = await a.page.locator('[data-kpis] .kpi').allInnerTexts();
  assert.match(tiles[0], /Events warned of\s+75\.0%\s+3 of 4/);
  assert.match(tiles[1], /Warnings an event followed\s+100\.0%/);
  assert.match(tiles[2], /Confirmed true by people\s+100\.0%\s+1 true, 0 false, 0 unknown, 2 open/);
  assert.match(tiles[3], /Warning time \(median\)\s+1\.8 h/);
  const events = a.page.locator('tbody tr', { hasText: 'DT-SEIZURE' });
  assert.match(await events.innerText(), /warned\s+1\.8 h ahead, by dc1-friction/);
  assert.match(await a.page.locator('tbody tr', { hasText: 'scrap' }).innerText(), /missed/);
  await a.page.waitForSelector('[data-unwatched]:has-text("No detector watches DC-02 (1 event(s))")');
  assert.match(await a.page.locator('[data-detector-row="d2"]').innerText(), /Set its asset/);

  // Another period, horizon and codes: asked for as such.
  await a.page.selectOption('#performance-form [name=days]', '7');
  await a.page.selectOption('#performance-form [name=horizon]', '2');
  await a.page.fill('#performance-form [name=codes]', 'DT-SEIZURE, DT-LUBRICATION,DT-SEIZURE');
  await rerender(a.page); // an answer arriving meanwhile keeps what is being typed
  assert.equal(await a.page.inputValue('#performance-form [name=codes]'), 'DT-SEIZURE, DT-LUBRICATION,DT-SEIZURE');
  assert.equal(await a.page.inputValue('#performance-form [name=days]'), '7');
  await a.page.click('#performance-form button[type=submit]');
  await a.page.waitForSelector('[data-kpis]');
  assert.equal(fake.performanceQueries().at(-1), 'days=7&horizon_hours=2&codes=DT-SEIZURE&codes=DT-LUBRICATION');

  // Matching the second detector to its asset's events.
  await a.page.fill('[data-asset-form="d2"] [name=asset]', 'DC-02');
  await a.page.click('[data-asset-form="d2"] button');
  await a.page.waitForSelector('#toast:has-text("Matched to DC-02’s events")');
  await a.page.waitForSelector('[data-detector-row="d2"]:not(:has-text("Set its asset"))');

  const v = await openAs(t, apiUrl, 'viewer@example.com', 'performance');
  await v.page.waitForSelector('[data-detector-row="d1"]');
  assert.equal(await v.page.locator('[data-asset-form]').count(), 0);
  assert.deepEqual([...a.errors, ...v.errors], []);
});

test('a signal is marked as an MES event stream with its asset', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.raiseWarning('mes.dc1.downtime', [{ at: new Date().toISOString(), value: 'DT-SEIZURE' }], {
    started_at: new Date().toISOString(),
    last_at: new Date().toISOString(),
    peak: 1,
    baseline: 0,
    threshold: 0.5,
    readings: 1,
  }); // only to create the signal with a reading
  const a = await openAs(t, apiUrl, null, 'signals');
  await a.page.click('tr:has-text("mes.dc1.downtime") [data-edit]');
  await a.page.selectOption('#signal-form [name=events]', 'downtime');
  await a.page.fill('#signal-form [name=asset]', ' DC-01 ');
  await a.page.click('#signal-form button[type=submit]');
  await a.page.waitForSelector(
    'tr:has-text("mes.dc1.downtime") [data-event-badge]:has-text("downtime events · DC-01")',
  );
  assert.deepEqual(a.errors, []);
});

test('an asset being typed survives a re-render of the performance page', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.setPerformance(performanceReport());
  const a = await openAs(t, apiUrl, null, 'performance');
  await a.page.waitForSelector('[data-asset-form="d2"]');
  await a.page.fill('[data-asset-form="d2"] [name=asset]', 'DC-0');
  await rerender(a.page);
  assert.equal(await a.page.inputValue('[data-asset-form="d2"] [name=asset]'), 'DC-0');
  assert.deepEqual(a.errors, []);
});

function cutterCsv() {
  const rows = generateCutterBatches();
  const keys = ['id', 'material', 'tension', 'speed', 'humidity', 'bladeAge', 'rollDiameter', 'ng'];
  return [
    keys.join(','),
    ...rows.map((r) => keys.map((k) => (k === 'ng' ? (r.ng ? 'yes' : 'no') : r[k])).join(',')),
  ].join('\n');
}

test('the correlation finder: upload a batch table, split it, and read the effects', async (t) => {
  const fake = createFakeApi({ roles: { 'viewer@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const a = await openAs(t, apiUrl, null, 'correlate');
  await a.page.waitForSelector('#dataset-form');
  await a.page.click('#dataset-form button[type=submit]');
  await a.page.waitForSelector('#toast:has-text("Choose the CSV file first")');
  await a.page.setInputFiles('#dataset-form [name=file]', {
    name: 'cutter.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(cutterCsv()),
  });
  await a.page.waitForSelector('[data-chosen-file]:has-text("cutter.csv")');
  assert.equal(await a.page.inputValue('#dataset-form [name=name]'), 'cutter'); // from the file's name
  await rerender(a.page); // the list arriving meanwhile keeps the file chosen
  await a.page.waitForSelector('[data-chosen-file]:has-text("cutter.csv")');
  await a.page.fill('#dataset-form [name=name]', 'Cutter batches');
  await a.page.click('#dataset-form button[type=submit]');
  await a.page.waitForSelector('#toast:has-text("Cutter batches: 720 batch(es) uploaded")');
  await a.page.waitForSelector('[data-analysis]:has-text("720 batch(es)")');
  // yes/no became a true/false column, the outcome by default.
  assert.equal(await a.page.inputValue('#correlate-form [name=outcome]'), 'ng');
  await a.page.selectOption('#correlate-form [name=split]', 'material');
  await a.page.uncheck('#correlate-form [name=variable][value=speed]');
  await rerender(a.page); // the choices survive an answer arriving
  assert.equal(await a.page.inputValue('#correlate-form [name=split]'), 'material');
  assert.equal(await a.page.isChecked('#correlate-form [name=variable][value=speed]'), false);
  await a.page.click('#correlate-form button[type=submit]');
  await a.page.waitForSelector('[data-explanations]');
  const said = await a.page.locator('[data-explanations]').innerText();
  assert.match(said, /anode: failed batches ran tension higher/);
  assert.match(said, /cathode: failed batches ran tension lower/);
  assert.equal(await a.page.locator('[data-result] tbody tr').count(), 8); // 4 variables x 2 materials
  assert.doesNotMatch(await a.page.locator('[data-result] tbody').innerText(), /speed/);
  assert.equal((await a.page.locator('.forest circle.ci.bad').count()) >= 1, true);
  assert.equal((await a.page.locator('.forest circle.ci.good').count()) >= 1, true);

  // Viewers read and run it, but don't upload.
  const v = await openAs(t, apiUrl, 'viewer@example.com', 'correlate');
  await v.page.click('[data-dataset]');
  await v.page.waitForSelector('#correlate-form');
  assert.equal(await v.page.locator('#dataset-form').count(), 0);
  assert.equal(await v.page.locator('[data-delete-dataset]').count(), 0);
  await v.page.click('#correlate-form button[type=submit]');
  await v.page.waitForSelector('[data-result]');
  assert.deepEqual([...a.errors, ...v.errors], []);
});

test('the correlation finder: a failed upload leaves nothing behind, and engineers delete tables', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const a = await openAs(t, apiUrl, null, 'correlate');
  await a.page.waitForSelector('#dataset-form');
  const file = { name: 'cutter.csv', mimeType: 'text/csv', buffer: Buffer.from(cutterCsv()) };
  await a.page.setInputFiles('#dataset-form [name=file]', file);
  await a.page.waitForSelector('[data-chosen-file]');
  fake.failDatasetRows('Row 1: tension must be a number');
  await a.page.click('#dataset-form button[type=submit]');
  await a.page.waitForSelector('#toast:has-text("tension must be a number")');
  await a.page.waitForSelector('[data-dataset-list]:has-text("No batch tables yet")');
  assert.deepEqual(fake.datasets, []);

  // Splitting by the outcome is dropped when the outcome changes to the split column.
  await a.page.setInputFiles('#dataset-form [name=file]', file);
  await a.page.waitForSelector('[data-chosen-file]');
  await a.page.click('#dataset-form button[type=submit]');
  await a.page.waitForSelector('[data-analysis]:has-text("720 batch(es)")');
  await a.page.selectOption('#correlate-form [name=split]', 'material');
  await a.page.selectOption('#correlate-form [name=outcome]', 'material');
  await a.page.fill('#correlate-form [name=ng]', 'anode');
  await a.page.click('#correlate-form button[type=submit]');
  await a.page.waitForSelector('[data-result]');
  assert.equal(fake.correlations.at(-1).split, null);

  // Deleted at once, with Undo (U2.03): nothing is sent until the toast goes.
  await a.page.click('[data-delete-dataset]');
  await a.page.waitForSelector('[data-dataset-list]:has-text("No batch tables yet")');
  assert.equal(fake.datasets.length, 1);
  await undoToast(a.page, 'cutter deleted');
  await a.page.waitForSelector('[data-dataset-list]:has-text("cutter")');
  assert.equal(fake.datasets.length, 1);
  await a.page.click('[data-delete-dataset]');
  await a.page.waitForSelector('[data-dataset-list]:has-text("No batch tables yet")');
  // Left with its toast showing, it is sent by the next load of the page.
  await a.page.reload();
  await waitFor(() => fake.datasets.length === 0);
  assert.deepEqual(
    a.errors.filter((e) => !/Failed to load resource/.test(e)), // the refused batch
    [],
  );
});

test('saved insights: save a correlation, another engineer reviews it, its author reworks it', async (t) => {
  const fake = createFakeApi({ roles: { 'viewer@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const a = await openAs(t, apiUrl, null, 'correlate');
  await a.page.waitForSelector('#dataset-form');
  await a.page.setInputFiles('#dataset-form [name=file]', {
    name: 'cutter.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(cutterCsv()),
  });
  await a.page.waitForSelector('[data-chosen-file]');
  await a.page.click('#dataset-form button[type=submit]');
  await a.page.waitForSelector('[data-analysis]:has-text("720 batch(es)")');
  await a.page.selectOption('#correlate-form [name=split]', 'material');
  await a.page.click('#correlate-form button[type=submit]');
  await a.page.waitForSelector('[data-explanations]');
  await a.page.click('[data-save-insight]');
  // A first draft from the strongest clear effect.
  assert.equal(await a.page.inputValue('#insight-save [name=title]'), 'tension separates failed batches (anode)');
  assert.match(await a.page.inputValue('#insight-save [name=summary]'), /cutter: 720 batch\(es\)/);
  await a.page.fill('#insight-save [name=actions]', 'Lower anode tension\n\n- Check cathode rolls ');
  await rerender(a.page); // what is typed survives
  assert.equal(
    await a.page.inputValue('#insight-save [name=actions]'),
    'Lower anode tension\n\n- Check cathode rolls ',
  );
  await a.page.click('#insight-save button[type=submit]');
  await a.page.waitForSelector('#toast:has-text("Insight #1 saved")');
  await a.page.waitForSelector('[data-insight-detail]:has-text("#1 tension separates failed batches (anode)")');
  assert.equal(await a.page.evaluate(() => location.hash), '#/insights/1');
  assert.deepEqual(await a.page.locator('[data-actions] li').allInnerTexts(), [
    'Lower anode tension',
    'Check cathode rolls',
  ]);
  assert.equal(fake.insights[0].query.split, 'material');
  assert.match(
    await a.page.locator('[data-source]').innerText(),
    /Correlation of cutter: outcome ng .*split by material/,
  );
  assert.equal((await a.page.locator('[data-insight-detail] .forest circle.ci.bad').count()) >= 1, true);
  assert.equal(await a.page.locator('#insight-review').count(), 0); // not its own reviewer

  // Another engineer, following the link: rejecting says why.
  const b = await openAs(t, apiUrl, 'eng2@example.com', 'insights/1');
  await b.page.waitForSelector('#insight-review');
  // The shared link shows the record in the breadcrumbs.
  assert.deepEqual(await b.page.$$eval('#crumbs li', (lis) => lis.map((li) => li.textContent?.trim())), [
    'Home',
    'Insights',
    '#1',
  ]);
  assert.equal(await b.page.locator('#crumbs [aria-current=page]').innerText(), '#1');
  assert.equal(await b.page.locator('[data-insight-list] [data-insight="1"].sel').count(), 1);
  await b.page.click('#insight-review [data-decision=rejected]');
  await b.page.waitForSelector('#toast:has-text("Say why the insight is rejected")');
  await b.page.fill('#insight-review [name=note]', 'Only one month of batches');
  await rerender(b.page);
  assert.equal(await b.page.inputValue('#insight-review [name=note]'), 'Only one month of batches');
  await b.page.click('#insight-review [data-decision=rejected]');
  await b.page.waitForSelector('[data-review]:has-text("Rejected by eng2")');
  assert.match(await b.page.locator('[data-review]').innerText(), /Only one month of batches/);
  assert.equal(await b.page.locator('[data-reopen]').count(), 0); // not theirs

  // Its author reopens and reworks it; the other engineer accepts it.
  await a.page.evaluate(() => (location.hash = '#/insights'));
  await a.page.click('[data-status=""]');
  await a.page.click('[data-insight="1"]');
  await a.page.click('[data-reopen]');
  await a.page.waitForSelector('#toast:has-text("Insight reopened")');
  await a.page.click('[data-edit]');
  await a.page.fill('#insight-edit [name=title]', 'Anode tension drives tab failures');
  await a.page.click('#insight-edit button[type=submit]');
  await a.page.waitForSelector('[data-insight-detail]:has-text("#1 Anode tension drives tab failures")');
  await b.page.evaluate(() => (location.hash = '#/insights'));
  await b.page.waitForSelector('[data-insight-list]:has-text("Anode tension drives tab failures")');
  await b.page.click('[data-insight="1"]');
  await b.page.fill('#insight-review [name=note]', 'Matches the October trial');
  await b.page.click('#insight-review [data-decision=accepted]');
  await b.page.waitForSelector('[data-review]:has-text("Accepted by eng2")');

  // Viewers read insights, but don't save or review them.
  const v = await openAs(t, apiUrl, 'viewer@example.com', 'insights/1');
  await v.page.waitForSelector('[data-insight-detail]:has-text("Accepted by eng2")');
  assert.equal(await v.page.locator('#insight-review, [data-edit], [data-remove], [data-reopen]').count(), 0);
  await v.page.evaluate(() => (location.hash = '#/correlate'));
  await v.page.click('[data-dataset]');
  await v.page.click('#correlate-form button[type=submit]');
  await v.page.waitForSelector('[data-result]');
  assert.equal(await v.page.locator('[data-save-insight]').count(), 0);

  // Its author deletes it.
  await a.page.click('[data-remove]');
  await confirmIn(a.page);
  await a.page.waitForSelector('#toast:has-text("Insight deleted")');
  assert.deepEqual(fake.insights, []);
  assert.deepEqual([...a.errors, ...b.errors, ...v.errors], []);
});

test('saved insights: signals over a range, kept as plotted and opened again in the explorer', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const temp = fake.addSignal('press1.temperature', { source: 'edge:edge-01', unit: '°C' });
  const force = fake.addSignal('press1.force', { source: 'edge:edge-01', unit: 'kN' });
  const end = Date.parse('2026-09-05T06:00:00Z');
  for (let i = 0; i < 288; i++) {
    const at = new Date(end - i * 300_000).toISOString().replace('Z', '000Z');
    fake.samples.set(`press1.temperature|${at}`, 20 + (i % 12));
    fake.samples.set(`press1.force|${at}`, 300 + i);
  }
  temp.last_at = force.last_at = new Date(end).toISOString();
  const from = new Date(end - 6 * 3_600_000).toISOString();
  const to = new Date(end).toISOString();
  // A link with signals and a range shows them (as a saved insight links back).
  const a = await openAs(t, apiUrl, null, `explorer?signals=${temp.id},${force.id}&from=${from}&to=${to}`);
  await a.page.waitForSelector('[data-picked]:has-text("press1.force")');
  await a.page.waitForSelector('[data-chart] svg');
  assert.equal(await a.page.evaluate(() => location.hash), '#/explorer');
  await a.page.click('[data-save-insight]');
  assert.equal(await a.page.inputValue('#insight-save [name=title]'), 'press1.temperature, press1.force');
  await a.page.fill('#insight-save [name=title]', 'Force climbs while temperature cycles');
  await a.page.dblclick('#insight-save button[type=submit]'); // saved once
  await a.page.waitForSelector('[data-insight-detail]:has-text("Force climbs while temperature cycles")');
  assert.equal(fake.insights.length, 1);
  assert.equal(await a.page.locator('[data-evidence-series] svg').count(), 2);
  assert.deepEqual(fake.insights[0].query, {
    kind: 'series',
    signals: [temp.id, force.id],
    start: from,
    end: to,
    points: 900, // as the charts were drawn
  });
  assert.equal(fake.insights[0].evidence.series[1].points.length, 72); // 6 h of 5-minute readings
  await a.page.click('[data-source] a');
  await a.page.waitForSelector('[data-picked]:has-text("press1.force")');
  assert.equal(await a.page.inputValue('#explorer-range [name=from]').then(Boolean), true);
  assert.deepEqual(a.errors, []);
});

test('the wear check: a welder tip climbing in its last day, with a limit', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const power = fake.addSignal('w03.cathode_power', { source: 'edge:edge-01', unit: 'W' });
  const end = Date.parse('2026-09-05T06:00:00Z');
  for (let h = 0; h < 96; h++) {
    const wear = h >= 72 ? 0.12 * ((h - 72) / 24) : 0;
    fake.samples.set(
      `w03.cathode_power|${new Date(end - (96 - h) * 3_600_000).toISOString()}`,
      1620 * (1 + wear) + (h % 3),
    );
  }
  const from = new Date(end - 96 * 3_600_000).toISOString();
  const to = new Date(end).toISOString();
  const a = await openAs(t, apiUrl, null, `explorer?signals=${power.id}&from=${from}&to=${to}`);
  await a.page.waitForSelector('[data-chart] svg');
  const form = `[data-wear-form="${power.id}"]`;
  await a.page.selectOption(`${form} [name=direction]`, 'up');
  await a.page.fill(`${form} [name=limit]`, '1900');
  await rerender(a.page); // the choices survive
  assert.equal(await a.page.inputValue(`${form} [name=limit]`), '1900');
  assert.equal(await a.page.inputValue(`${form} [name=direction]`), 'up');
  const loads = () => fake.requests.filter((r) => r.endsWith('/series')).length;
  const before = loads();
  await a.page.click(`${form} button[type=submit]`);
  await a.page.waitForSelector('[data-wear-result]:has-text("Wearing")');
  assert.equal(loads(), before); // only its own section is redrawn, not the charts
  // The last day against the three before it, in 15-minute buckets.
  assert.deepEqual(fake.wearChecks.at(-1), {
    end: to,
    recent_hours: 24,
    baseline_hours: 72,
    bucket_minutes: 15,
    direction: 'up',
    limit: 1900,
  });
  assert.equal((await a.page.locator('[data-wear-result] svg .level').count()) >= 2, true); // baseline and limit
  // Another question: the answer to the old one goes.
  await a.page.selectOption(`${form} [name=direction]`, 'down');
  await a.page.waitForSelector('[data-wear-result]', { state: 'detached' });
  await a.page.selectOption(`${form} [name=direction]`, 'up');
  await a.page.waitForSelector('[data-wear-result]:has-text("Wearing")'); // the same question again
  await a.page.fill(`${form} [name=limit]`, 'high');
  await a.page.click(`${form} button[type=submit]`);
  await a.page.waitForSelector('#toast:has-text("The limit is a number")');
  // A different range is a different question: its answer goes.
  await a.page.fill(`${form} [name=limit]`, '1,900');
  await a.page.click(`${form} button[type=submit]`);
  await a.page.waitForSelector('[data-wear-result]:has-text("Wearing")');
  assert.equal(fake.wearChecks.at(-1).limit, 1900);
  await a.page.click('[data-preset="24h"]');
  await a.page.waitForSelector('[data-wear-result]', { state: 'detached' });
  assert.deepEqual(a.errors, []);
});

test('the copilot: a streamed answer with its tools, citations, a withdrawn draft and feedback', async (t) => {
  const fake = createFakeApi({ copilot: true });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.copilotScripts.push({
    drafts: [{ text: 'It runs at 99 °C.', reason: 'it cites no tool result; no cited result holds 99' }],
    tools: [
      {
        name: 'find_signals',
        input: { query: 'oil' },
        result: { signals: [{ tag: 'press9.oil_temp', last_value: 42 }] },
      },
    ],
    answer: '`press9.oil_temp` reads **42 °C** [1].',
  });
  const a = await openAs(t, apiUrl, null, 'chat');
  await a.page.waitForSelector('[data-new-conversation]');
  await a.page.fill('#composer [name=q]', 'How hot is the press oil?');
  await rerender(a.page); // what is typed survives
  assert.equal(await a.page.inputValue('#composer [name=q]'), 'How hot is the press oil?');
  fake.slowCopilot(150);
  await a.page.click('#composer button[type=submit]');
  // It streams in: the draft, its withdrawal, the tool, then the answer word by word.
  await a.page.waitForSelector('[data-live] [data-retracted]');
  await a.page.waitForSelector('[data-live] [data-answer-text]:has-text("reads")');
  assert.equal(await a.page.locator('#composer button[type=submit]').isDisabled(), true);
  await a.page.waitForSelector('[data-live]', { state: 'detached' });
  fake.slowCopilot(5);
  await a.page.waitForSelector('[data-answer-text]:has-text("reads 42 °C")');
  await a.page.waitForSelector('[data-conversations]:has-text("How hot is the press oil?")');
  const answer = a.page.locator('.copilot-answer').last();
  assert.match(await answer.locator('[data-retracted]').innerText(), /A first draft was withdrawn: it cites no tool/);
  assert.equal(await answer.locator('[data-answer-text] code').innerText(), 'press9.oil_temp');
  assert.equal(await answer.locator('[data-answer-text] b').innerText(), '42 °C');
  assert.match(await answer.locator('summary').innerText(), /Used 1 tool/);
  // A citation opens the tool behind it, with where to see the evidence.
  assert.equal(await answer.locator('details[data-trace]').evaluate((d) => d.open), false);
  await answer.locator('a.cite').click();
  assert.equal(await answer.locator('details[data-trace]').evaluate((d) => d.open), true);
  const tool = answer.locator('[data-tool="find_signals"]');
  assert.match(await tool.innerText(), /\[1\] find_signals\(query=oil\) ✓/);
  assert.match(await tool.innerText(), /press9\.oil_temp/); // what it gave
  assert.equal(await tool.locator('a').getAttribute('href'), '#/signals');
  assert.deepEqual(fake.copilotQuestions, ['How hot is the press oil?']);

  // Not helpful: a thumbs down asks what was wrong, for the site's admins.
  await answer.locator('[data-rate="down"]').click();
  await a.page.waitForSelector('[data-rate-form]');
  await a.page.fill('[data-rate-form] [name=comment]', 'It should say which press');
  await a.page.click('[data-rate-form] button[type=submit]');
  await a.page.waitForSelector('#toast:has-text("your site’s admins will see it")');
  await a.page.waitForSelector('[data-feedback]:has-text("It should say which press")');
  assert.deepEqual(
    fake.copilotFeedback.map((f) => [f.seq, f.rating, f.comment]),
    [[3, 'down', 'It should say which press']],
  );
  assert.equal(await a.page.locator('[data-rate="down"]').getAttribute('aria-pressed'), 'true');

  // Rating updates the answer as stored, without fetching the conversation again.
  const reads = () => fake.requests.filter((r) => /^GET .*\/copilot\/conversations\/[^/]+$/.test(r)).length;
  const before = reads();
  await answer.locator('[data-rate="up"]').click();
  await a.page.waitForSelector('[data-rate="up"][aria-pressed="true"]');
  assert.equal(reads(), before);
  await answer.locator('[data-rate="down"]').click(); // back to the thumbs down
  await a.page.waitForSelector('[data-rate-form]');
  await a.page.fill('[data-rate-form] [name=comment]', 'It should say which press');
  await a.page.click('[data-rate-form] button[type=submit]');
  await a.page.waitForSelector('[data-feedback]:has-text("It should say which press")');

  // A rating shows at once (U2.08); refused, it goes back to what it was.
  fake.slowNext('PUT', /\/feedback$/, 800);
  fake.failNext('PUT', /\/feedback$/, 500, 'Database unavailable');
  await answer.locator('[data-rate="up"]').click();
  await a.page.waitForSelector('[data-rate="up"][aria-pressed="true"]', { timeout: 600 });
  await a.page.waitForSelector('[data-rate="down"][aria-pressed="true"]');
  assert.equal(await a.page.locator('[data-rate="up"]').getAttribute('aria-pressed'), 'false');
  assert.match(await a.page.locator('[data-feedback]').innerText(), /It should say which press/);

  // A later answer can cite an earlier one's result; its link opens that result.
  fake.copilotScripts.push({ answer: 'As before, `press9.oil_temp` reads 42 °C [1].' });
  await a.page.fill('#composer [name=q]', 'Still 42?');
  await a.page.press('#composer [name=q]', 'Enter');
  await a.page.waitForSelector('[data-answer-text]:has-text("As before")');
  await a.page.locator('.copilot-answer').last().locator('a.cite').click();
  assert.equal(
    await a.page
      .locator('details[data-trace]')
      .first()
      .evaluate((d) => d.open),
    true,
  );

  // An answer that fails says so, and still does after the conversation reloads.
  fake.copilotScripts.push({ error: 'Stopped after 8 rounds of tool calls without an answer' });
  await a.page.fill('#composer [name=q]', 'Dig deeper');
  await a.page.press('#composer [name=q]', 'Enter');
  await a.page.waitForSelector('.copilot-answer [role=alert]:has-text("Stopped after 8 rounds")');
  await a.page.waitForSelector('[data-live]', { state: 'detached' });
  await rerender(a.page);
  assert.match(await a.page.locator('.copilot-answer').last().innerText(), /Stopped after 8 rounds/);
  assert.equal(await a.page.inputValue('#composer [name=q]'), ''); // it was sent: not put back to ask again

  // An answer that still states what no tool returned is shown with a warning.
  fake.copilotScripts.push({
    answer: 'It will reach 1,900 W tomorrow.',
    grounding: {
      grounded: false,
      declined: false,
      cited: [],
      unknown_citations: [],
      unsupported_numbers: ['1,900'],
      unsupported_names: [],
      uncited: true,
    },
  });
  await a.page.fill('#composer [name=q]', 'When does the welder fail?');
  await a.page.press('#composer [name=q]', 'Enter');
  await a.page.waitForSelector('[data-grounding-warning]');
  assert.equal(
    await a.page.locator('[data-grounding-warning]').innerText(),
    '⚠ Check this answer: it cites no tool result; no tool returned 1,900.',
  );

  // The conversation is kept: back on the page, it is there with its rating.
  await a.page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/home`);
  await a.page.evaluate(() => (location.hash = '#/chat'));
  await a.page.click('[data-conversation]');
  await a.page.waitForSelector('[data-answer-text]:has-text("reads 42 °C")');
  assert.equal(await a.page.locator('.copilot-answer').count(), 4);
  assert.equal(await a.page.locator('[data-rate="down"]').first().getAttribute('aria-pressed'), 'true');

  // Deleted at once, with Undo (U2.03): nothing is sent until the toast goes.
  const deletes = () => fake.requests.filter((r) => /^DELETE .*\/copilot\/conversations\/[^/]+$/.test(r)).length;
  await a.page.click('[data-delete-conversation]');
  await a.page.waitForSelector('[data-conversations]:not(:has([data-conversation]))');
  await undoToast(a.page, 'Conversation deleted');
  await a.page.waitForSelector('[data-answer-text]:has-text("reads 42 °C")'); // open again
  assert.equal(deletes(), 0);
  await a.page.click('[data-delete-conversation]');
  await a.page.waitForSelector('[data-conversations]:not(:has([data-conversation]))');
  await a.page.click('.toast-item:has-text("Conversation deleted") .toast-close');
  await waitFor(() => deletes() === 1);
  await a.page.reload();
  await a.page.waitForSelector('[data-new-conversation]');
  assert.equal(await a.page.locator('[data-conversation]').count(), 0);

  await a.page.click('[data-new-conversation]');
  await a.page.waitForSelector('#chat-log:has-text("Ask about your plant")');
  assert.deepEqual(
    a.errors.filter((e) => !/status of 500/.test(e)), // the rating refused on purpose
    [],
  );
});

test('the copilot: with the service off, the built-in skills answer and say so', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const a = await openAs(t, apiUrl, null, 'chat');
  await a.page.waitForSelector('[data-copilot-off]');
  await a.page.click('.chip >> nth=0');
  await a.page.waitForSelector('.msg.bot');
  assert.deepEqual(a.errors, []);
});

test('the copilot per site: off until an admin turns it on in Settings, knowing what it sends', async (t) => {
  const fake = createFakeApi({
    copilot: true,
    copilotEnabled: false,
    roles: { 'admin@example.com': 'admin' },
  });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const e = await openAs(t, apiUrl, null, 'chat');
  await e.page.waitForSelector('[data-copilot-site-off]');
  await e.page.click('.chip >> nth=0'); // the built-in skills still answer
  await e.page.waitForSelector('.msg.bot');
  assert.deepEqual(fake.copilotQuestions, []); // nothing reached the copilot service

  const a = await openAs(t, apiUrl, 'admin@example.com', 'settings');
  const box = a.page.locator('[data-copilot-enabled]');
  await a.page.waitForSelector('[data-copilot-enabled]:not([disabled])');
  assert.equal(await box.isChecked(), false);
  assert.match(await a.page.locator('#copilot-policy').innerText(), /goes to Anthropic's API/);
  await box.check();
  await a.page.waitForSelector('text=The copilot is on for this site');
  assert.match(await a.page.locator('[data-copilot-policy]').innerText(), /^On for this site\.$/);

  await e.page.reload();
  await e.page.waitForSelector('[data-new-conversation]'); // the copilot service answers now
  assert.equal(await e.page.locator('[data-copilot-site-off]').count(), 0);
  // Turned off while the page is open: the next question is refused, and the page falls back.
  await a.page.locator('[data-copilot-enabled]').uncheck();
  await a.page.waitForSelector('text=The copilot is off for this site');
  await e.page.fill('#composer [name=q]', 'How hot is the press oil?');
  await e.page.click('#composer button[type=submit]');
  await e.page.waitForSelector('[data-copilot-site-off]');
  assert.deepEqual(fake.copilotQuestions, []);
  // Not for engineers.
  await e.page.goto(`${e.page.url().split('#')[0]}#/settings`);
  await e.page.waitForSelector('#notifications');
  assert.equal(await e.page.locator('#copilot-policy').count(), 0);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(
    e.errors.filter((m) => !/status of 403/.test(m)), // the refused question
    [],
  );
});

test('copilot usage: admins see questions, tokens, the cache and times; a refused question says why', async (t) => {
  const fake = createFakeApi({ copilot: true, roles: { 'admin@example.com': 'admin' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const day = (d, over = {}) => ({
    day: d,
    questions: 12,
    answered: 10,
    failed: 1,
    over_budget: 1,
    ungrounded: 2,
    model_calls: 30,
    input_tokens: 20000,
    output_tokens: 4000,
    cache_write_tokens: 30000,
    cache_read_tokens: 150000,
    billed_tokens: 69000,
    first_text_p50_ms: 850,
    first_text_p95_ms: 2400,
    total_p50_ms: 5200,
    total_p95_ms: 14000,
    ...over,
  });
  fake.copilotUsage.days.push(
    day('2026-10-09'),
    day('2026-10-08', { questions: 3, answered: 3, failed: 0, over_budget: 0 }),
  );
  fake.copilotUsage.users.push({ user: 'Eng', email: 'eng@example.com', questions: 15, billed_tokens: 138000 });
  fake.copilotUsage.today = { org_billed_tokens: 1250000, site_billed_tokens: 69000 };

  const a = await openAs(t, apiUrl, 'admin@example.com', 'settings');
  await a.page.waitForSelector('[data-copilot-budget]');
  assert.equal(
    await a.page.locator('[data-copilot-budget]').innerText(),
    'Today the organisation has used 1.25M of its 5M tokens (25%); this site 69k.',
  );
  const totals = await a.page.locator('[data-copilot-totals]').innerText();
  assert.match(totals, /Questions\s+15/);
  assert.match(totals, /Over budget\s+1/);
  assert.match(totals, /Tokens\s+138k/);
  assert.match(totals, /From cache\s+75%/);
  const row = await a.page.locator('#copilot-usage tbody tr').first().innerText();
  assert.match(row, /2026-10-09\s+12\s+10\s+1\s+1\s+2\s+69k\s+75%\s+850 ms · 2\.4 s\s+5\.2 s · 14 s/);
  assert.match(await a.page.locator('#copilot-usage').innerText(), /Eng eng@example\.com\s+15\s+138k/);
  assert.match(await a.page.locator('#copilot-usage').innerText(), /6 questions a minute per person/);

  // Not for engineers.
  const e = await openAs(t, apiUrl, null, 'settings');
  await e.page.waitForSelector('#notifications');
  assert.equal(await e.page.locator('#copilot-usage').count(), 0);

  // A question over a limit is refused, and the page says why.
  fake.copilotScripts.push({ refuse: 'You have asked 6 questions in the last minute: wait a moment' });
  await e.page.evaluate(() => (location.hash = '#/chat'));
  await e.page.waitForSelector('[data-new-conversation]');
  await e.page.fill('#composer [name=q]', 'How hot is the press oil?');
  await e.page.press('#composer [name=q]', 'Enter');
  await e.page.waitForSelector('#toast:has-text("6 questions in the last minute")');
  await e.page.waitForFunction(
    () => document.querySelector('#composer [name=q]')?.value === 'How hot is the press oil?',
  );
  assert.equal(await e.page.locator('.copilot-answer').count(), 0); // not stored: ask again later
  assert.deepEqual(a.errors, []);
  assert.deepEqual(
    e.errors.filter((m) => !/429/.test(m)),
    [],
  );
});

test('the copilot proposes an ontology change, which waits for another engineer', async (t) => {
  const fake = createFakeApi({ copilot: true });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const ops = [{ kind: 'addNode', node: { id: 'line-3', type: 'Line', label: 'Assembly Line 3', props: {} } }];
  const number = fake.addCopilotProposal({ message: 'Add Assembly Line 3', ops, author: 'demo@example.com' });
  fake.copilotScripts.push({
    tools: [
      {
        name: 'propose_ontology_change',
        input: { message: 'Add Assembly Line 3', ops },
        result: { change_request: number, status: 'open', committed: false },
      },
    ],
    answer: 'I proposed it as change request 1 [1]; another engineer must approve it before it is committed.',
  });
  const a = await openAs(t, apiUrl, null, 'chat');
  await a.page.waitForSelector('[data-new-conversation]');
  await a.page.fill('#composer [name=q]', 'Add Assembly Line 3 to the plant');
  await a.page.press('#composer [name=q]', 'Enter');
  await a.page.waitForSelector('[data-answer-text]:has-text("another engineer must approve it")');
  await a.page.locator('.copilot-answer a.cite').click(); // opens the trace
  const link = a.page.locator('[data-tool="propose_ontology_change"] a');
  assert.equal(await link.innerText(), 'Review change request #1 →');
  assert.equal(await link.getAttribute('href'), '#/reviews/1');
  await link.click();
  await a.page.waitForSelector('[data-review-detail]:has-text("Add Assembly Line 3")');
  assert.equal(await a.page.evaluate(() => location.hash), '#/reviews'); // picked once
  // The breadcrumbs follow the request shown, not the link that is gone.
  await a.page.waitForSelector('#crumbs [aria-current=page]:has-text("#1")');
  const detail = a.page.locator('[data-review-detail]');
  assert.match(await detail.innerText(), /Proposed by the copilot/);
  assert.match(await a.page.locator('[data-review="1"]').innerText(), /Proposed by the copilot/);
  // The person who asked can't approve it.
  assert.equal(await detail.locator('[data-act="approve"]').count(), 0);
  assert.deepEqual(a.errors, []);
});

test('design studio with the API: runs are stored in shared projects', async (t) => {
  const fake = createFakeApi({ roles: { 'viewer@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const a = await openAs(t, apiUrl, null, 'design');
  await a.page.waitForSelector('[data-projects]:has-text("No projects yet")');
  assert.equal(await a.page.locator('#run-form button[type=submit]').isDisabled(), true); // no project yet
  await a.page.fill('#new-project [name=name]', 'Pack B');
  await a.page.click('#new-project button[type=submit]');
  await a.page.waitForSelector('#toast:has-text("Project “Pack B” created")');
  await a.page.fill('#run-form [name=note]', 'Baseline');
  await a.page.click('#run-form button[type=submit]:has-text("Save run to Pack B")');
  await a.page.waitForSelector('#toast:has-text("Run saved to Pack B")');
  await a.page.waitForSelector('[data-run="1"]:has-text("Baseline")');
  assert.equal(fake.designRuns[0].model, 'cell-swelling');
  assert.equal(fake.designRuns[0].version, '2.0.0');
  assert.equal(fake.designRuns[0].parent, null);

  // Someone else on the site sees it, changes the design and saves after it.
  const b = await openAs(t, apiUrl, 'eng2@example.com', 'design');
  await b.page.waitForSelector('#project option:has-text("Pack B (1 run)")', { state: 'attached' });
  await b.page.waitForSelector('[data-run="1"]:has-text("Baseline")');
  await b.page.locator('[data-param="soc"]').fill('60');
  await b.page.fill('#run-form [name=note]', 'Lower charge');
  await b.page.click('#run-form button[type=submit]');
  await b.page.waitForSelector('[data-run="2"]:has-text("Lower charge")');
  assert.match(await b.page.locator('[data-run="2"]').innerText(), /State of charge: 80\.00 → 60\.00/);
  assert.equal(fake.designRuns[1].parent, 1);
  assert.equal(fake.designRuns[1].params.soc, 60);
  await b.page.waitForSelector('#project option:has-text("Pack B (2 runs)")', { state: 'attached' }); // counted in place
  // The latest run's audit record and report, from the API (T4.13).
  const [json] = await Promise.all([b.page.waitForEvent('download'), b.page.click('[data-audit="json"]')]);
  assert.equal(json.suggestedFilename(), 'tiles-run-2-audit.json');
  const record = JSON.parse(await (await import('node:fs/promises')).readFile(await json.path(), 'utf8'));
  assert.deepEqual([record.format, record.lineage], ['tiles-design-audit/1', [2, 1]]);
  const [report] = await Promise.all([b.page.waitForEvent('download'), b.page.click('[data-audit="pdf"]')]);
  assert.equal(report.suggestedFilename(), 'tiles-run-2-audit.pdf');
  // A run's parameters come back with a click.
  await b.page.click('[data-run="1"]');
  await b.page.waitForSelector('#toast:has-text("Restored run “Baseline”")');
  assert.equal(await b.page.locator('[data-param="soc"]').inputValue(), '80');

  // Viewers read the runs but don't make projects or runs.
  const v = await openAs(t, apiUrl, 'viewer@example.com', 'design');
  await v.page.waitForSelector('[data-run="2"]');
  assert.equal(await v.page.locator('#new-project').count(), 0);
  assert.equal(await v.page.locator('#run-form button[type=submit]').isDisabled(), true);
  for (const p of [a, b, v]) assert.deepEqual(p.errors, []);

  // A run isn't saved before the project's history is known: it would lose its parent.
  fake.slowDesignRuns(1500);
  const c = await openAs(t, apiUrl, 'eng3@example.com', 'design');
  await c.page.waitForSelector('.loading:has-text("Loading runs…")');
  assert.equal(await c.page.locator('#run-form button[type=submit]').isDisabled(), true);
  await c.page.waitForSelector('[data-run="2"]');
  assert.equal(await c.page.locator('#run-form button[type=submit]').isDisabled(), false);
  fake.slowDesignRuns(0);
});

test("design studio: with the API unreachable, runs aren't kept in the browser instead", async (t) => {
  const a = await openAs(t, 'http://127.0.0.1:1', null, 'design');
  await a.page.waitForSelector('[data-projects]:has-text("Can\'t reach the Tiles API")');
  assert.equal(await a.page.locator('#run-form button[type=submit]').isDisabled(), true);
  assert.equal(await a.page.locator('[data-run]').count(), 0);
});

test('design studio: a fine sweep runs on the API with its progress, and can be cancelled', async (t) => {
  const fake = createFakeApi({ roles: { 'viewer@example.com': 'viewer' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const a = await openAs(t, apiUrl, null, 'design');
  await a.page.waitForSelector('[data-sweep-start]');
  await a.page.selectOption('#sweep-steps', '25');
  fake.failSweepReads(1); // a blip while following it
  await a.page.click('[data-sweep-start]');
  await a.page.waitForSelector('[data-sweep-progress]'); // it runs, and says how far it got
  await a.page.waitForSelector('[data-sweep-state]:has-text("API sweep: 625 points")', { timeout: 15000 });
  assert.equal(await a.page.locator('[data-sweep-progress]').count(), 0);
  // The same sweep again comes from the one kept.
  await a.page.click('[data-sweep-start]');
  await a.page.waitForSelector('[data-sweep-state]:has-text("from an identical earlier sweep")');
  // Another one, cancelled while it runs.
  await a.page.selectOption('#sweep-steps', '50');
  await a.page.click('[data-sweep-start]');
  await a.page.click('[data-sweep-cancel]');
  await a.page.waitForSelector('[data-sweep-state]:has-text("Cancelled after")');
  assert.deepEqual(
    a.errors.filter((e) => !/503/.test(e)),
    [],
  );
  // Viewers see the sweep, but don't start one on the API.
  const v = await openAs(t, apiUrl, 'viewer@example.com', 'design');
  await v.page.waitForSelector('[data-projects]');
  assert.equal(await v.page.locator('[data-sweep-start]').count(), 0);
  assert.deepEqual(v.errors, []);
});
