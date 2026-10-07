// Root-cause tools over process data.

import { cohensD, mean, pearson, median } from './stats.js';

// Rank variables by how strongly they separate failed (NG) from healthy rows.
// When `splitBy` is set the ranking is done per segment, which exposes
// effects that cancel out when everything is pooled.
export function correlationFinder(rows, variables, { outcome = 'ng', splitBy = null } = {}) {
  const segments = splitBy ? [...new Set(rows.map((r) => r[splitBy]))] : ['all'];
  const findings = [];
  for (const seg of segments) {
    const subset = splitBy ? rows.filter((r) => r[splitBy] === seg) : rows;
    const bad = subset.filter((r) => r[outcome]);
    const good = subset.filter((r) => !r[outcome]);
    for (const v of variables) {
      const a = bad.map((r) => r[v.key]);
      const b = good.map((r) => r[v.key]);
      findings.push({
        segment: seg,
        variable: v.key,
        label: v.label,
        unit: v.unit,
        ngMean: mean(a),
        okMean: mean(b),
        effect: cohensD(a, b),
        r: pearson(
          subset.map((r) => r[v.key]),
          subset.map((r) => (r[outcome] ? 1 : 0)),
        ),
        ngCount: a.length,
        okCount: b.length,
      });
    }
  }
  return findings.sort((x, y) => Math.abs(y.effect) - Math.abs(x.effect));
}

// Explain the top finding per segment in plain language.
export function explain(findings, { minEffect = 0.8 } = {}) {
  const bySeg = new Map();
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

// Compare the last `windowHours` of a channel with its earlier baseline.
export function wearCheck(series, channel, { until, windowHours = 24 } = {}) {
  const end = until ?? series.length;
  const recent = series.slice(Math.max(0, end - windowHours), end).map((s) => s[channel]);
  const baseline = series.slice(0, Math.max(1, end - windowHours)).map((s) => s[channel]);
  const base = median(baseline);
  const last = median(recent.slice(-4));
  return { channel, baseline: base, last, change: (last - base) / base };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const signed = (n) => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
