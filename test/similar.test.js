import { describe, expect, it } from 'vitest';
import { followedText, match, summary, whyText } from '../js/lib/similar.ts';

const w = (extra) => ({ score: 0.874, followed: null, ...extra });

describe('similar past warnings (T10.02)', () => {
  it('says what followed a past warning', () => {
    expect(followedText(w({}))).toBe('Nothing within a day');
    expect(followedText(w({ followed: { kind: 'downtime', code: 'DT-1', hours_after: 0.5 } }))).toBe(
      'Stop DT-1 30 min later',
    );
    expect(followedText(w({ followed: { kind: 'scrap', code: '3', hours_after: 26 } }))).toBe('Scrap 3 26 h later');
    expect(match(w({}))).toBe('87%');
  });
  it('sums up how the similar ones ended', () => {
    const s = (n, outcomes, followed) => ({ similar: Array(n).fill(w({})), outcomes, followed });
    expect(summary(s(3, { true_alarm: 2, false_alarm: 0, unknown: 1, open: 0 }, 2))).toBe(
      'The 3 most similar: 2 true alarms, 0 false alarms, 1 open or unknown; an event followed 2.',
    );
    // One is said as one (review H-23).
    expect(summary(s(1, { true_alarm: 0, false_alarm: 0, unknown: 0, open: 1 }, 0))).toBe(
      '1 similar warning, still open; no event followed it.',
    );
    expect(summary(s(1, { true_alarm: 1, false_alarm: 0, unknown: 0, open: 0 }, 1))).toBe(
      '1 similar warning, a true alarm; an event followed it.',
    );
    expect(summary(s(1, { true_alarm: 0, false_alarm: 1, unknown: 0, open: 0 }, 0))).toBe(
      '1 similar warning, a false alarm; no event followed it.',
    );
    expect(summary(s(1, { true_alarm: 0, false_alarm: 0, unknown: 1, open: 0 }, 0))).toBe(
      '1 similar warning, resolved as unknown; no event followed it.',
    );
  });
  it('says why a batch table is suggested', () => {
    expect(whyText({ why: 'value', matched: 'DC-01' })).toBe('Its rows name DC-01');
    expect(whyText({ why: 'column', matched: 'dc1.friction' })).toBe('It has a column dc1.friction');
    expect(whyText({ why: 'name', matched: 'dc1.friction' })).toBe('It names dc1.friction');
  });
});
