// U1.03: no fixed inline styles in the views; the few left are computed values.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { computed, inlineStyles } from '../scripts/check-inline-styles.js';

test('a style is allowed only when its values are computed', () => {
  assert.equal(computed('max-width:${width * 1.5}px'), true);
  assert.equal(computed('background:${def.color}'), true);
  assert.equal(computed('--w:${widths[i]}%'), true);
  assert.equal(computed('gap:8px'), false);
  assert.equal(computed('gap:8px;width:${w}px'), false);
  assert.equal(computed('color:var(--bad)'), false);
});

test('the browser app has at most 20 inline styles, all computed', () => {
  const found = inlineStyles();
  assert.deepEqual(
    found.filter((f) => !f.ok).map((f) => `${f.where} ${f.value}`),
    [],
  );
  assert.ok(found.length <= 20, `${found.length} inline styles`);
});
