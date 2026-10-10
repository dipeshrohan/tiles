// A page drawn again keeps its elements (U3.03, js/lib/morph.ts) and binds again, so every listener
// a view adds passes the binding's signal (`{ signal: bound() }` from js/lib/dom.ts): the last
// binding's listeners are dropped, never doubled.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(import.meta.dirname, '../js/views');
const files = [...readdirSync(dir).map((f) => resolve(dir, f)), resolve(import.meta.dirname, '../js/lib/insights.ts')];

// The arguments of each call, found by matching brackets (strings skipped).
function calls(source, name) {
  const out = [];
  for (let at = source.indexOf(name); at >= 0; at = source.indexOf(name, at + 1)) {
    let i = at + name.length;
    let depth = 1;
    let quote = null;
    const start = i;
    while (depth && i < source.length) {
      const c = source[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
      } else if (`'"\``.includes(c)) quote = c;
      else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      i++;
    }
    out.push({ line: source.slice(0, at).split('\n').length, args: source.slice(start, i - 1) });
  }
  return out;
}

test('every listener a view adds is dropped with its binding', () => {
  const missing = files.flatMap((file) =>
    calls(readFileSync(file, 'utf8'), '.addEventListener(')
      .filter((c) => !/\bsignal: bound\(\)/.test(c.args))
      .map((c) => `${file.split('/').slice(-2).join('/')}:${c.line}`),
  );
  assert.deepEqual(missing, []);
});
