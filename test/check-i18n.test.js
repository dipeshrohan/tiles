import { test } from 'vitest';
import assert from 'node:assert/strict';
import { check, findText, htmlKeys, pieces } from '../scripts/check-i18n.js';

const found = (src) => findText(src).map((f) => f.text);

test('text between tags, and in the attributes people read, is found', () => {
  assert.deepEqual(found('const a = `<h2>Saved views</h2><p class="small soft">${x}</p>`;'), ['Saved views']);
  assert.deepEqual(found('const a = `<button aria-label="Remove the filter">×</button>`;'), ['Remove the filter']);
  assert.deepEqual(found('const a = `<p>${n} warnings waiting</p>`;'), ['warnings waiting']);
  assert.deepEqual(found("const a = `<span>${t('x.y')}</span>`;"), []);
});

test('quoted sentences and labels are found; code, classes and keys are not', () => {
  assert.deepEqual(found("toast('Profile saved');"), ['Profile saved']);
  assert.deepEqual(found("button('Refresh', { size: 'sm' });"), ['Refresh']);
  assert.deepEqual(found("const cls = 'btn sm ghost'; const k = 'warnings.title'; type T = 'Machine';"), []);
  assert.deepEqual(found('const x: Promise<Map<string, number>> = load(); // Some comment here'), []);
  assert.deepEqual(found("toast('Shown anyway'); // i18n-ok"), []);
});

test('template literals are read in parts around their expressions', () => {
  const p = pieces('`<b>${a ? `x ${b}` : "y"}</b> done`');
  assert.deepEqual(
    p.map((x) => x.text),
    ['<b>', 'x ', '', 'y', '</b> done'],
  );
});

test("index.html's data-i18n attributes count as using their keys", () => {
  const html =
    '<a data-skip data-i18n="app.static.skip">Skip</a><nav aria-label="Pages" data-i18n-label="app.static.pages"></nav><b data-i18n-tooltip="x.y" data-x="no.key"></b>';
  assert.deepEqual([...htmlKeys(html)], ['app.static.skip', 'app.static.pages', 'x.y']);
});

test('the repository passes its own check', () => {
  assert.deepEqual(check(), []);
});
