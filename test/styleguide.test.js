// The style guide (U1.07) shows every token the stylesheet has, once, and each example makes markup.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMPONENTS, STATES, TOKEN_GROUPS } from '../js/lib/styleguide.ts';
import { ILLUSTRATIONS } from '../js/lib/illustrations.ts';

const css = readFileSync(resolve(import.meta.dirname, '../css/styles.css'), 'utf8');
const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
const defined = [...root.matchAll(/(--[\w-]+):/g)].map((m) => m[1]);

test('the style guide lists every token in :root, each once', () => {
  const shown = TOKEN_GROUPS.flatMap((g) => g.tokens);
  assert.deepEqual([...shown].sort(), [...new Set(shown)].sort(), 'a token listed twice');
  assert.deepEqual(
    defined.filter((t) => !shown.includes(t)),
    [],
    'tokens the style guide leaves out',
  );
  assert.deepEqual(
    shown.filter((t) => !defined.includes(t)),
    [],
    'tokens the stylesheet no longer has',
  );
});

test('each example has its code and makes markup', () => {
  for (const e of [...COMPONENTS, ...STATES]) {
    assert.ok(e.code.trim(), `${e.title} has no code`);
    assert.match(e.html(), /^\s*</, `${e.title} makes no markup`);
  }
});

test('every illustration is listed', () => {
  assert.equal(ILLUSTRATIONS.length, new Set(ILLUSTRATIONS).size);
  assert.ok(ILLUSTRATIONS.includes('inbox') && ILLUSTRATIONS.includes('launch'));
});
