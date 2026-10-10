// DOM patching that keeps state (U3.03, js/lib/morph.ts), in a real browser: morph.ts is loaded on
// its own into a blank page, and each test draws HTML, does what a person would, and draws again.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { chromium } from 'playwright';

const source = stripTypeScriptTypes(readFileSync(new URL('../js/lib/morph.ts', import.meta.url), 'utf8')).replace(
  /^export /gm,
  '',
);

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function blank() {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><main id="root"></main>');
  await page.addScriptTag({ content: `${source}\nwindow.morphing = { morph, replace, noteSent, resetMorph };` });
  return page;
}

const draw = (page, html, how = 'morph') =>
  page.evaluate(([html, how]) => window.morphing[how](document.getElementById('root'), html), [html, how]);

test('a field keeps focus, caret and what was typed while the page around it changes', async () => {
  const page = await blank();
  const html = (n) => `<p>Refreshed ${n} times</p><form><input name="q" value=""><button>Send</button></form>`;
  await draw(page, html(0), 'replace');
  await page.click('input[name=q]');
  await page.keyboard.type('stuck cylinder');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  for (let n = 1; n <= 3; n++) await draw(page, html(n));
  const state = await page.evaluate(() => {
    const input = document.querySelector('input[name=q]');
    return {
      text: document.querySelector('p').textContent,
      value: input.value,
      focused: document.activeElement === input,
      caret: input.selectionStart,
    };
  });
  assert.deepEqual(state, { text: 'Refreshed 3 times', value: 'stuck cylinder', focused: true, caret: 12 });
  await page.close();
});

test('a field follows the page when the page changes it, or once its form is sent', async () => {
  const page = await blank();
  await draw(page, '<form><input name="a" value="1"><textarea name="b"></textarea></form>', 'replace');
  await page.fill('input[name=a]', '5');
  await page.fill('textarea[name=b]', 'draft');
  // The page puts the value back (a Cancel, a value saved elsewhere): the HTML changed, so it shows.
  await draw(page, '<form><input name="a" value="2"><textarea name="b"></textarea></form>');
  assert.deepEqual(await page.evaluate(() => [document.forms[0].a.value, document.forms[0].b.value]), ['2', 'draft']);
  // Sent with what it holds: drawn again unchanged, the form shows the page's empty field.
  await page.evaluate(() => window.morphing.noteSent(document.forms[0]));
  await draw(page, '<form><input name="a" value="2"><textarea name="b"></textarea></form>');
  assert.equal(await page.evaluate(() => document.forms[0].b.value), '');
  await page.close();
});

test('ticked boxes and a chosen option stay through a refresh', async () => {
  const page = await blank();
  const html = (n) =>
    `<span>${n}</span><input type="checkbox" name="c"><select name="s"><option>a</option><option>b</option></select>`;
  await draw(page, html(0), 'replace');
  await page.check('input[name=c]');
  await page.selectOption('select', 'b');
  await draw(page, html(1));
  assert.deepEqual(
    await page.evaluate(() => [document.querySelector('input').checked, document.querySelector('select').value]),
    [true, 'b'],
  );
  await page.close();
});

test('a scrolled table and selected text stay', async () => {
  const page = await blank();
  const rows = (extra) =>
    `<p id="note">Pick a row ${extra}</p><div id="scroller" style="height:100px;overflow:auto"><table>${Array.from(
      { length: 60 },
      (_, i) => `<tr><td>Row ${i}</td></tr>`,
    ).join('')}</table></div>`;
  await draw(page, rows(''), 'replace');
  await page.evaluate(() => {
    document.getElementById('scroller').scrollTop = 400;
    const td = document.querySelectorAll('td')[10];
    getSelection().selectAllChildren(td);
  });
  await draw(page, rows('(refreshed)'));
  const state = await page.evaluate(() => ({
    scroll: document.getElementById('scroller').scrollTop,
    selected: getSelection().toString(),
    note: document.getElementById('note').textContent,
  }));
  assert.deepEqual(state, { scroll: 400, selected: 'Row 10', note: 'Pick a row (refreshed)' });
  await page.close();
});

test('a section someone opened stays open; one the page opens or closes follows the page', async () => {
  const page = await blank();
  const html = (n, open = false) =>
    `<details id="trace"><summary>Trace ${n}</summary>steps</details><details id="auto"${
      open ? ' open' : ''
    }><summary>Auto</summary>x</details>`;
  await draw(page, html(0), 'replace');
  await page.click('#trace summary');
  await draw(page, html(1));
  await draw(page, html(2, true));
  const open = () => page.evaluate(() => [...document.querySelectorAll('details')].map((d) => d.open));
  assert.deepEqual(await open(), [true, true]);
  // The person closes the one the page opened; it stays closed while the page draws it open still.
  await page.click('#auto summary');
  await draw(page, html(3, true));
  assert.deepEqual(await open(), [true, false]);
  // The page closes it and later opens it again: that shows.
  await draw(page, html(4, false));
  await draw(page, html(5, true));
  assert.deepEqual(await open(), [true, true]);
  await page.close();
});

test('rows keep their elements by key when rows are added above them, and go when removed', async () => {
  const page = await blank();
  const list = (ids) => `<ul>${ids.map((id) => `<li data-key="${id}"><button>${id}</button></li>`).join('')}</ul>`;
  await draw(page, list(['b', 'c']), 'replace');
  await page.evaluate(() => {
    window.kept = document.querySelector('[data-key=c]');
    document.querySelector('[data-key=c] button').focus();
  });
  await draw(page, list(['a', 'b', 'c']));
  assert.deepEqual(
    await page.evaluate(() => ({
      same: document.querySelector('[data-key=c]') === window.kept,
      focused: document.activeElement === window.kept.querySelector('button'),
      order: [...document.querySelectorAll('li')].map((li) => li.dataset.key).join(),
    })),
    { same: true, focused: true, order: 'a,b,c' },
  );
  await draw(page, list(['c', 'a']));
  assert.equal(
    await page.evaluate(() => [...document.querySelectorAll('li')].map((li) => li.dataset.key).join()),
    'c,a',
  );
  await page.close();
});

test('a row removed above the focused one moves nothing else', async () => {
  const page = await blank();
  const list = (ids) => `<ul>${ids.map((id) => `<li data-key="${id}"><button>${id}</button></li>`).join('')}</ul>`;
  await draw(page, list(['a', 'b', 'c', 'd']), 'replace');
  await page.evaluate(() => {
    window.moved = 0;
    new MutationObserver((records) => {
      for (const r of records) window.moved += r.addedNodes.length;
    }).observe(document.querySelector('ul'), { childList: true });
    document.querySelector('[data-key=c] button').focus();
  });
  await draw(page, list(['b', 'c', 'd']));
  await page.evaluate(() => new Promise((r) => setTimeout(r)));
  assert.deepEqual(await page.evaluate(() => ({ moved: window.moved, focused: document.activeElement.textContent })), {
    moved: 0,
    focused: 'c',
  });
  await page.close();
});

test('what a script added before the fields is passed over: typed values stay in their own fields', async () => {
  const page = await blank();
  const form =
    '<form id="f"><div class="field"><input name="a" value=""></div><div class="field"><input name="b" value=""></div></form>';
  await draw(page, form, 'replace');
  await page.fill('[name=a]', 'first');
  await page.evaluate(() =>
    document.getElementById('f').insertAdjacentHTML('afterbegin', '<div class="error-summary">2 problems</div>'),
  );
  const a = await page.evaluate(() => (window.a = document.querySelector('[name=a]')) && true);
  assert.ok(a);
  await draw(page, form);
  assert.deepEqual(
    await page.evaluate(() => ({
      a: document.querySelector('[name=a]').value,
      b: document.querySelector('[name=b]').value,
      same: document.querySelector('[name=a]') === window.a,
      summary: !!document.querySelector('.error-summary'),
    })),
    { a: 'first', b: '', same: true, summary: false },
  );
  await page.close();
});

test('a file chosen stays until its form is sent, then the field is empty', async () => {
  const page = await blank();
  const form = (n) => `<form><span>${n}</span><input type="file" name="file"></form>`;
  await draw(page, form(0), 'replace');
  await page.setInputFiles('input[type=file]', { name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from('x,y') });
  await draw(page, form(1));
  assert.equal(await page.evaluate(() => document.querySelector('input').files.length), 1);
  await page.evaluate(() => window.morphing.noteSent(document.forms[0]));
  await draw(page, form(2));
  assert.equal(await page.evaluate(() => document.querySelector('input').files.length), 0);
  await page.close();
});

test('rows with a key say when they come and go; one fading out is not matched again', async () => {
  const page = await blank();
  const list = (ids) => `<ul>${ids.map((id) => `<li data-key="${id}">${id}</li>`).join('')}</ul>`;
  await draw(page, list(['a', 'b']), 'replace');
  const result = await page.evaluate(
    (html) => {
      const root = document.getElementById('root');
      const seen = { entered: [], left: [] };
      const hooks = {
        enter: (el) => seen.entered.push(el.dataset.key),
        leave: (el) => (seen.left.push(el.dataset.key), true), // it stays, fading, until its hook removes it
      };
      window.morphing.morph(root, html[0], hooks);
      const fading = root.querySelector('[data-key=a]');
      // Drawn again before it has gone: it isn't taken for the new row, which comes in new.
      window.morphing.morph(root, html[1], hooks);
      return {
        ...seen,
        fadingStill: fading.isConnected,
        keys: [...root.querySelectorAll('li')].map((li) => li.dataset.key).join(),
      };
    },
    [list(['b', 'c']), list(['a2', 'b', 'c'])],
  );
  assert.deepEqual(result, { entered: ['c', 'a2'], left: ['a'], fadingStill: true, keys: 'a,a2,b,c' }); // the fading row stays where it was
  await page.close();
});

test('the result is what the HTML says: attributes, text, SVG and a changed tag', async () => {
  const page = await blank();
  await draw(
    page,
    '<p class="a" title="x">one</p><svg viewBox="0 0 10 10"><circle r="2"/></svg><span>s</span>',
    'replace',
  );
  const next =
    '<p class="b">two <b>bold</b></p><svg viewBox="0 0 20 20"><rect width="3" height="3"></rect><circle r="4"></circle></svg><em>e</em>';
  await draw(page, next);
  const out = await page.evaluate(() => ({
    html: document.getElementById('root').innerHTML,
    svg: document.querySelector('rect').namespaceURI,
  }));
  const fresh = await page.evaluate((html) => {
    const t = document.createElement('template');
    t.innerHTML = html;
    return t.innerHTML;
  }, next);
  assert.equal(out.html, fresh);
  assert.equal(out.svg, 'http://www.w3.org/2000/svg');
  await page.close();
});

test('patching a large page costs no more than drawing it afresh', async () => {
  const page = await blank();
  // About the ontology canvas at 2,000 nodes: an SVG group, a label and a line each.
  const big = (n) =>
    `<p>${n}</p><svg viewBox="0 0 4000 4000">${Array.from(
      { length: 2000 },
      (_, i) =>
        `<g class="node" data-key="n${i}" transform="translate(${i % 40},${i})"><rect width="80" height="20"></rect><text>Node ${i}</text><line x1="0" y1="0" x2="5" y2="5"></line></g>`,
    ).join('')}</svg>`;
  const timings = await page.evaluate(
    ([a, b]) => {
      const root = document.getElementById('root');
      const time = (fn) => {
        const t = performance.now();
        fn();
        void root.offsetHeight; // layout too, as the page pays it
        return performance.now() - t;
      };
      const fresh = [];
      const patched = [];
      for (let i = 0; i < 5; i++) {
        fresh.push(time(() => window.morphing.replace(root, i % 2 ? a : b)));
        patched.push(time(() => window.morphing.morph(root, i % 2 ? b : a)));
      }
      const median = (xs) => xs.sort((x, y) => x - y)[2];
      return { fresh: median(fresh), patched: median(patched) };
    },
    [big(1), big(2)],
  );
  assert.ok(timings.patched <= timings.fresh * 1.5, `patched ${timings.patched} ms, fresh ${timings.fresh} ms`);
  await page.close();
});
