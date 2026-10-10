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

// Words written with a capital wherever they are: names, and terms that are names in Tiles.
const PROPER = new Set([
  'Tiles',
  'App',
  'Studio',
  'Microsoft',
  'Teams',
  'Entra',
  'Design',
  'Operations',
  'Settings', // the page, named in a link
  'Signals',
  'Ontology',
  'Plant',
  'Copilot',
  'MES',
  'I',
]);
// Words after the first of each part (a "·", ":" or "—" starts a new one) that have a capital.
const sentenceCase = (text) =>
  text
    .split(/\s+[·:—]\s+|:\s+/)
    .flatMap((part) => part.split(/\s+/).slice(1))
    .filter((w) => /^[A-Z][a-z]/.test(w) && !/\d/.test(w))
    .filter((w) => !PROPER.has(w.replace(/[^\w-]/g, '')));

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
  const found = strings(/toast\(\s*['`"]([^'`"]*!)['`"]/g).map((s) => `${s.f}: ${s.text}`);
  assert.deepEqual(found, []);
});

const labels = () => [
  ...strings(/\bbutton\('([^'$]+)'/g),
  ...strings(/<button[^>]*>([A-Za-z][^<$]{1,60})<\/button>/g),
  ...strings(/<a class="btn[^"]*"[^>]*>([A-Za-z][^<$]{1,60})<\/a>/g),
  ...strings(/\blinkButton\('([^'$]+)'/g),
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

test('the checks catch what they are for', () => {
  assert.deepEqual(sentenceCase('Export As CSV'), ['As']);
  assert.deepEqual(sentenceCase('Open Settings'), []);
  assert.deepEqual(sentenceCase('Plunger friction · Die-caster DC-02'), []);
  assert.deepEqual(sentenceCase('Signal: Back in'), []);
});
