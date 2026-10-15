// Print (U6.05): the records people print (a warning with its chart and activity, an insight with
// its evidence, a change review's diff, the Design Studio's run history and a machine's sheet) on
// A4 and Letter: no menu or controls, nothing cut at the page's edge, the record alone, links with
// their address, charts in black and white with patterns, light even from the dark theme.
// Run with `npm run test:e2e`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTilesServer } from '../server.js';
import { createFakeApi } from './fake-api.js';

let server;
let httpBase;
let browser;
let fake;
let apiBase;
let warningId;

// The width inside the page's margins (css/styles.css's @page: 12 mm each side), in CSS pixels.
const PAPER = { A4: 210, Letter: 215.9 };
const printable = (format) => Math.floor(((PAPER[format] - 24) * 96) / 25.4);

before(async () => {
  server = createTilesServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  httpBase = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
  fake = createFakeApi();
  const apiUrl = await fake.listen();
  apiBase = `${httpBase}?api=${encodeURIComponent(apiUrl)}`;
  const now = Date.now();
  const readings = Array.from({ length: 30 }, (_, i) => ({
    at: new Date(now - (30 - i) * 60_000).toISOString(),
    value: 1800 + i,
  }));
  warningId = fake.raiseWarning('dc1.friction', readings, {
    started_at: readings[5].at,
    last_at: readings[29].at,
    peak: 1829,
    baseline: 1800,
    threshold: 1820,
    readings: 24,
  });
  const long = 'PLC for press 9 with a name long enough to wrap: '.repeat(4);
  fake.requestReviewAs(
    'maria@example.com',
    [
      { kind: 'addNode', node: { id: 'machine-press-9', type: 'Machine', label: 'Press 9', props: {} } },
      { kind: 'addNode', node: { id: 'plc-press-9', type: 'PLC', label: long, props: {} } },
    ],
    'Add press 9',
  );
  // An insight on the warning's signal, saved as the Data explorer saves one.
  const headers = { 'x-tiles-user': 'demo@example.com', 'content-type': 'application/json' };
  const sites = await (await fetch(`${apiUrl}/sites`, { headers })).json();
  const site = (sites.sites ?? sites)[0].id;
  const found = await (await fetch(`${apiUrl}/sites/${site}/signals?q=dc1.friction`, { headers })).json();
  const res = await fetch(`${apiUrl}/sites/${site}/insights`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Friction rises before scrap',
      summary: 'Friction on DC-01 rose for 25 minutes before the scrap.',
      actions: ['Check the plunger tip'],
      source: { kind: 'signals', signals: [found.signals[0].id], start: readings[0].at, end: readings[29].at },
    }),
  });
  assert.equal(res.status, 201);
});

after(async () => {
  await browser?.close();
  server?.close();
  await fake?.close();
});

const RECORDS = [
  ['a warning', () => `${apiBase}#/warnings?show=all&warning=${warningId}`, '[data-warning-detail] .chart'],
  ['an insight', () => `${apiBase}#/insights/1`, '[data-insight-detail] [data-evidence-series]'],
  ['a change review', () => `${apiBase}#/reviews/1`, '[data-review-detail] .review-diff'],
  ['the run history', () => `${httpBase}#/design`, '[data-run]'],
  ['a machine sheet', () => `${httpBase}#/plant/m-dc02`, '.plant-sheet'],
];

// Opens a record as it is on screen (with runs saved, for the Design Studio).
async function open(page, url, ready) {
  await page.emulateMedia({ media: 'screen' });
  await page.goto('about:blank');
  await page.goto(url);
  await page.waitForSelector('#view > *');
  if (url.endsWith('#/design'))
    for (const note of ['Thicker anode, '.repeat(12), 'Baseline']) {
      await page.fill('#run-form input[name="note"]', note);
      await page.click('#run-form button[type="submit"]');
      await page.waitForSelector(`[data-run]:nth-child(${note === 'Baseline' ? 2 : 1})`);
    }
  await page.waitForSelector(ready);
  await page.waitForLoadState('networkidle');
}

// Shows the page as printed, and waits until it is drawn so.
async function printMedia(page, options = {}) {
  await page.emulateMedia({ media: 'print', ...options });
  await page.waitForFunction(() => matchMedia('print').matches);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

// What printing the page now would cut or show that it shouldn't, at the printable width.
async function problems(page) {
  return page.evaluate(() => {
    const out = [];
    const shown = (el) => el.checkVisibility();
    const name = (el) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].join('.')}` : ''}`;
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width)
      out.push(`the page is ${document.documentElement.scrollWidth - width} px wider than the paper`);
    for (const sel of ['.sidebar', '.topbar', '#view .btn', '#view textarea', '.split-list', '.chart-actions'])
      for (const el of document.querySelectorAll(sel)) if (shown(el)) out.push(`${name(el)} is printed`);
    for (const el of document.querySelectorAll('#view *')) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue; // read by screen readers only
      if (r.right > width + 1 || r.left < -1) out.push(`${name(el)} runs off the paper (${r.left}–${r.right})`);
      const css = getComputedStyle(el);
      if (css.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1)
        out.push(`${name(el)} cuts ${el.scrollWidth - el.clientWidth} px of its content`);
    }
    return out;
  });
}

for (const format of ['A4', 'Letter'])
  test(`each record prints on ${format} without cut content, menu or controls (U6.05)`, async () => {
    const page = await browser.newPage({ reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });
    const found = [];
    for (const [label, url, ready] of RECORDS) {
      await open(page, url(), ready);
      await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
      await page.setViewportSize({ width: printable(format), height: 1000 });
      await printMedia(page);
      for (const p of await problems(page)) found.push(`${label}: ${p}`);
      // And it prints: Chromium's own layout of the paper.
      const pdf = await page.pdf({ format, printBackground: true });
      assert.ok((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length >= 1, `${label} printed no page`);
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await page.close();
    assert.deepEqual(found, []);
  });

test('a printed warning: its chart in black and white with patterns, its payload open, light from the dark theme (U6.05)', async () => {
  const page = await browser.newPage({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await open(page, `${apiBase}#/warnings?show=all&warning=${warningId}`, '[data-warning-detail] .chart');
  const payload = page.locator('[data-warning-detail] details');
  assert.equal(await payload.evaluate((d) => d.open), false);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await printMedia(page, { colorScheme: 'dark' });
  const look = await page.evaluate(() => {
    const ink = getComputedStyle(document.body).color;
    const chart = document.querySelector('[data-warning-detail] .chart');
    const line = chart.querySelector('path[data-part="line"]');
    const span = chart.querySelector('.span');
    const level = chart.querySelector('.level');
    return {
      ink,
      background: getComputedStyle(document.body).backgroundColor,
      line: getComputedStyle(line).stroke,
      span: getComputedStyle(span).fill,
      level: [getComputedStyle(level).stroke, getComputedStyle(level).strokeDasharray],
    };
  });
  const light = (rgb) =>
    rgb
      .match(/\d+/g)
      .slice(0, 3)
      .every((v) => Number(v) > 200);
  assert.ok(light(look.background), `printed on ${look.background}`);
  assert.equal(look.line, look.ink);
  assert.match(look.span, /url\("?#print-hatch"?\)/);
  assert.equal(look.level[0], look.ink);
  assert.notEqual(look.level[1], 'none');
  // Its payload is printed open, and folded again after.
  assert.equal(await payload.evaluate((d) => d.open), true);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  assert.equal(await payload.evaluate((d) => d.open), false);
  await page.close();
});

test('a printed insight gives each link’s address after its text, once (U6.05)', async () => {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await open(page, `${apiBase}#/insights/1`, '[data-insight-detail] [data-evidence-series]');
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await printMedia(page);
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('[data-insight-detail] a[href]')].map((a) => ({
      text: a.textContent.trim(),
      href: a.href,
      after: getComputedStyle(a, '::after').content,
    })),
  );
  const explorer = links.find((l) => l.href.includes('#/explorer'));
  assert.ok(explorer, JSON.stringify(links));
  assert.equal(explorer.after, `" (${explorer.href})"`);
  // The insight's own link reads as its address already.
  const self = links.find((l) => l.text === l.href);
  assert.ok(self, JSON.stringify(links));
  assert.equal(self.after, 'none');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  assert.equal(await page.locator('a[data-print-href]').count(), 0);
  await page.close();
});

test('a chart with several lines prints each with its own dash, and its legend says which (U6.05)', async () => {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.goto(`${httpBase}#/physics`);
  await page.waitForSelector('#view svg[data-chart] [data-part="s1"]');
  await printMedia(page);
  const dashes = await page.evaluate(() => {
    const chart = document.querySelector('#view svg[data-chart]:has([data-part="s1"])');
    const parts = [
      ...new Set([...chart.querySelectorAll('[data-part^="s"]:not([data-part="spans"])')].map((p) => p.dataset.part)),
    ];
    const box = chart.closest('.chart-box');
    return parts.map((part) => ({
      part,
      stroke: getComputedStyle(chart.querySelector(`[data-part="${part}"]`)).stroke,
      dash: getComputedStyle(chart.querySelector(`[data-part="${part}"]`)).strokeDasharray,
      key:
        box && getComputedStyle(box.querySelector(`[data-chart-toggle="${part}"] .chart-swatch`) ?? box).borderTopStyle,
    }));
  });
  const ink = await page.evaluate(() => getComputedStyle(document.body).color);
  assert.ok(dashes.length >= 2, JSON.stringify(dashes));
  for (const d of dashes) assert.equal(d.stroke, ink, d.part);
  assert.equal(new Set(dashes.map((d) => d.dash)).size, dashes.length, JSON.stringify(dashes));
  assert.equal(new Set(dashes.map((d) => d.key)).size, dashes.length, JSON.stringify(dashes));
  await page.close();
});
