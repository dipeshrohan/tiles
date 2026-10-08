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

const PAGES = [
  '',
  'chat',
  'ontology',
  'reviews',
  'quality',
  'physics',
  'design',
  'signals',
  'explorer',
  'import',
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
  await page.waitForSelector('#view:has-text("The site could not be loaded from the Tiles API: Can\'t reach")');
  assert.equal(await page.locator('#view a[href="#/settings"]').count(), 0);
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

  const engineer = createFakeApi();
  const engineerUrl = await engineer.listen();
  t.after(() => engineer.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(engineerUrl)}#/settings`);
  await page.waitForSelector('#account');
  assert.equal(await page.locator('#audit').count(), 0);
});

test('site admins register edge agents and see them come online', async (t) => {
  const fake = createFakeApi({ roles: { 'demo@example.com': 'admin' } });
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const { page, errors } = await openPage();
  t.after(() => page.close());
  page.on('dialog', (d) => void d.accept());
  const home = `${httpBase}?api=${encodeURIComponent(apiUrl)}`;
  await page.goto(`${home}#/settings`);
  await page.waitForSelector('#agents:has-text("No agents registered")');
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
  await page.waitForSelector('#agents:has-text("No agents registered")');
  assert.deepEqual(errors, []);
});

test('a revealed agent token never follows you to another API', async (t) => {
  const first = createFakeApi({ roles: { 'demo@example.com': 'admin' } });
  const second = createFakeApi({ roles: { 'demo@example.com': 'admin' } });
  const [a, b] = [await first.listen(), await second.listen()];
  t.after(() => Promise.all([first.close(), second.close()]));
  const { page, errors } = await openPage();
  t.after(() => page.close());
  await page.goto(`${httpBase}?api=${encodeURIComponent(a)}#/settings`);
  await page.waitForSelector('#agents:has-text("No agents registered")');
  await page.fill('#agent-form [name=name]', 'edge-01');
  await page.click('#agent-form button[type=submit]');
  await page.waitForSelector('[data-token]');
  // Switch to another API in Settings, in the same page (no reload): the token stays behind.
  await page.fill('#datasource [name=apiUrl]', b);
  await page.click('#datasource button[type=submit]');
  await page.waitForSelector('#toast:has-text("Using the Tiles API")');
  await page.waitForSelector('#agents:has-text("No agents registered")');
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
  await page.waitForSelector('#agents:has-text("No agents registered")');
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
  await page.waitForSelector('[data-import-history]:has-text("No imports on this site yet")');
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
  await page.fill('[name=timeZone]', 'Europe/Berlin');
  await page.locator('[name=timeZone]').dispatchEvent('change');
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
  await page.waitForSelector('#signal-form button[type=submit]:has-text("Saving")');
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
  await page.waitForSelector('#toast:has-text("The expected range\'s minimum must be below its maximum.")');
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
  await page.waitForSelector('[data-check-quality]:has-text("Checking")');
  assert.equal(await page.locator('[data-check-quality]').isDisabled(), true);
  await page.waitForSelector('#toast:has-text("Checked 1 signal(s)")');
  await page.waitForSelector('[data-check-quality]:has-text("Check quality")');
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
    await page.waitForSelector('#account:has-text("development user")'); // settled: no re-render mid-typing
    await page.fill('#profile [name=email]', email);
    await page.click('#profile button[type=submit]');
    await page.waitForSelector('#toast:has-text("Profile saved")');
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
  await a.page.waitForSelector('#commit-form:has-text("2 uncommitted")');
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
