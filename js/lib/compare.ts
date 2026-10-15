// Compare mode (U5.09): two time ranges of one signal, or two signals over one range, on one chart
// and with their difference. Two ranges are shift-aligned: each point is placed by the time since
// its range began, so last week's Monday lies under this week's. Pure, so it is unit-tested; the
// Data explorer draws the result with lineChart.

export type Against = 'before' | 'day' | 'week' | 'custom';
export const AGAINST: Readonly<Record<Against, string>> = {
  before: 'The period just before',
  day: 'The same time a day earlier',
  week: 'The same time a week earlier',
  custom: 'From a start you choose',
};

const DAY = 86_400_000;

export interface Span {
  from: number; // ms; `to` is excluded
  to: number;
}

// The range compared with `range`: as long, starting earlier (or at `start`, for custom).
export function otherRange(range: Span, against: Against, start: number | null = null): Span {
  const length = range.to - range.from;
  const from =
    against === 'before'
      ? range.from - length
      : against === 'day'
        ? range.from - DAY
        : against === 'week'
          ? range.from - 7 * DAY
          : (start ?? range.from - length);
  return { from, to: from + length };
}

export interface Reading {
  t: number; // ms
  v: number;
}

// Each reading's mean per bucket: `buckets` equal parts of `span`, null where none fell.
export function bucketMeans(readings: readonly Reading[], span: Span, buckets: number): (number | null)[] {
  const sum = new Array<number>(buckets).fill(0);
  const count = new Array<number>(buckets).fill(0);
  const width = (span.to - span.from) / buckets;
  if (!(width > 0)) return new Array<null>(buckets).fill(null);
  for (const r of readings) {
    const i = Math.floor((r.t - span.from) / width);
    if (i < 0 || i >= buckets || !Number.isFinite(r.v)) continue;
    sum[i] = (sum[i] ?? 0) + r.v;
    count[i] = (count[i] ?? 0) + 1;
  }
  return sum.map((s, i) => ((count[i] ?? 0) ? s / (count[i] ?? 1) : null));
}

export interface Aligned {
  a: (number | null)[];
  b: (number | null)[];
  diff: (number | null)[]; // b − a where both have a value
  width: number; // ms per bucket
}

// Two series on one grid of `buckets`: each by the time since its own span began (two ranges), or
// on the same span (two signals: pass it twice).
export function align(
  a: readonly Reading[],
  aSpan: Span,
  b: readonly Reading[],
  bSpan: Span,
  buckets: number,
): Aligned {
  const am = bucketMeans(a, aSpan, buckets);
  const bm = bucketMeans(b, bSpan, buckets);
  return {
    a: am,
    b: bm,
    diff: am.map((x, i) => {
      const y = bm[i];
      return x === null || y === null || y === undefined ? null : y - x;
    }),
    width: (aSpan.to - aSpan.from) / buckets,
  };
}

export interface Summary {
  meanA: number | null;
  meanB: number | null;
  diff: number | null; // meanB − meanA, over the buckets both have
  pct: number | null; // the difference as a share of meanA (null when meanA is 0)
  shared: number; // buckets with both
}

// The means over the buckets where both have a value (so a gap in one doesn't tilt it).
export function summarise(x: Aligned): Summary {
  let sa = 0;
  let sb = 0;
  let n = 0;
  x.a.forEach((v, i) => {
    const w = x.b[i];
    if (v === null || w === null || w === undefined) return;
    sa += v;
    sb += w;
    n++;
  });
  if (!n) return { meanA: null, meanB: null, diff: null, pct: null, shared: 0 };
  const meanA = sa / n;
  const meanB = sb / n;
  const diff = meanB - meanA;
  return { meanA, meanB, diff, pct: meanA === 0 ? null : (diff / Math.abs(meanA)) * 100, shared: n };
}

// How far into the range a bucket is, for the shared axis: "+2 h 30 min", "+3 d".
export function offsetLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `+${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `+${hours} h ${minutes % 60} min` : `+${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `+${days} d ${hours % 24} h` : `+${days} d`;
}
