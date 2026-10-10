// The stylesheet's design tokens (U1.02): spacing, type sizes, radii, layers and timing come from
// the tokens in :root, so pages share one scale; and every colour has a dark value.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(import.meta.dirname, '../css/styles.css'), 'utf8');
const MARKER = '/* ---- end of tokens';
const at = css.indexOf(MARKER);
const rules = css.slice(at); // after the token block and its fallback
const tokens = css.slice(0, at);

test('the stylesheet marks where its tokens end', () => {
  assert.ok(at > 0, `css/styles.css has no "${MARKER}" line`);
});

const declarations = (source) =>
  [...source.matchAll(/(?<![-\w])([a-z-]+):\s*([^;{}]+);/g)].map(([, prop, value]) => ({ prop, value }));

test('spacing, type sizes and radii use the tokens', () => {
  const scaled = /^(padding|margin)(-[a-z]+)*$|^(row-|column-)?gap$|^font(-size)?$|^border-radius$/;
  const raw = declarations(rules)
    .filter(({ prop, value }) => scaled.test(prop) && /\d+(\.\d+)?px/.test(value))
    // A -1px margin lines a border up with its neighbour's; it isn't spacing.
    .filter(({ value }) => value.trim() !== '-1px')
    .map(({ prop, value }) => `${prop}: ${value}`);
  assert.deepEqual(raw, []);
});

test('layers, line heights and transitions use the tokens', () => {
  const raw = declarations(rules)
    .filter(
      ({ prop, value }) =>
        (['z-index', 'line-height'].includes(prop) && !value.includes('var(--')) ||
        (prop === 'transition' && /\d+(\.\d+)?m?s/.test(value)),
    )
    .map(({ prop, value }) => `${prop}: ${value}`);
  assert.deepEqual(raw, []);
});

test('colours below the tokens come from tokens, so the fallback covers them', () => {
  assert.deepEqual(rules.match(/.*light-dark\(.*/g) ?? [], []);
});

test('every token used is defined', () => {
  const defined = new Set([...tokens.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  assert.deepEqual(
    [...used].filter((t) => !defined.has(t)),
    [],
  );
});

test('every colour has a light and a dark value, and a fallback for older browsers', () => {
  const root = tokens.slice(0, tokens.indexOf('}'));
  const colours = [...root.matchAll(/(--[\w-]+):\s*light-dark\(/g)].map((m) => m[1]);
  assert.ok(colours.length >= 18, `only ${colours.length} colours`);
  const fallback = tokens.slice(tokens.indexOf('@supports not (color: light-dark('));
  assert.deepEqual(
    colours.filter((c) => c.startsWith('--') && !c.startsWith('--shadow') && !fallback.includes(`${c}:`)),
    [],
  );
  // One palette: outside that fallback, the dark values aren't written out again for the media query
  // or the theme toggle.
  const outside = css.slice(0, css.indexOf('@supports not (color: light-dark(')) + rules;
  assert.equal(/@media \(prefers-color-scheme: dark\)/.test(outside), false);
  // The fallback keeps dark mode, for the system setting and for the theme toggle.
  assert.match(fallback, /@media \(prefers-color-scheme: dark\)[\s\S]*:root\[data-theme='dark'\]/);
});
