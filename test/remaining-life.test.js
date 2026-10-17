import { describe, expect, it } from 'vitest';
import { timeLeft } from '../js/views/remaining-life.ts';

const c = (extra) => ({ verdict: 'wearing', hours_to_limit: 25, hours_earliest: 20, hours_latest: 31, ...extra });

describe('remaining life (T9.01)', () => {
  it('says when a component reaches its limit, with its interval', () => {
    expect(timeLeft(c({}))).toBe('In about 25 h (20 h to 31 h)');
    expect(timeLeft(c({ hours_latest: null }))).toBe('In about 25 h: from 20 h, or maybe never');
    expect(timeLeft(c({ hours_earliest: null, hours_latest: null }))).toBe('In about 25 h');
    expect(timeLeft(c({ hours_to_limit: 0 }))).toBe('Now');
  });
  it('says when it may, never, or can’t say', () => {
    expect(timeLeft(c({ verdict: 'stable', hours_to_limit: null, hours_latest: null }))).toBe(
      'Not at this pace; maybe from 20 h',
    );
    expect(timeLeft(c({ verdict: 'stable', hours_to_limit: null, hours_earliest: null, hours_latest: null }))).toBe(
      'Not at this pace',
    );
    expect(timeLeft(c({ verdict: 'not_enough_data', hours_to_limit: null }))).toBe('Not enough readings to say');
  });
  it('keeps absurd times readable', () => {
    expect(timeLeft(c({ hours_to_limit: 400, hours_earliest: 72, hours_latest: 41_666_667 }))).toBe(
      'In about 17 days (3 days to over a year)',
    );
  });
});
