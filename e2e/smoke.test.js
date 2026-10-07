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

test('ontology page in API mode: import, commit, and see another user’s commits after refresh', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const open = async () => {
    const { page, errors } = await openPage();
    t.after(() => page.close());
    await page.goto(`${httpBase}?api=${encodeURIComponent(apiUrl)}#/ontology`);
    return { page, errors };
  };

  const a = await open();
  await a.page.click('[data-import-demo]');
  await a.page.waitForSelector('#toast:has-text("Demo ontology imported")');
  assert.match(await a.page.locator('.source-bar').innerText(), /Shared through the Tiles API · Plant 1/);
  await a.page.click('[data-tab=history]');
  assert.match(await a.page.locator('.commit').first().innerText(), /Import demo ontology/);

  // A second browser sees the shared history straight away.
  const b = await open();
  await b.page.click('[data-tab=history]');
  assert.match(await b.page.locator('.commit').first().innerText(), /Import demo ontology/);

  // Browser A stages and commits; staged changes stay private until then.
  await a.page.click('[data-tab=canvas]');
  await a.page.fill('#node-form [name=label]', 'Alarm stream DC-02');
  await a.page.selectOption('#node-form [name=type]', 'Signal');
  await a.page.click('#node-form button');
  await a.page.waitForSelector('#commit-form');
  await b.page.click('[data-refresh]');
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
  await b.page.click('[data-refresh]');
  await b.page.click('[data-tab=history]');
  const messages = await b.page.locator('.commit b').allInnerTexts();
  assert.deepEqual(messages.slice(0, 3), ['add shift notes', 'add alarms node', 'Import demo ontology']);

  // Revert from B goes through the API and A sees it after a refresh.
  await b.page.locator('[data-revert]').first().click();
  await b.page.waitForSelector('#toast:has-text("Commit reverted")');
  await a.page.click('[data-refresh]');
  await a.page.click('[data-tab=history]');
  assert.match(await a.page.locator('.commit').first().innerText(), /Revert "add shift notes"/);

  assert.deepEqual([...a.errors, ...b.errors], []);
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

  // Signing out ends the session (and visits the provider's logout).
  await page.goto(`${home}#/settings`);
  const logout = page.waitForRequest((r) => r.url().includes('/idp/logout'));
  await page.click('#account [data-sign-out]');
  await logout;
  await page.waitForURL((u) => !u.pathname.startsWith('/idp'));
  await page.waitForSelector('#view > *');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tiles:oidc-session')), null);

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
