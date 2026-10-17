import { describe, expect, it } from 'vitest';
import { appliedOrder, combinations, parseValues, reportFile, valuesText } from '../js/lib/detector-templates.ts';

describe('detector templates (T7.02)', () => {
  it('reads several values for a setting', () => {
    expect(parseValues('3 4 5')).toEqual([3, 4, 5]);
    expect(parseValues(' 2,5; 4 4 ')).toEqual([2.5, 4]); // a decimal comma; each value once
    expect(parseValues('')).toBeNull();
    expect(parseValues('3 x')).toBeNull();
    expect(parseValues('3 4.5', true)).toBeNull(); // whole numbers only
    expect(valuesText([3, 4.5])).toBe('3 4.5');
  });

  it('counts the settings a backtest tries', () => {
    const grid = {
      window: [200],
      k: [3, 4, 5],
      persist: [2, 3],
      direction: ['above'],
      cooldown: [0],
      flat_spread: [1],
    };
    expect(combinations(grid)).toBe(6);
  });

  it('lists what was made first, then what is missing', () => {
    const m = (label, result) => ({ label, result });
    const out = appliedOrder([m('B', 'no_tag'), m('C', 'created'), m('A', 'created'), m('D', 'exists')]);
    expect(out.map((x) => x.label)).toEqual(['A', 'C', 'D', 'B']);
    expect(reportFile('dc-friction-dc-01')).toBe('backtest-dc-friction-dc-01.md');
  });
});
