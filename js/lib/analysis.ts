// Root-cause tools over process data.

import { cohensD, mean, pearson, median } from './stats.ts';
import type { Variable } from './types.ts';

// Rows are plain records; fields are looked up by name.
const field = (row: object, key: string): unknown => (row as Record<string, unknown>)[key];

export interface Finding {
  segment: string;
  variable: string;
  label: string;
  unit: string;
  ngMean: number;
  okMean: number;
  effect: number;
  r: number;
  ngCount: number;
  okCount: number;
}

export interface Explanation extends Finding {
  direction: 'high' | 'low';
  delta: number;
  text: string;
}

const num = (row: object, key: string): number => Number(field(row, key));

// Rank variables by how strongly they separate failed (NG) from healthy rows.
// When `splitBy` is set the ranking is done per segment, which exposes
// effects that cancel out when everything is pooled.
export function correlationFinder<R extends object>(
  rows: readonly R[],
  variables: readonly Variable[],
  { outcome = 'ng', splitBy = null }: { outcome?: string; splitBy?: string | null } = {},
): Finding[] {
  const segments = splitBy ? [...new Set(rows.map((r) => String(field(r, splitBy))))] : ['all'];
  const findings: Finding[] = [];
  for (const seg of segments) {
    const subset = splitBy ? rows.filter((r) => String(field(r, splitBy)) === seg) : rows;
    const bad = subset.filter((r) => field(r, outcome));
    const good = subset.filter((r) => !field(r, outcome));
    for (const v of variables) {
      const a = bad.map((r) => num(r, v.key));
      const b = good.map((r) => num(r, v.key));
      findings.push({
        segment: seg,
        variable: v.key,
        label: v.label,
        unit: v.unit,
        ngMean: mean(a),
        okMean: mean(b),
        effect: cohensD(a, b),
        r: pearson(
          subset.map((r) => num(r, v.key)),
          subset.map((r) => (field(r, outcome) ? 1 : 0)),
        ),
        ngCount: a.length,
        okCount: b.length,
      });
    }
  }
  return findings.sort((x, y) => Math.abs(y.effect) - Math.abs(x.effect));
}

// Explain the top finding per segment in plain language.
export function explain(findings: readonly Finding[], { minEffect = 0.8 } = {}): Explanation[] {
  const bySeg = new Map<string, Finding>();
  for (const f of findings) if (!bySeg.has(f.segment)) bySeg.set(f.segment, f);
  return [...bySeg.values()]
    .filter((f) => Math.abs(f.effect) >= minEffect)
    .map((f) => ({
      ...f,
      direction: f.ngMean > f.okMean ? 'high' : 'low',
      delta: f.ngMean - f.okMean,
      text: `${cap(f.segment)}: failed batches ran ${f.label.toLowerCase()} ${f.ngMean > f.okMean ? 'too high' : 'too low'} (${fmt(f.ngMean)} vs ${fmt(f.okMean)} healthy, ${signed(f.ngMean - f.okMean)} ${f.unit}).`,
    }));
}

export interface WearResult {
  channel: string;
  baseline: number;
  last: number;
  change: number;
}

// Compare the last `windowHours` of a channel with its earlier baseline.
export function wearCheck<K extends string>(
  series: readonly Record<K, number>[],
  channel: K,
  { until, windowHours = 24 }: { until?: number; windowHours?: number } = {},
): WearResult {
  const end = until ?? series.length;
  const recent = series.slice(Math.max(0, end - windowHours), end).map((s) => s[channel]);
  const baseline = series.slice(0, Math.max(1, end - windowHours)).map((s) => s[channel]);
  const base = median(baseline);
  const last = median(recent.slice(-4));
  return { channel, baseline: base, last, change: (last - base) / base };
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
const signed = (n: number): string => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
