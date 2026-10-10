// The motion system (U3.01, docs/ui/motion.md), checked in the stylesheet: times from the tokens,
// only opacity and transform move (no layout), nothing loops but progress, and reduced motion
// (the system's, or Tiles' own setting) stops it all.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(import.meta.dirname, '../css/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const lineOf = (i) => css.slice(0, i).split('\n').length;

// The reduced-motion rules are the one place a raw time is allowed (to stop motion).
const reduced = [
  ...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g),
  ...css.matchAll(/:root\[data-motion='reduce'\][\s\S]*?\{[\s\S]*?\}/g),
].map((m) => [m.index, m.index + m[0].length]);
const inReduced = (i) => reduced.some(([a, b]) => i >= a && i < b);

const declarations = (props) =>
  [...css.matchAll(new RegExp(`(?<![\\w-])(${props})\\s*:\\s*([^;{}]+);`, 'g'))].filter((m) => !inReduced(m.index));

test('every duration and delay comes from the motion tokens', () => {
  const raw = declarations(
    'transition|transition-duration|transition-delay|animation|animation-duration|animation-delay',
  )
    .filter((m) => /(?<![\w(-])\d*\.?\d+m?s\b/.test(m[2].replace(/var\(--wait, 300ms\)/g, ''))) // the wait isn't motion
    .map((m) => `${lineOf(m.index)}: ${m[1]}: ${m[2].trim()}`);
  assert.deepEqual(raw, []);
});

test('only opacity and transform move: no layout in a transition or a keyframe', () => {
  const layout =
    /\b(width|height|top|left|right|bottom|margin|padding|inset|max-height|max-width|min-height|flex|grid-template[\w-]*|gap|font-size)\b/;
  const transitions = declarations('transition|transition-property')
    .filter((m) => layout.test(m[2]))
    .map((m) => `${lineOf(m.index)}: ${m[2].trim()}`);
  assert.deepEqual(transitions, []);
  // `all` would move layout too.
  const all = declarations('transition|transition-property')
    .filter((m) => /(^|[\s,])all\b/.test(m[2].trim()))
    .map((m) => `${lineOf(m.index)}: ${m[2].trim()}`);
  assert.deepEqual(all, []);
  // Keyframes change opacity, transform, visibility (to show after a wait) and a shimmer's
  // background position (paint, not layout); nothing else.
  const allowed = new Set(['opacity', 'transform', 'visibility', 'background-position']);
  const moved = [...css.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\n\}/g)].flatMap((k) =>
    [...k[2].matchAll(/([a-z-]+)\s*:/g)]
      .map((p) => p[1])
      .filter((p) => !allowed.has(p))
      .map((p) => `${k[1]}: ${p}`),
  );
  assert.deepEqual(moved, []);
});

test('nothing loops but progress: a spinner, a skeleton shimmer', () => {
  const loops = declarations('animation')
    .filter((m) => /\binfinite\b/.test(m[2]))
    .map((m) => m[2].trim().split(/\s+/)[0]);
  assert.deepEqual([...new Set(loops)].sort(), ['shimmer', 'spin']);
  assert.ok(!/animation-iteration-count\s*:\s*infinite/.test(css));
});

test('reduced motion stops everything, asked by the system or by Tiles', () => {
  // The rules that stop everything (others, like the skeletons' wait, keep what isn't motion).
  const stops = reduced.map(([a, b]) => css.slice(a, b)).filter((block) => /\*::after/.test(block));
  assert.equal(stops.length, 2);
  assert.ok(stops.some((b) => b.startsWith('@media (prefers-reduced-motion')));
  assert.ok(stops.some((b) => b.startsWith(":root[data-motion='reduce']")));
  for (const block of stops) {
    for (const rule of ['transition-duration: 0.01ms', 'animation-duration: 0.01ms', 'animation-iteration-count: 1'])
      assert.ok(block.includes(rule), `${rule} in ${block.slice(0, 40)}`);
    // The skeletons' 300 ms wait isn't motion: neither rule touches it.
    assert.match(block, /\*:not\(\.loading-shapes\),/, block.slice(0, 40));
    assert.match(block, /\*::details-content/, block.slice(0, 40)); // a section's content too
  }
  assert.match(css, /\.loading-shapes \{[^}]*animation: skeleton-wait var\(--wait, 300ms\)/);
});

test('hover and press feedback (colour, border, shadow) changes over --dur-fast', () => {
  const slow = declarations('transition')
    .flatMap((m) => m[2].split(',').map((part) => [m.index, part.trim()]))
    .filter(([, part]) => /^(color|background-color|border-color|box-shadow)\b/.test(part))
    .filter(([, part]) => !/var\(--dur-fast\)/.test(part))
    .map(([i, part]) => `${lineOf(i)}: ${part}`);
  assert.deepEqual(slow, []);
});

test('the tokens are the guide’s: fast 120 ms, standard 200 ms, slow 320 ms, ease-out in, ease-in out', () => {
  const token = (name) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1].trim();
  assert.deepEqual(['dur-fast', 'dur', 'dur-slow'].map(token), ['120ms', '200ms', '320ms']);
  assert.match(token('ease-out'), /^cubic-bezier\(0\.2, 0, 0, 1\)$/);
  assert.match(token('ease-in'), /^cubic-bezier\(0\.4, 0, 1, 1\)$/);
});

test('leaving is quick and eases in; entering eases out', () => {
  const runs = declarations('animation').map((m) => m[2].trim());
  const leaving = runs.filter((r) => /^[\w-]+-out\b/.test(r));
  assert.ok(leaving.length >= 3);
  for (const r of leaving) assert.match(r, /var\(--dur-fast\) var\(--ease-in\)/, r);
  for (const r of runs.filter((r) => /^([\w-]+-in|enter)\b/.test(r))) assert.match(r, /var\(--ease-out\)/, r);
});

test('every control answers the pointer and the keyboard: hover, press and focus (U3.04)', () => {
  const has = (sel, state) =>
    new RegExp(`(^|[,\\s])${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:not\\([^)]*\\))?${state}`, 'm').test(css);
  const controls = ['.btn', '.chip', '.tab', '.seg button', '.review-row', '.place-card', '.nav-link'];
  for (const sel of controls) {
    assert.ok(has(sel, ':hover'), `${sel}:hover`);
    assert.ok(has(sel, ':active'), `${sel}:active`);
  }
  // Focus: every button and link shows a ring from the keyboard; fields show theirs when focused.
  assert.match(css, /button:focus-visible,\s*\.btn:focus-visible/);
  assert.match(css, /a:focus-visible,/);
  assert.match(css, /input:focus,\s*select:focus,\s*textarea:focus/);
  assert.match(css, /:is\(input, select, textarea\):hover/);
});
