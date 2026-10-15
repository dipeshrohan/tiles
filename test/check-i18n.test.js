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

test('a translation keeps English’s values, plurals and selects (U6.03)', async () => {
  const { shape } = await import('../scripts/check-i18n.js');
  const en = '{count, plural, one {# signal for {name}} other {# signals for {name}}}';
  assert.equal(shape('{count, plural, one {# Signal für {name}} other {# Signale für {name}}}'), shape(en));
  // A plural's options are the language's own: Polish has few and many; the number must stay said.
  const { pluralProblems } = await import('../scripts/check-i18n.js');
  const pl =
    '{count, plural, one {# sygnał dla {name}} few {# sygnały dla {name}} many {# sygnałów dla {name}} other {# sygnału dla {name}}}';
  assert.equal(shape(pl), shape(en));
  assert.deepEqual(pluralProblems(pl, 'pl'), []);
  assert.deepEqual(pluralProblems('{count, plural, one {# Signal} few {# Signale}}', 'de'), [
    '{count} has no "other"',
    '{count}: "few" isn\'t a plural form in de',
  ]);
  assert.notEqual(shape('{count, plural, one {Ein Signal für {name}} other {Signale für {name}}}'), shape(en)); // # dropped
  assert.notEqual(shape('{n, plural, one {# Signal für {name}} other {# Signale für {name}}}'), shape(en));
  assert.notEqual(shape('{count, plural, one {# Signal} other {# Signale}}'), shape(en)); // {name} dropped
  assert.notEqual(shape('Signale für {wer}'), shape('Signals for {name}'));
  // Moved within the sentence is fine.
  assert.equal(shape('{b} und {a}'), shape('{a} and {b}'));
});
