import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate, generateDefinitions, parse } from '../scripts/glossary.js';
import { GLOSSARY } from '../js/lib/glossary-data.ts';
import { inSentence, term } from '../js/lib/ui.ts';
import { definition, termTip } from '../js/lib/glossary.ts';
import { findTerms, termFromHash } from '../js/views/glossary.ts';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('js/lib/glossary-data.ts and js/glossary-data.js are made from docs/ui/glossary.md as it is now (run npm run glossary)', () => {
  assert.equal(read('../js/lib/glossary-data.ts'), generate());
  assert.equal(read('../js/glossary-data.js'), generateDefinitions());
  // The bundle has the names; the definitions wait in the classic script, every term's.
  assert.doesNotMatch(read('../js/lib/glossary-data.ts'), /text:/);
  assert.deepEqual(Object.keys(globalThis.tilesGlossary), Object.keys(GLOSSARY));
});

test('the glossary covers the terms the plan names, about 60 or more', () => {
  const keys = Object.keys(GLOSSARY);
  assert.ok(keys.length >= 60, `${keys.length} terms`);
  for (const k of [
    'site',
    'workcenter',
    'line',
    'machine',
    'signal',
    'tag',
    'virtual-sensor',
    'mad',
    'baseline',
    'persistence',
    'cooldown',
    'cohens-d',
    'point-biserial-r',
    'wear',
    'theilsen-slope',
    'grounding',
    'change-request',
  ])
    assert.ok(k in GLOSSARY, k);
});

test('a term is a group heading’s ### with one paragraph of plain words', () => {
  assert.deepEqual(parse('## Data\n\n### Tag\n\nThe name of a\nsignal.\n'), [
    { key: 'tag', term: 'Tag', group: 'Data', text: 'The name of a signal.' },
  ]);
  assert.throws(() => parse('### Tag\n\nNo group.'), /not in a group/);
  assert.throws(() => parse('## G\n\n### Tag\n'), /no definition/);
  assert.throws(() => parse('## G\n\n### Tag\n\nOne.\n\nTwo.'), /more than one paragraph/);
  assert.throws(() => parse('## G\n\n### Tag\n\nSee **this**.'), /formatting/);
  assert.throws(() => parse('## G\n\n### Tag\n\nSee [it](x.md).'), /formatting/);
  assert.throws(() => parse('## G\n\n### Tag\n\nOne.\n\n### tag\n\nTwo.'), /twice/);
});

test('a term on a page: its words dotted, its definition in a tooltip, escaped', () => {
  assert.equal(
    term('baseline'),
    `<button class="term" type="button" data-tooltip="${definition('baseline')}" data-term="baseline">Baseline</button>`,
  );
  // Other words for it name the term first.
  assert.match(term('cohens-d', 'd'), /data-tooltip="Cohen&#39;s d: The size of an effect/);
  assert.match(term('cohens-d', 'd'), />d<\/button>$/);
  assert.match(term('segment', 'a <b>'), />a &lt;b&gt;<\/button>$/);
  // Before the definitions are loaded: the term, dotted, without a tooltip yet (tooltip.ts asks).
  const loaded = globalThis.tilesGlossary;
  delete globalThis.tilesGlossary;
  try {
    assert.equal(term('baseline'), '<button class="term" type="button" data-term="baseline">Baseline</button>');
    assert.equal(termTip('baseline', 'Baseline'), null);
  } finally {
    globalThis.tilesGlossary = loaded;
  }
  assert.equal(termTip('cohens-d', "Cohen's d"), definition('cohens-d'));
});

test('the Glossary page finds terms by their words and definitions, in their groups', () => {
  const found = findTerms('median');
  assert.ok(found.length >= 1);
  const terms = found.flatMap((g) => g.entries.map((e) => e.key));
  assert.ok(terms.includes('median') && terms.includes('mad'), terms.join(' '));
  assert.deepEqual(findTerms('zzqx'), []);
  assert.equal(findTerms('').flatMap((g) => g.entries).length, Object.keys(GLOSSARY).length);
  assert.equal(termFromHash('#/glossary/cohens-d'), 'cohens-d');
  assert.equal(termFromHash('#/glossary/nothing'), null);
  assert.equal(termFromHash('#/glossary'), null);
});

test('a term named inside a sentence: plain words in lower case, names and abbreviations as written', () => {
  assert.equal(inSentence('Recall'), 'recall');
  assert.equal(inSentence('Warning time'), 'warning time');
  for (const name of ['MAD', 'SPC', "Cohen's d", 'Theil–Sen slope', 'Western Electric rules', 'Robust σ'])
    assert.equal(inSentence(name), name);
});
