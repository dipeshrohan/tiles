// U1.03: no fixed inline styles in the browser app; the few left are computed values.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { computed, inlineStyles, MAX } from '../scripts/check-inline-styles.js';

test('a style is allowed only when its values are computed', () => {
  assert.equal(computed('max-width:${width * 1.5}px'), true);
  assert.equal(computed('background:${def.color}'), true);
  assert.equal(computed('--w:${widths[i]}%'), true);
  assert.equal(computed('transform:rotate(${a}deg)'), true);
  assert.equal(computed('background:${pick({ a: 1 })}'), true);
  assert.equal(computed('${vars}'), true);
  assert.equal(computed('gap:8px'), false);
  assert.equal(computed('color:red'), false);
  assert.equal(computed('gap:8px;width:${w}px'), false);
  assert.equal(computed('color:var(--bad)'), false);
  assert.equal(computed('margin:${m}px 0'), false);
  // A fixed declaration chosen by an expression is still fixed.
  assert.equal(computed("${hidden ? 'opacity:.4' : ''}"), false);
  assert.equal(computed('${hidden ? "opacity:.4" : ""}'), false);
});

test('the browser app has at most MAX inline styles, all computed', () => {
  const found = inlineStyles();
  assert.deepEqual(
    found.filter((f) => !f.ok).map((f) => `${f.where} ${f.value}`),
    [],
  );
  assert.ok(found.length > 0 && found.length <= MAX, `${found.length} inline styles`);
});
