import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRng } from '../js/lib/rng.ts';
import { mad, median, SortedWindow } from '../js/lib/stats.ts';

test('a sorted window gives exactly the median and MAD of the values in it, as it moves', () => {
  const rng = createRng(7);
  // Repeated values (rounded) and odd and even window sizes.
  const values = Array.from({ length: 600 }, () => Math.round(rng.next() * 40) / 4);
  for (const size of [1, 2, 5, 50, 51]) {
    const w = new SortedWindow();
    for (let i = 0; i < values.length; i++) {
      w.add(values[i]);
      if (i >= size) w.remove(values[i - size]);
      const shown = values.slice(Math.max(0, i - size + 1), i + 1);
      assert.equal(w.median(), median(shown), `median, window ${size} at ${i}`);
      assert.equal(w.mad(), mad(shown), `MAD, window ${size} at ${i}`);
    }
  }
  assert.ok(Number.isNaN(new SortedWindow().median()));
  assert.ok(Number.isNaN(new SortedWindow().mad()));
});
