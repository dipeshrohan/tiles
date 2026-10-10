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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createTilesServer } from '../../server.js';
import { createFakeApi } from '../fake-api.js';

const UPDATE = process.argv.includes('--update') || process.env.UPDATE_VISUAL === '1';
const BASELINES = join(import.meta.dirname, 'baselines');
const OUTPUT = join(import.meta.dirname, 'output');
const CHANNEL = 32;
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

before(async () => {
  if (UPDATE) rmSync(BASELINES, { recursive: true, force: true });
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(BASELINES, { recursive: true });
  browser = await chromium.launch();
  server = createTilesServer({});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
  compare = await browser.newPage();
});

after(async () => {
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
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
    // Toasts come and go (and an error's carries its request ID): not part of the page.
    for (const t of document.querySelectorAll('#toast > *')) t.remove();
    document.querySelector('#toast')?.classList.remove('show');
  });
  await page.waitForTimeout(100);
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
      for (let i = 0; i < pb.length; i += 4) {
        const moved = [0, 1, 2].some((k) => Math.abs(pa.data[i + k] - pb[i + k]) > channel);
        if (moved) changed++;
        const grey = (pa.data[i] + pa.data[i + 1] + pa.data[i + 2]) / 3;
        out.data.set(moved ? [230, 20, 60, 255] : [grey, grey, grey, 60], i);
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
  if (UPDATE || !existsSync(file)) {
    assert.ok(UPDATE, `no baseline for ${name}: run npm run test:visual -- --update`);
    writeFileSync(file, shot);
    return;
  }
  const result = await diff(readFileSync(file), shot);
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

for (const variant of VARIANTS) {
  test(`every page looks as it did (${variant.name})`, async () => {
    const page = await newPage(variant);
    const failures = [];
    for (const route of PAGES) {
      await page.goto(`${base}#/${route}`);
      await page.waitForSelector('#view > *');
      await settle(page);
      try {
        await check(`${slug(route)}.${variant.name}`, await page.screenshot());
      } catch (e) {
        failures.push(e.message);
      }
    }
    await page.close();
    assert.deepEqual(failures, []);
  });
}

// States a page only shows now and then: with the API (fake, answering at once), and a dialog open.
test('states look as they did: empty, error, a dialog', async () => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  const failures = [];
  const shoot = async (name, variant, go) => {
    const page = await newPage(variant);
    try {
      await go(page);
      await settle(page);
      await check(`state-${name}.${variant.name}`, await page.screenshot());
    } catch (e) {
      failures.push(`${name}.${variant.name}: ${e.message}`);
    }
    await page.close();
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
  await fake.close();
  assert.deepEqual(failures, []);
});
