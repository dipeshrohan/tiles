// The words on the pages follow docs/ui/writing.md (U2.09) where a test can tell: no apologies or
// "successfully", no exclamation marks in messages, buttons that are verbs, and sentence case on
// buttons and headings.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = [
  ...readdirSync(join(root, 'js/views')).map((f) => `js/views/${f}`),
  'js/app.ts',
  'js/lib/ui.ts',
  'js/lib/overlay.ts',
  'js/lib/toaster.ts',
  'js/lib/palette.ts',
  'js/lib/styleguide.ts',
].filter((f) => f.endsWith('.ts'));

// The source without its comments (they are written for developers, not shown).
const source = (f) =>
  readFileSync(join(root, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '');

// Words written with a capital wherever they are: names.
const PROPER = new Set(['Tiles', 'Microsoft', 'Teams', 'Entra', 'MES', 'I']);
// Names of pages and product areas: capitals where they name them ("Open Settings", "on the Signals
// page", "App Studio", "Tiles Design"), not as ordinary words ("New App", "View Signals").
const PAGE = new Set(['Settings', 'Signals', 'Ontology', 'Plant', 'Copilot', 'Studio', 'Design', 'Operations']);
const NAMES_PAGE = new Set(['Open', 'the', 'Tiles', 'App']);

// Words after the first of each part (a "·", ":" or "—" starts a new one) that have a capital.
const sentenceCase = (text) =>
  text.split(/\s+[·:—]\s+|:\s+/).flatMap((part) => {
    const words = part.split(/\s+/);
    return words.slice(1).filter((w, k) => {
      const bare = w.replace(/[^\w-]/g, '');
      if (!/^[A-Z][a-z]/.test(w) || /\d/.test(w) || PROPER.has(bare)) return false;
      if (bare === 'App' && words[k + 2] === 'Studio') return false;
      return !(PAGE.has(bare) && NAMES_PAGE.has(words[k] ?? ''));
    });
  });

function strings(re) {
  return files.flatMap((f) => [...source(f).matchAll(re)].map((m) => ({ f, text: m[1].trim() })));
}

test('no apologies, "please" or "successfully" in what the pages say', () => {
  const found = files.flatMap((f) =>
    [
      ...source(f).matchAll(
        /(['`"])((?:(?!\1).)*?\b(oops|sorry|please|successfully|click here|something went wrong|an error occurred)\b(?:(?!\1).)*?)\1/gi,
      ),
    ].map((m) => `${f}: ${m[2]}`),
  );
  assert.deepEqual(found, []);
});

test('messages end without an exclamation mark', () => {
  const found = [
    ...strings(/toast\(\s*'([^'$]*!)'/g),
    ...strings(/toast\(\s*"([^"$]*!)"/g),
    ...strings(/toast\(\s*`([^`]*!)`/g),
  ].map((s) => `${s.f}: ${s.text}`);
  assert.deepEqual(found, []);
});

// A label as written: in single or double quotes, after an icon or not.
const ICON = String.raw`(?:\$\{icon\([^)]*\)\}\s*)?`;
const labels = () => [
  ...strings(/\b(?:button|linkButton)\('([^'$]+)'/g),
  ...strings(/\b(?:button|linkButton)\("([^"$]+)"/g),
  ...strings(new RegExp(String.raw`<button[^>]*>${ICON}([A-Za-z][^<$]{1,60})<\/button>`, 'g')),
  ...strings(new RegExp(String.raw`<a class="btn[^"]*"[^>]*>${ICON}([A-Za-z][^<$]{1,60})<\/a>`, 'g')),
];

test('buttons say what they do', () => {
  const vague = labels()
    .filter((s) => /^(ok|okay|submit|yes|no|click here|go)$/i.test(s.text))
    .map((s) => `${s.f}: ${s.text}`);
  assert.deepEqual(vague, []);
});

test('buttons and headings are in sentence case', () => {
  const headings = [...strings(/<h[1-4][^>]*>([A-Za-z][^<$]{1,80})<\/h[1-4]>/g), ...strings(/\btitle: '([^'$]+)'/g)];
  const found = [...labels(), ...headings].filter((s) => sentenceCase(s.text).length).map((s) => `${s.f}: ${s.text}`);
  assert.deepEqual([...new Set(found)], []);
});

test('every empty state says why it is empty (a body), not only that it is', () => {
  const calls = files.flatMap((f) => {
    const src = source(f);
    return [...src.matchAll(/\b(?:emptyState|errorState)\(\{/g)].map((m) => {
      let depth = 0;
      let k = src.indexOf('{', m.index);
      for (; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}' && --depth === 0) break;
      }
      return { f, call: src.slice(m.index, k + 1) };
    });
  });
  assert.ok(calls.length > 20);
  const bare = calls.filter((c) => !/\bbody(Html)?\s*[,:}]/.test(c.call)).map((c) => `${c.f}: ${c.call.slice(0, 80)}`);
  assert.deepEqual(bare, []);
});

test('the checks catch what they are for', () => {
  assert.deepEqual(sentenceCase('Export As CSV'), ['As']);
  assert.deepEqual(sentenceCase('Open Settings'), []);
  assert.deepEqual(sentenceCase('Plunger friction · Die-caster DC-02'), []);
  assert.deepEqual(sentenceCase('Signal: Back in'), []);
  assert.deepEqual(sentenceCase('New App'), ['App']);
  assert.deepEqual(sentenceCase('View Signals'), ['Signals']);
  assert.deepEqual(sentenceCase('Map tags on the Signals page'), []);
  assert.deepEqual(sentenceCase('Open App Studio'), []);
});
