// Numbers that tick to their new value (U3.04, js/lib/micro.ts): read and written as the page wrote them.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { formatNumber, parseNumber } from '../js/lib/micro.ts';

test('a number is read with what is around it, its separators and decimals', () => {
  assert.deepEqual(parseNumber('1,204'), { prefix: '', value: 1204, decimals: 0, grouped: true, suffix: '' });
  assert.deepEqual(parseNumber('75.0%'), { prefix: '', value: 75, decimals: 1, grouped: false, suffix: '%' });
  assert.deepEqual(parseNumber('1.8 h'), { prefix: '', value: 1.8, decimals: 1, grouped: false, suffix: ' h' });
  // A typographic minus is kept as written, around the number (a count to +2 changes it: no tick).
  assert.deepEqual(parseNumber('−3 open'), { prefix: '−', value: 3, decimals: 0, grouped: false, suffix: ' open' });
  assert.equal(parseNumber('3 of 4'), null); // two numbers: not one value to count
  assert.equal(parseNumber('Wearing'), null);
});

test('it is written back the same way', () => {
  assert.equal(formatNumber(1329.6, { decimals: 0, grouped: true }), '1,330');
  assert.equal(formatNumber(75.04, { decimals: 1, grouped: false }), '75.0');
  assert.equal(formatNumber(12345, { decimals: 0, grouped: false }), '12345');
});
