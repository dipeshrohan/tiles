// The copilot's usage dashboard (T4.07), pure: totals over the days shown, the share of the
// prompt read from the cache, and numbers as an admin reads them.
import type { CopilotUsage } from './api.ts';

export interface UsageTotals {
  questions: number;
  answered: number;
  failed: number;
  overBudget: number;
  billed: number;
  cacheShare: number | null; // of all input tokens, the share read from the cache
}

// The share of a prompt read from the cache: cache reads over every input token (uncached, written
// to the cache, read from it). Null with no input.
export function cacheShare(d: {
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
}): number | null {
  const all = d.input_tokens + d.cache_write_tokens + d.cache_read_tokens;
  return all ? d.cache_read_tokens / all : null;
}

export function usageTotals(u: CopilotUsage): UsageTotals {
  const sum = (k: 'questions' | 'answered' | 'failed' | 'over_budget' | 'billed_tokens') =>
    u.days.reduce((n, d) => n + d[k], 0);
  const tokens = (k: 'input_tokens' | 'cache_write_tokens' | 'cache_read_tokens') =>
    u.days.reduce((n, d) => n + d[k], 0);
  return {
    questions: sum('questions'),
    answered: sum('answered'),
    failed: sum('failed'),
    overBudget: sum('over_budget'),
    billed: sum('billed_tokens'),
    cacheShare: cacheShare({
      input_tokens: tokens('input_tokens'),
      cache_write_tokens: tokens('cache_write_tokens'),
      cache_read_tokens: tokens('cache_read_tokens'),
    }),
  };
}

// Today's organisation budget: what is used, of how much (null: no daily limit).
export function budgetToday(u: CopilotUsage): { used: number; limit: number | null; share: number | null } {
  const limit = u.limits.org_daily_tokens || null;
  const used = u.today.org_billed_tokens;
  return { used, limit, share: limit ? Math.min(1, used / limit) : null };
}

// 950, 12.3k, 4.56M.
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  const k = +(n / 1000).toPrecision(3);
  return k < 1000 ? `${k}k` : `${+(n / 1_000_000).toPrecision(3)}M`;
}

// 850 ms, 2.4 s; a dash for none.
export function duration(ms: number | null): string {
  if (ms === null) return '–';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${+(ms / 1000).toFixed(1)} s`;
}

export const percent = (share: number | null): string => (share === null ? '–' : `${Math.round(share * 100)}%`);
