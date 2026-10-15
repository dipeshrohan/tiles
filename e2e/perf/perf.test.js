// The performance budget (U3.07, docs/UI-PLAN.md): the three heavy pages with heavy data (the
// ontology with 2,069 nodes, a catalogue of 5,000 signals, the Data explorer with 4 signals over
// 30 days) take no task over 50 ms once loaded and answer each click and key in under 200 ms
// (Interaction to Next Paint); Home scores at least 90 for performance in Lighthouse; and the
// bundle and stylesheet stay under a size budget. `npm run test:perf`; CI's Performance budget job.
// The last test makes a page slow on purpose and checks that the measurements catch it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import lighthouse from 'lighthouse';
import { createTilesServer } from '../../server.js';
import { createFakeApi } from '../fake-api.js';
import { largePlantOps } from '../../test/fixtures/large-plant.js';

export const BUDGET = {
  longTaskMs: 50, // the longest task once a page is loaded
  inpMs: 200, // the slowest interaction, from input to the next paint
  lighthouse: 0.9, // Home's performance score (mobile, Lighthouse's default throttling)
  bundleKb: 200, // js/tiles.bundle.js, gzipped
  stylesKb: 24, // css/styles.css, gzipped
};

let browser;
let server;
let base;

before(async () => {
  server = createTilesServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

// From the first moment: long tasks, and every event that is part of an interaction (a click, a
// key) with how long it took to the next paint.
function observe() {
  const perf = { long: [], events: [] };
  window.__perf = perf;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) perf.long.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: 'longtask', buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      if (e.interactionId) perf.events.push({ id: e.interactionId, start: e.startTime, duration: e.duration });
  }).observe({ type: 'event', durationThreshold: 16, buffered: true });
}

async function openPage(t, { slow } = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(observe);
  if (slow) await page.addInitScript(slow);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

// Two frames and a moment more: what an action started has been drawn and observed.
const settle = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300)))),
  );

// What `act` cost: the longest task, the slowest interaction and how many interactions there were.
async function measure(page, act) {
  await settle(page);
  const since = await page.evaluate(() => performance.now());
  await act();
  await settle(page);
  return page.evaluate((since) => {
    const { long, events } = window.__perf;
    const slowest = new Map();
    for (const e of events) if (e.start >= since) slowest.set(e.id, Math.max(slowest.get(e.id) ?? 0, e.duration));
    return {
      longTask: Math.round(Math.max(0, ...long.filter((e) => e.start >= since).map((e) => e.duration))),
      inp: Math.max(0, ...slowest.values()),
      interactions: slowest.size,
    };
  }, since);
}

function withinBudget(m, what, { interactions = true } = {}) {
  assert.ok(m.longTask <= BUDGET.longTaskMs, `${what}: a task took ${m.longTask} ms (budget ${BUDGET.longTaskMs} ms)`);
  assert.ok(m.inp < BUDGET.inpMs, `${what}: an interaction took ${m.inp} ms to paint (budget ${BUDGET.inpMs} ms)`);
  if (interactions) assert.ok(m.interactions > 0, `${what}: no interaction was measured`);
}

// The explorer's charts, all drawn (none still loading).
const charts = (page, n) =>
  page.waitForFunction(
    (n) => {
      const all = [...document.querySelectorAll('#view [data-plot]')];
      return (
        all.length === n && all.every((c) => c.querySelector('svg[role="img"]') && !c.querySelector('[aria-busy]'))
      );
    },
    n,
    { timeout: 30_000 },
  );

async function bigOntology(t, options) {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  fake.commitAs('maria', largePlantOps(), 'import the big plant');
  const page = await openPage(t, options);
  await page.goto(`${base}?api=${encodeURIComponent(apiUrl)}#/ontology`);
  await page.waitForSelector('.statusbar:has-text("Nodes: 2069")', { timeout: 30_000 });
  return page;
}

test('the bundle and the stylesheet stay under their size budget', () => {
  const kb = (path) => gzipSync(readFileSync(new URL(path, import.meta.url)), { level: 9 }).length / 1024;
  const bundle = kb('../../js/tiles.bundle.js');
  const styles = kb('../../css/styles.css');
  assert.ok(bundle <= BUDGET.bundleKb, `the bundle is ${bundle.toFixed(0)} kB gzipped (budget ${BUDGET.bundleKb} kB)`);
  assert.ok(styles <= BUDGET.stylesKb, `the styles are ${styles.toFixed(1)} kB gzipped (budget ${BUDGET.stylesKb} kB)`);
});

test('the ontology with 2,069 nodes: zoom, fold and search within budget', async (t) => {
  const page = await bigOntology(t);
  withinBudget(await measure(page, () => page.waitForTimeout(1000)), 'loaded and left alone', { interactions: false });
  withinBudget(
    await measure(page, async () => {
      await page.click('[data-zoom="in"]');
      await page.click('[data-zoom="in"]');
      await page.click('[data-zoom="out"]');
      await page.click('[data-zoom="fit"]');
    }),
    'zoom buttons',
  );
  const box = await page.locator('svg[data-canvas]').boundingBox();
  withinBudget(
    await measure(page, async () => {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -200);
    }),
    'wheel zoom',
    { interactions: false },
  );
  withinBudget(
    await measure(page, async () => {
      // By keyboard, as a person would (a script's change is no interaction to measure).
      await page.focus('[data-fold-level]');
      await page.keyboard.press('ArrowDown'); // Fold into machines
      await page.waitForSelector('.statusbar:has-text("shown")');
      await page.keyboard.press('ArrowUp'); // back to PLCs
      await page.waitForSelector('.statusbar:has-text("(277 shown)")');
    }),
    'folding',
  );
  withinBudget(
    await measure(page, async () => {
      await page.click('[data-onto-search]');
      await page.keyboard.type('Press 3.2', { delay: 30 });
      await page.waitForSelector('[data-search-count]:has-text("found")');
    }),
    'search',
  );
});

test('a catalogue of 5,000 signals: search and filters within budget', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const list = [];
  for (let line = 1; line <= 25; line++)
    for (let m = 1; m <= 10; m++)
      for (let s = 1; s <= 20; s++)
        list.push({
          tag: `line${line}/press${m}/sensor${String(s).padStart(2, '0')}`,
          unit: s % 2 ? '°C' : 'bar',
          description: `Press ${m} on line ${line}, sensor ${s}`,
          source: s % 3 ? 'edge:edge-01' : 'import:batch.csv',
        });
  fake.addSignals(list);
  const page = await openPage(t);
  await page.goto(`${base}?api=${encodeURIComponent(apiUrl)}#/signals`);
  await page.waitForSelector('[data-signal-count]:has-text("5,000 signal(s)")', { timeout: 30_000 });
  withinBudget(await measure(page, () => page.waitForTimeout(1000)), 'loaded and left alone', { interactions: false });
  withinBudget(
    await measure(page, async () => {
      await page.click('#signal-search [name=q]');
      await page.keyboard.type('press7', { delay: 30 });
      await page.waitForSelector('[data-signal-count]:has-text("500 signal(s)")');
    }),
    'search',
  );
  withinBudget(
    await measure(page, async () => {
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.press('Backspace');
      await page.waitForSelector('[data-signal-count]:has-text("5,000 signal(s)")');
      await page.focus('#signal-search [name=source]');
      await page.keyboard.press('ArrowDown'); // Edge agents
      await page.keyboard.press('ArrowDown'); // Imports
      await page.waitForSelector('[data-signal-count]:has-text("1,500 signal(s)")');
      await page.keyboard.press('Home'); // Any
      await page.waitForSelector('[data-signal-count]:has-text("5,000 signal(s)")');
    }),
    'filters',
  );
  // Every row in one table (U5.02): only those in view are drawn, and it scrolls at 60 fps.
  await page.waitForFunction(() => !/Loading/.test(document.querySelector('[data-signal-count]')?.textContent ?? ''));
  const drawn = await page.locator('[data-table="signals"] tbody tr:not(.spacer)').count();
  assert.ok(drawn < 200, `${drawn} rows drawn of 5,000`);
  let fps = 0;
  withinBudget(
    await measure(page, async () => {
      fps = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const frame = document.querySelector('[data-table="signals"] .table-frame');
            const started = performance.now();
            let frames = 0;
            const step = () => {
              frames++;
              frame.scrollTop += 160; // about four rows a frame: down the whole table in 12 s
              if (performance.now() - started < 2000) requestAnimationFrame(step);
              else resolve((frames * 1000) / (performance.now() - started));
            };
            requestAnimationFrame(step);
          }),
      );
    }),
    'scrolling 5,000 rows',
    { interactions: false },
  );
  assert.ok(fps >= 55, `scrolled at ${fps.toFixed(1)} fps`);
  assert.match(
    await page.locator('[data-table="signals"] tbody tr:not(.spacer)').first().innerText(),
    /line\d+\/press/,
  );
});

test('the Data explorer with 4 signals over 30 days: ranges and removing a signal within budget', async (t) => {
  const fake = createFakeApi();
  const apiUrl = await fake.listen();
  t.after(() => fake.close());
  const to = Math.ceil(Date.now() / 60_000) * 60_000;
  const from = to - 30 * 86_400_000;
  const step = 5 * 60_000; // a reading every 5 minutes: 8,640 a signal
  const ids = fake.addSignals(
    ['oven/temperature', 'oven/pressure', 'press/force', 'press/speed'].map((tag, k) => ({
      tag,
      source: 'edge:edge-01',
      readings: Array.from({ length: (to - from) / step }, (_, i) => ({
        at: new Date(from + i * step).toISOString(),
        value: 100 * (k + 1) + 10 * Math.sin(i / 288) + (i % 7),
      })),
    })),
  );
  const page = await openPage(t);
  const range = `from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`;
  await page.goto(`${base}?api=${encodeURIComponent(apiUrl)}#/explorer?signals=${ids.join(',')}&${range}`);
  await charts(page, 4);
  withinBudget(await measure(page, () => page.waitForTimeout(1000)), 'loaded and left alone', { interactions: false });
  for (const preset of ['7d', '24h', '30d'])
    withinBudget(
      await measure(page, async () => {
        await page.click(`[data-preset="${preset}"]`);
        await charts(page, 4);
      }),
      `the last ${preset}`,
    );
  withinBudget(
    await measure(page, async () => {
      await page.click(`[data-remove="${ids[3]}"]`);
      await page.waitForSelector(`[data-remove="${ids[3]}"]`, { state: 'detached' });
      await charts(page, 3);
    }),
    'removing a signal',
  );
});

test(`Home scores at least ${BUDGET.lighthouse * 100} for performance in Lighthouse`, async () => {
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const chrome = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  try {
    // The median of three runs, as Lighthouse advises for a score that varies a little.
    const scores = [];
    for (let i = 0; i < 3; i++) {
      const run = await lighthouse(base, { port, output: 'json', onlyCategories: ['performance'], logLevel: 'error' });
      scores.push(run.lhr.categories.performance.score);
    }
    const median = scores.sort((a, b) => a - b)[1];
    assert.ok(median >= BUDGET.lighthouse, `Home scored ${scores.join(', ')} (budget ${BUDGET.lighthouse})`);
  } finally {
    await chrome.close();
  }
});

test('the check catches a slow page: a click handler that takes 150 ms fails it', async (t) => {
  // A deliberate regression: every zoom click does 150 ms of work before the page can paint.
  const page = await bigOntology(t, {
    slow: () =>
      document.addEventListener(
        'click',
        (e) => {
          if (!(e.target instanceof Element) || !e.target.closest('[data-zoom]')) return;
          const until = performance.now() + 150;
          while (performance.now() < until);
        },
        true,
      ),
  });
  const m = await measure(page, () => page.click('[data-zoom="in"]'));
  assert.throws(() => withinBudget(m, 'zoom buttons'), /a task took|an interaction took/);
  assert.ok(m.inp >= BUDGET.inpMs || m.longTask > BUDGET.longTaskMs, JSON.stringify(m));
});
