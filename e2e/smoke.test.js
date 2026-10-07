// Browser smoke tests: every page renders, in light, dark and phone layouts,
// over http and file://, with no console errors and no horizontal scroll.
// Run with `npm run test:e2e` (needs a Playwright Chromium install).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createTilesServer } from '../server.js';

const PAGES = ['', 'chat', 'ontology', 'quality', 'physics', 'design', 'settings'];
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

test('settings can switch to the Tiles API and test the connection', async (t) => {
  // A stand-in API that only answers /health, with the CORS header the real one sends.
  const fakeApi = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '9.9.9', env: 'test' }));
    } else res.writeHead(404).end();
  });
  await new Promise((resolve) => fakeApi.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${fakeApi.address().port}`;
  t.after(() => fakeApi.close());

  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}#/settings`);
  await page.fill('#datasource [name=apiUrl]', 'http://127.0.0.1:1');
  await page.click('[data-test-api]');
  await page.waitForSelector('[data-api-status]:has-text("Not reachable")');
  assert.match(await page.locator('#toast').innerText(), /Can't reach the Tiles API at http:\/\/127\.0\.0\.1:1/);

  await page.fill('#datasource [name=apiUrl]', apiUrl);
  await page.click('[data-test-api]');
  await page.waitForSelector('[data-api-status]:has-text("Connected: Tiles API 9.9.9 (test)")');
  await page.check('#datasource [name=mode][value=api]');
  await page.click('#datasource button[type=submit]');
  await page.reload();
  assert.equal(await page.locator('#datasource [name=mode][value=api]').isChecked(), true);
  assert.equal(await page.inputValue('#datasource [name=apiUrl]'), apiUrl);

  // Resetting the workspace keeps the data source.
  page.once('dialog', (d) => d.accept());
  await page.click('[data-reset]');
  await page.reload();
  assert.equal(await page.locator('#datasource [name=mode][value=api]').isChecked(), true);

  // Something that isn't the Tiles API answering /health is not "Connected".
  const other = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  t.after(() => other.close());
  await page.fill('#datasource [name=apiUrl]', `http://127.0.0.1:${other.address().port}`);
  await page.click('[data-test-api]');
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
