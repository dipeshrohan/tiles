// The copilot's usage dashboard (T4.07): totals, cache share, today's budget and number formats.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { budgetToday, cacheShare, duration, percent, tokens, usageTotals } from '../js/lib/copilot-usage.ts';

const day = (over = {}) => ({
  day: '2026-10-09',
  questions: 4,
  answered: 3,
  failed: 1,
  over_budget: 0,
  model_calls: 9,
  input_tokens: 1000,
  output_tokens: 200,
  cache_write_tokens: 3000,
  cache_read_tokens: 6000,
  billed_tokens: 4800,
  first_text_p50_ms: 900,
  first_text_p95_ms: 2100,
  total_p50_ms: 4000,
  total_p95_ms: 9000,
  ...over,
});

const usage = (over = {}) => ({
  days: [day(), day({ day: '2026-10-08', questions: 2, answered: 1, failed: 0, over_budget: 1, cache_read_tokens: 0 })],
  users: [],
  today: { org_billed_tokens: 1_250_000, site_billed_tokens: 4800 },
  limits: {
    question_tokens: 200_000,
    org_daily_tokens: 5_000_000,
    org_questions_per_minute: 30,
    user_questions_per_minute: 6,
    max_tokens_per_call: 2048,
    max_rounds: 8,
  },
  ...over,
});

test('totals over the days shown, with the share of input read from the cache', () => {
  assert.deepEqual(usageTotals(usage()), {
    questions: 6,
    answered: 4,
    failed: 1,
    overBudget: 1,
    billed: 9600,
    cacheShare: 6000 / (2000 + 6000 + 6000),
  });
  assert.equal(usageTotals(usage({ days: [] })).cacheShare, null);
  assert.equal(cacheShare({ input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 }), null);
  assert.equal(cacheShare({ input_tokens: 100, cache_write_tokens: 0, cache_read_tokens: 300 }), 0.75);
});

test("today's organisation budget, or none", () => {
  assert.deepEqual(budgetToday(usage()), { used: 1_250_000, limit: 5_000_000, share: 0.25 });
  const off = usage();
  off.limits.org_daily_tokens = 0;
  assert.deepEqual(budgetToday(off), { used: 1_250_000, limit: null, share: null });
  const over = usage({ today: { org_billed_tokens: 6_000_000, site_billed_tokens: 0 } });
  assert.equal(budgetToday(over).share, 1);
});

test('numbers as an admin reads them', () => {
  assert.equal(tokens(950), '950');
  assert.equal(tokens(12_345), '12.3k');
  assert.equal(tokens(999_999), '1M');
  assert.equal(tokens(4_560_000), '4.56M');
  assert.equal(duration(null), '–');
  assert.equal(duration(850.4), '850 ms');
  assert.equal(duration(2400), '2.4 s');
  assert.equal(percent(null), '–');
  assert.equal(percent(0.256), '26%');
});
