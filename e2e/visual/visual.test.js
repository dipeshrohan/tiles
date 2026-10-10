// Visual regression tests (U1.08): every page, and the states that matter (empty, error, a dialog
// open), in light, dark and on a phone, compared with the baselines in e2e/visual/baselines/.
//
// Screenshots differ with fonts and the browser build, so these run only in the Playwright container
// (`npm run test:visual`, and CI's Visual regression job): same browser, same fonts, every time.
// `npm run test:visual -- --update` writes new baselines; a PR that changes them says why.
//
// Images are compared in the browser: a pixel differs when a colour channel moves by more than
// CHANNEL; a screenshot fails when more than MAX_SHARE of its pixels differ. A failure writes the
// screenshot and a diff (changed pixels in red over a faded copy) to e2e/visual/output/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createTilesServer } from '../../server.js';
import { createFakeApi } from '../fake-api.js';

const UPDATE = process.argv.includes('--update') || process.env.UPDATE_VISUAL === '1';
const BASELINES = join(import.meta.dirname, 'baselines');
const OUTPUT = join(import.meta.dirname, 'output');
const CHANNEL = 12; // antialiasing moves a few levels; a colour token change moves more
const MAX_SHARE = 0.001; // 0.1% of the pixels
// A fixed clock: the synthetic plant data and every "n min ago" are the same at each run.
const NOW = new Date('2026-10-01T09:00:00Z');

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
  'apps',
  'documents',
  'import',
  'onboarding',
  'settings',
  'styleguide',
];

const VARIANTS = [
  { name: 'light', colorScheme: 'light', viewport: { width: 1280, height: 800 } },
  { name: 'dark', colorScheme: 'dark', viewport: { width: 1280, height: 800 } },
  { name: 'phone', colorScheme: 'light', viewport: { width: 390, height: 844 } },
];

let browser;
let server;
let base;
let compare; // a page that compares two PNGs
const written = new Set(); // baselines this run took

before(async () => {
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(BASELINES, { recursive: true });
  browser = await chromium.launch();
  server = createTilesServer({});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
  compare = await browser.newPage();
});

after(async () => {
  // An update overwrites the baselines it takes; one no test took (a page gone) is named, not deleted.
  if (UPDATE) {
    const stale = readdirSync(BASELINES).filter((f) => !written.has(f));
    if (stale.length) console.log(`Baselines no test took (delete them if their page is gone): ${stale.join(', ')}`);
  }
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function newPage(variant) {
  const page = await browser.newPage({
    colorScheme: variant.colorScheme,
    viewport: variant.viewport,
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
  await page.clock.setFixedTime(NOW);
  return page;
}

// Settled: fonts loaded, nothing animating, no caret blinking, the pointer out of the way.
async function settle(page) {
  await page.mouse.move(0, 0);
  // Toasts come and go (and an error's carries its request ID): dismissed, as a user would.
  for (const close of await page.locator('#toast .toast-close').all()) await close.click().catch(() => {});
  await page.waitForSelector('#toast .toast-item', { state: 'detached' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
  });
  await page.waitForTimeout(100);
}

// A screenshot the page has settled into: taken until two in a row are the same (a long page's
// full-page capture can catch a layout still moving), as Playwright's own toHaveScreenshot does.
async function stableShot(page, options = {}) {
  let last = await page.screenshot(options);
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(150);
    const next = await page.screenshot(options);
    if (next.equals(last)) return next;
    last = next;
  }
  return last;
}

// How many pixels differ, and a picture of where.
async function diff(expected, actual) {
  return compare.evaluate(
    async ({ a, b, channel }) => {
      const load = async (b64) => createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height)
        return { size: `${x.width}×${x.height} → ${y.width}×${y.height}`, changed: 1, total: 1, png: null };
      const canvas = (img) => {
        const c = new OffscreenCanvas(img.width, img.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return ctx;
      };
      const ca = canvas(x);
      const pa = ca.getImageData(0, 0, x.width, x.height);
      const pb = canvas(y).getImageData(0, 0, y.width, y.height).data;
      let changed = 0;
      const out = ca.createImageData(x.width, x.height);
      const o = out.data;
      const p = pa.data;
      for (let i = 0; i < pb.length; i += 4) {
        const moved =
          Math.abs(p[i] - pb[i]) > channel ||
          Math.abs(p[i + 1] - pb[i + 1]) > channel ||
          Math.abs(p[i + 2] - pb[i + 2]) > channel;
        if (moved) {
          changed++;
          o[i] = 230;
          o[i + 1] = 20;
          o[i + 2] = 60;
          o[i + 3] = 255;
        } else {
          o[i] = o[i + 1] = o[i + 2] = (p[i] + p[i + 1] + p[i + 2]) / 3;
          o[i + 3] = 60;
        }
      }
      if (!changed) return { changed, total: pb.length / 4, png: null };
      const d = new OffscreenCanvas(x.width, x.height);
      d.getContext('2d').putImageData(out, 0, 0);
      const blob = await d.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const byte of bytes) s += String.fromCharCode(byte);
      return { changed, total: pb.length / 4, png: btoa(s) };
    },
    { a: expected.toString('base64'), b: actual.toString('base64'), channel: CHANNEL },
  );
}

async function check(name, shot) {
  const file = join(BASELINES, `${name}.png`);
  written.add(`${name}.png`);
  if (UPDATE || !existsSync(file)) {
    assert.ok(UPDATE, `no baseline for ${name}: run npm run test:visual -- --update`);
    writeFileSync(file, shot);
    return;
  }
  const expected = readFileSync(file);
  if (expected.equals(shot)) return; // the same browser makes the same file: nothing to compare
  const result = await diff(expected, shot);
  const share = result.changed / result.total;
  if (share <= MAX_SHARE) return;
  mkdirSync(OUTPUT, { recursive: true });
  writeFileSync(join(OUTPUT, `${name}.actual.png`), shot);
  writeFileSync(join(OUTPUT, `${name}.expected.png`), readFileSync(file));
  if (result.png) writeFileSync(join(OUTPUT, `${name}.diff.png`), Buffer.from(result.png, 'base64'));
  assert.fail(
    result.size
      ? `${name}: the size changed (${result.size})`
      : `${name}: ${(share * 100).toFixed(2)}% of the pixels changed (at most ${MAX_SHARE * 100}%); see e2e/visual/output/${name}.diff.png`,
  );
}

const slug = (route) => (route || 'home').replace(/\//g, '-');

test('every page is in the list', () => {
  const views = join(import.meta.dirname, '../../js/views');
  const ids = readdirSync(views)
    .flatMap((f) => [...readFileSync(join(views, f), 'utf8').matchAll(/^ {2}id: '([\w-]+)',$/gm)].map((m) => m[1]))
    .map((id) => (id === 'home' ? '' : id));
  assert.deepEqual(
    ids.filter((id) => !PAGES.includes(id)),
    [],
  );
});

for (const variant of VARIANTS) {
  test(`every page looks as it did (${variant.name})`, async () => {
    const failures = [];
    // Each page in a fresh tab: nothing carries over from the page before, and it is the page asked
    // for that has rendered (its title is in the tab's).
    for (const route of PAGES) {
      const page = await newPage(variant);
      try {
        await page.goto(`${base}#/${route}`);
        await page.waitForSelector('#view > *');
        await settle(page);
        await check(`${slug(route)}.${variant.name}`, await stableShot(page, { fullPage: true }));
      } catch (e) {
        failures.push(`${route || 'home'}: ${e.message}`);
      } finally {
        await page.close();
      }
    }
    assert.deepEqual(failures, []);
  });
}

// States a page only shows now and then: with the API (fake, answering at once), and a dialog open.
test('states look as they did: empty, error, a dialog', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const failures = [];
  const shoot = async (name, variant, go) => {
    const page = await newPage(variant);
    try {
      await go(page);
      await settle(page);
      await check(`state-${name}.${variant.name}`, await stableShot(page));
    } catch (e) {
      failures.push(`${name}.${variant.name}: ${e.message}`);
    } finally {
      await page.close();
    }
  };
  const api = `${base}?api=${encodeURIComponent(apiUrl)}`;
  for (const variant of VARIANTS.slice(0, 2)) {
    await shoot('documents-empty', variant, async (page) => {
      await page.goto(`${api}#/documents`);
      await page.waitForSelector('[data-doc-list] .empty-state');
    });
    await shoot('apps-empty', variant, async (page) => {
      await page.goto(`${api}#/apps`);
      await page.waitForSelector('[data-app-list] .empty-state');
    });
    await shoot('apps-error', variant, async (page) => {
      fake.failApps(2); // the templates and the list
      await page.goto(`${api}#/apps`);
      await page.waitForSelector('[data-app-list] [role=alert]');
    });
    await shoot('dialog', variant, async (page) => {
      await page.goto(`${base}#/settings`);
      await page.click('[data-reset]');
      await page.waitForSelector('dialog.dialog[open]');
    });
  }
  assert.deepEqual(failures, []);
});
