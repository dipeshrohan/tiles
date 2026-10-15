// Charts v2 (U5.03): what a chart in js/lib/svg.ts shows, kept for reading it point by point (a
// crosshair under the pointer or a finger, the arrow keys) and for exporting it. The charts stay
// plain SVG strings: each registers its data here under an id made from the data itself, and carries
// it as `data-chart`; js/lib/charts.ts reads it back when someone points at, touches or focuses the
// chart. Pure: no DOM.

export interface ChartSeries {
  name: string; // in the readout and the legend: "Readings", "Front stock tension"
  ys: (number | null)[]; // where each point is drawn, in the chart's own units (null: none)
  text: string[]; // each point's value as read out: "1,820 bar (min 1,700, max 1,900)"
}

export interface ChartData {
  title: string; // the chart's name, for the file it is saved as
  xs: number[]; // where each point is, across the chart (its own units), ascending
  labels: string[]; // each point's x as read out: "14 Oct 2026, 14:32:05"
  series: ChartSeries[];
  top: number; // the plot area, in the chart's units
  bottom: number;
  csv: { head: string[]; rows: (string | number)[][] }; // the data behind it, for export
}

const MAX = 300; // charts kept (the most recently drawn): plenty for any page
const registry = new Map<string, ChartData>();

// An id from the data (FNV-1a over its numbers and labels): the same chart drawn again gets the
// same id, so a page drawn again in place keeps its charts as they were.
export function chartId(d: ChartData): string {
  let h = 0x811c9dc5;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(d.title);
  mix(String(d.xs.length));
  for (let i = 0; i < d.xs.length; i += Math.max(1, Math.floor(d.xs.length / 64))) mix(`${d.xs[i]}|${d.labels[i]}`);
  for (const s of d.series) {
    mix(s.name);
    for (let i = 0; i < s.text.length; i += Math.max(1, Math.floor(s.text.length / 64))) mix(s.text[i] ?? '');
  }
  mix(String(d.xs.at(-1)));
  return `c${(h >>> 0).toString(36)}`;
}

export function registerChart(d: ChartData): string {
  const id = chartId(d);
  registry.delete(id); // most recent last
  registry.set(id, d);
  while (registry.size > MAX) registry.delete(registry.keys().next().value as string);
  return id;
}

export const chartData = (id: string): ChartData | undefined => registry.get(id);

// The point nearest to x (the chart's units), among those with a value in a shown series.
export function nearest(d: ChartData, x: number, shown: (k: number) => boolean = () => true): number | null {
  const has = (i: number) => d.series.some((s, k) => shown(k) && s.ys[i] !== null && s.ys[i] !== undefined);
  // Where x falls (binary search), then outwards on both sides until neither side can be nearer.
  let lo = 0;
  let hi = d.xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((d.xs[mid] ?? 0) < x) lo = mid + 1;
    else hi = mid;
  }
  let left = lo - 1;
  let right = lo;
  let best: number | null = null;
  let gap = Infinity;
  while (left >= 0 || right < d.xs.length) {
    const l = left >= 0 ? Math.abs(x - (d.xs[left] ?? 0)) : Infinity;
    const r = right < d.xs.length ? Math.abs((d.xs[right] ?? 0) - x) : Infinity;
    if (Math.min(l, r) > gap) break;
    if (l <= r) {
      if (has(left) && l < gap) [best, gap] = [left, l];
      left--;
    } else {
      if (has(right) && r < gap) [best, gap] = [right, r];
      right++;
    }
  }
  return best;
}

// The next point with a value, `by` points on (a page of points with PageUp/PageDown), held at the ends.
export function step(d: ChartData, from: number, by: number, shown: (i: number) => boolean = () => true): number {
  const has = (i: number) => d.series.some((s, k) => shown(k) && s.ys[i] !== null && s.ys[i] !== undefined);
  const dir = Math.sign(by) || 1;
  let i = from;
  let moved = 0;
  for (let j = from + dir; j >= 0 && j < d.xs.length && moved < Math.abs(by); j += dir)
    if (has(j)) {
      i = j;
      moved++;
    }
  return i;
}

// What is read out at a point: its x, then each shown series' value there.
export function readout(d: ChartData, i: number, shown: (i: number) => boolean = () => true): string {
  const values = d.series
    .map((s, k) => (shown(k) && s.ys[i] !== null && s.ys[i] !== undefined ? `${s.name}: ${s.text[i] ?? ''}` : ''))
    .filter(Boolean);
  return `${d.labels[i] ?? ''}${values.length ? `. ${values.join('; ')}` : ''}`;
}

// The data as CSV (RFC 4180; a value starting =, +, - or @ is kept from running as a formula).
export function chartCsv(d: ChartData): string {
  const field = (v: string | number): string => {
    const s = typeof v === 'number' ? String(v) : /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${[d.csv.head, ...d.csv.rows].map((r) => r.map(field).join(',')).join('\r\n')}\r\n`;
}

// A file name from the chart's title: "plunger-friction-dc-02".
export const fileName = (title: string, ext: string): string =>
  `${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'chart'
  }.${ext}`;

// Parts of a chart someone hid with its legend ("line", "band", "s1"…), kept while the page shows it
// so a chart drawn again stays as they left it.
const hidden = new Map<string, Set<string>>();
export const hiddenParts = (id: string): Set<string> => hidden.get(id) ?? new Set();
export function togglePart(id: string, part: string): boolean {
  const set = new Set(hiddenParts(id));
  const off = !set.delete(part);
  if (off) set.add(part);
  hidden.set(id, set);
  return off;
}
