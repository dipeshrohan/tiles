// Minimal SVG charts. Colors come from CSS variables so charts follow the theme.

import type { SignalSeries } from './api.ts';
import { esc, fmt } from './dom.ts';

export interface Series {
  values: (number | null)[];
  color: string;
  label?: string;
  width?: number;
  dash?: string;
}

export interface Band {
  from: number;
  to: number;
  color: string;
}

export interface Marker {
  x: number;
  label: string;
  color: string;
  width?: number;
  bottom?: boolean;
}

export interface LineChartOptions {
  series: Series[];
  width?: number;
  height?: number;
  bands?: Band[];
  markers?: Marker[];
  xLabel?: string;
  yLabel?: string;
  xFormat?: (i: number) => string | number;
  yMin?: number;
  yMax?: number;
  title?: string; // what the chart shows, for screen readers (default: the y label)
}

export interface DumbbellRow {
  label: string;
  sub?: string;
  a: number;
  b: number;
}

export interface BarItem {
  label: string;
  value: number;
  color?: string;
}

export interface HeatmapOptions {
  xs: number[];
  ys: number[];
  grid: number[][];
  min: number;
  max: number;
  xLabel: string;
  yLabel: string;
  width?: number;
  height?: number;
  format?: (v: number) => string;
}

const PAD = { l: 52, r: 16, t: 24, b: 30 };

// The width to draw a chart at so that it fills `share` of the page's content width on this screen,
// with text at its normal size: never narrower than its design width (smaller screens scale it down),
// and at most three times wider. Outside a browser it is the design width.
export function fitWidth(design: number, share = 1): number {
  const main = typeof document === 'undefined' ? null : document.querySelector('main');
  if (!main) return design;
  const available = (main.clientWidth - 48) * share - 40; // the page's and a card's padding
  return Math.round(Math.min(design * 3, Math.max(design, available)));
}

function scale(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

function ticks(lo: number, hi: number, n = 5): number[] {
  const step = niceStep((hi - lo) / n);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

// The opening of a chart: an image to screen readers, named by its title and a short summary of what
// it shows (the numbers a sighted reader takes from it). In aria-label only: a <title> as well would
// be read twice, and show as a tooltip over the whole chart.
function open(width: number, height: number, title: string, summary: string, cls = 'chart'): string {
  const name = [title, summary].filter(Boolean).join('. ');
  return `<svg class="${cls}" viewBox="0 0 ${width} ${height}" style="max-width:${width * 1.5}px" role="img" aria-label="${esc(name)}">`;
}

// "a, b and c"; with more than `max`, the first ones and how many more.
export function listed(items: string[], max = 8): string {
  const shown = items.length > max ? [...items.slice(0, max), `${items.length - max} more`] : items;
  return shown.length < 2 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

// A number as a summary reads it: as many digits as its size needs, no trailing zeros.
// Below 1, three significant digits (0.000234, not 0).
const num = (x: number): string => {
  const abs = Math.abs(x);
  if (abs > 0 && abs < 1) return x.toLocaleString('en-GB', { maximumSignificantDigits: 3 });
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return x.toLocaleString('en-GB', { maximumFractionDigits: digits });
};

// The lowest and highest of some values, in one pass (no spreading: there may be many).
function extent(values: Iterable<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

// "lo to hi", or one number when they read the same.
const span = ([lo, hi]: [number, number], format = num): string => {
  if (!Number.isFinite(lo)) return 'no values';
  return format(lo) === format(hi) ? format(lo) : `${format(lo)} to ${format(hi)}`;
};
const range = (values: number[], format = num): string => span(extent(values), format);

// A time as a chart's summary gives it: UTC, to the minute.
const at = (t: number): string => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// series: [{ values: number[] (null = gap), color, label, width }]
// bands: [{ from, to, color }] in x index units; markers: [{ x, label, color }]
export function lineChart({
  series,
  width = 760,
  height = 260,
  bands = [],
  markers = [],
  xLabel = '',
  yLabel = '',
  xFormat = (i) => i,
  yMin,
  yMax,
  title = yLabel,
}: LineChartOptions): string {
  const n = Math.max(...series.map((s) => s.values.length));
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  const lo = yMin ?? Math.min(...all);
  const hi = yMax ?? Math.max(...all);
  const x = scale(0, n - 1, PAD.l, width - PAD.r);
  const y = scale(lo, hi, height - PAD.b, PAD.t);
  const yt = ticks(lo, hi, 4);
  const xt = ticks(0, n - 1, 6);
  const paths = series.map((s) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.5}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round"/>`;
  });
  const summary = [
    `${n} points${xLabel ? ` along ${xLabel}` : ''}`,
    ...series.map(
      (s, i) =>
        `${s.label ?? (series.length > 1 ? `line ${i + 1}` : 'values')} ${range(s.values.filter((v): v is number => v !== null && Number.isFinite(v)))}`,
    ),
    bands.length ? `${bands.length} shaded window${bands.length === 1 ? '' : 's'}` : '',
    markers.length ? `marked: ${listed(markers.map((m) => m.label))}` : '',
  ].filter(Boolean);
  return `${open(width, height, title, summary.join('; '))}
    ${bands.map((b) => `<rect x="${x(b.from)}" y="${PAD.t}" width="${Math.max(2, x(b.to) - x(b.from))}" height="${height - PAD.t - PAD.b}" fill="${b.color}"/>`).join('')}
    ${yt.map((t) => `<line class="grid" x1="${PAD.l}" x2="${width - PAD.r}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${PAD.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('')}
    ${xt.map((t) => `<text class="tick" x="${x(t)}" y="${height - PAD.b + 16}" text-anchor="middle">${esc(xFormat(t))}</text>`).join('')}
    ${paths.join('')}
    ${markers.map((m) => `<line x1="${x(m.x)}" x2="${x(m.x)}" y1="${PAD.t}" y2="${height - PAD.b}" stroke="${m.color}" stroke-width="${m.width ?? 2}"/><text class="tick strong" x="${x(m.x) + 4}" y="${m.bottom ? height - PAD.b - 6 : PAD.t + 10}" fill="${m.color}">${esc(m.label)}</text>`).join('')}
    ${xLabel ? `<text class="axis" x="${width - PAD.r}" y="${height - 2}" text-anchor="end">${esc(xLabel)}</text>` : ''}
    ${yLabel ? `<text class="axis" x="4" y="${PAD.t - 10}">${esc(yLabel)}</text>` : ''}
  </svg>`;
}

// rows: [{ label, sub, a, b, aLabel, bLabel }] — dot "a" (failed) vs "b" (target).
export function dumbbell({
  rows,
  width = 620,
  rowH = 64,
  domain,
  xLabel = '',
  left = 240,
}: {
  rows: DumbbellRow[];
  width?: number;
  rowH?: number;
  domain: [number, number];
  xLabel?: string;
  left?: number;
}): string {
  const height = rows.length * rowH + 44;
  const summary = listed(rows.map((r) => `${r.label}: ${fmt(r.a)} against ${fmt(r.b)}`));
  const x = scale(domain[0], domain[1], left, width - 20);
  const xt = ticks(domain[0], domain[1], 6);
  return `${open(width, height, xLabel, summary)}
    ${xt.map((t) => `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="8" y2="${height - 30}"/><text class="tick" x="${x(t)}" y="${height - 16}" text-anchor="middle">${fmt(t)}</text>`).join('')}
    ${rows
      .map((r, i) => {
        const cy = 30 + i * rowH;
        return `<text class="label" x="${left - 14}" y="${cy + 4}" text-anchor="end">${esc(r.label)}</text>
        <text class="tick" x="${left - 14}" y="${cy + 20}" text-anchor="end">${esc(r.sub ?? '')}</text>
        <line x1="${x(r.a)}" x2="${x(r.b)}" y1="${cy}" y2="${cy}" stroke="var(--line-strong)" stroke-width="5" stroke-linecap="round"/>
        <circle cx="${x(r.b)}" cy="${cy}" r="8" fill="var(--muted)"/>
        <circle cx="${x(r.a)}" cy="${cy}" r="8" fill="var(--bad)"/>
        <text class="tick strong" x="${x(r.a)}" y="${cy - 14}" text-anchor="middle" fill="var(--bad)">${fmt(r.a)}</text>
        <text class="tick" x="${x(r.b)}" y="${cy - 14}" text-anchor="middle">${fmt(r.b)}</text>`;
      })
      .join('')}
    <text class="axis" x="${(left + width) / 2}" y="${height - 2}" text-anchor="middle">${esc(xLabel)}</text>
  </svg>`;
}

// items: [{ label, value, color }] — horizontal bars from zero (supports negatives).
export function hbars({
  items,
  width = 520,
  rowH = 28,
  format = (v: number) => fmt(v, 2),
  left = 190,
  title = 'Bar chart',
}: {
  items: BarItem[];
  width?: number;
  rowH?: number;
  format?: (v: number) => string;
  left?: number;
  title?: string;
}): string {
  const height = items.length * rowH + 10;
  const maxAbs = Math.max(...items.map((i) => Math.abs(i.value)), 1e-9);
  const hasNeg = items.some((i) => i.value < 0);
  const x = scale(hasNeg ? -maxAbs : 0, maxAbs, left, width - 60);
  const zero = x(0);
  return `${open(width, height, title, listed(items.map((it) => `${it.label} ${format(it.value)}`)))}
    <line class="grid" x1="${zero}" x2="${zero}" y1="0" y2="${height}"/>
    ${items
      .map((it, i) => {
        const cy = 6 + i * rowH;
        const x1 = Math.min(zero, x(it.value));
        const w = Math.abs(x(it.value) - zero);
        return `<text class="label" x="${left - 10}" y="${cy + 15}" text-anchor="end">${esc(it.label)}</text>
        <rect x="${x1}" y="${cy + 3}" width="${Math.max(1, w)}" height="${rowH - 10}" rx="3" fill="${it.color ?? 'var(--accent)'}"/>
        <text class="tick" x="${Math.max(x(it.value), zero) + 6}" y="${cy + 15}">${esc(format(it.value))}</text>`;
      })
      .join('')}
  </svg>`;
}

// Sequential heatmap for a 2D sweep; low = light, high = accent.
export function heatmap({
  xs,
  ys,
  grid,
  min,
  max,
  xLabel,
  yLabel,
  width = 480,
  height = 360,
  format = (v: number) => fmt(v, 2),
}: HeatmapOptions): string {
  const left = 56;
  const bottom = 40;
  const cw = (width - left - 10) / xs.length;
  const ch = (height - bottom - 10) / ys.length;
  const t = (v: number) => (v - min) / (max - min || 1);
  const cells: string[] = [];
  ys.forEach((yv, j) => {
    xs.forEach((xv, i) => {
      const v = grid[j]?.[i] ?? NaN;
      cells.push(
        `<rect x="${left + i * cw}" y="${10 + (ys.length - 1 - j) * ch}" width="${cw + 0.5}" height="${ch + 0.5}" fill="var(--accent)" fill-opacity="${(0.08 + 0.92 * t(v)).toFixed(3)}"><title>${esc(xLabel)} ${fmt(xv, 1)}, ${esc(yLabel)} ${fmt(yv, 1)} → ${format(v)}</title></rect>`,
      );
    });
  });
  const xi = [0, Math.floor(xs.length / 2), xs.length - 1];
  const yi = [0, Math.floor(ys.length / 2), ys.length - 1];
  // The lowest and highest cells, as a reader would look for them.
  let lowest = { v: Infinity, x: NaN, y: NaN };
  let highest = { v: -Infinity, x: NaN, y: NaN };
  ys.forEach((yv, j) =>
    xs.forEach((xv, i) => {
      const v = grid[j]?.[i] ?? NaN;
      if (v < lowest.v) lowest = { v, x: xv, y: yv };
      if (v > highest.v) highest = { v, x: xv, y: yv };
    }),
  );
  const cell = (c: typeof lowest) => `${format(c.v)} at ${xLabel} ${fmt(c.x, 1)}, ${yLabel} ${fmt(c.y, 1)}`;
  const summary = Number.isFinite(lowest.v)
    ? `${xs.length} × ${ys.length} grid of ${xLabel} by ${yLabel}; lowest ${cell(lowest)}; highest ${cell(highest)}`
    : 'no values';
  return `${open(width, height, 'Parameter sweep', summary)}
    ${cells.join('')}
    ${xi.map((i) => `<text class="tick" x="${left + (i + 0.5) * cw}" y="${height - bottom + 16}" text-anchor="middle">${fmt(xs[i] ?? NaN, 1)}</text>`).join('')}
    ${yi.map((j) => `<text class="tick" x="${left - 6}" y="${10 + (ys.length - 1 - j + 0.5) * ch + 4}" text-anchor="end">${fmt(ys[j] ?? NaN, 1)}</text>`).join('')}
    <text class="axis" x="${left + (width - left) / 2}" y="${height - 6}" text-anchor="middle">${esc(xLabel)}</text>
    <text class="axis" x="12" y="${10 + (height - bottom) / 2}" transform="rotate(-90 12 ${10 + (height - bottom) / 2})" text-anchor="middle">${esc(yLabel)}</text>
  </svg>`;
}

// ---- time series (Data Explorer) ------------------------------------------

// A point at time `t` (ms since 1970); `lo`/`hi` are a bucket's minimum and maximum.
export interface TimePoint {
  t: number;
  v: number;
  lo: number;
  hi: number;
}

export interface TimeChartOptions {
  points: TimePoint[];
  from: number; // the x axis, ms since 1970
  to: number;
  gap: number; // points further apart than this (ms) are not joined
  color?: string;
  width?: number;
  height?: number;
  yLabel?: string;
  levels?: { v: number; label: string }[]; // reference lines (a threshold, a baseline), kept in view
  spans?: { from: number; to: number }[]; // stretches of time to shade (a warning)
  title?: string; // what the chart shows, for screen readers (default: the y label)
}

export const TIME_CHART = { width: 900, height: 220, pad: PAD };

// The numeric points to plot (text readings are listed, not plotted).
export function toPoints(series: SignalSeries): TimePoint[] {
  return series.points
    .filter((p) => p.value !== null)
    .map((p) => ({ t: Date.parse(p.at), v: p.value!, lo: p.min ?? p.value!, hi: p.max ?? p.value! }));
}

// How far apart two points may be and still be joined: one and a half buckets, or five of the usual steps.
export function gapFor(series: SignalSeries, points: TimePoint[]): number {
  if (series.bucket_s !== null) return series.bucket_s * 1500;
  const steps = points
    .slice(1)
    .map((p, i) => p.t - points[i]!.t)
    .sort((a, b) => a - b);
  const median = steps[Math.floor((steps.length - 1) / 2)];
  return median === undefined ? Infinity : Math.max(1, median * 5);
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STEPS = [
  SECOND,
  5 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
  91 * DAY,
  182 * DAY,
  365 * DAY,
];

// About `n` tick times between from and to, on round local times (whole minutes, hours, days).
export function timeTicks(from: number, to: number, n = 6): { step: number; ticks: number[] } {
  const step = STEPS.find((s) => (to - from) / s <= n) ?? STEPS[STEPS.length - 1]!;
  const ticks: number[] = [];
  if (step >= 30 * DAY) {
    // Months, quarters, half-years and years start on the 1st of a calendar month.
    const months = Math.round(step / (30.4 * DAY));
    const d = new Date(from);
    const first = new Date(d.getFullYear(), d.getMonth() - (d.getMonth() % months), 1);
    for (let i = 0; ; i += months) {
      const t = new Date(first.getFullYear(), first.getMonth() + i, 1).getTime();
      if (t > to) break;
      if (t >= from) ticks.push(t);
    }
    return { step, ticks };
  }
  // Align to local time, so hour and day ticks fall on the hour and at midnight, also after a
  // daylight-saving change within the range (each tick moves by the change in offset since `from`).
  const offset = new Date(from).getTimezoneOffset() * MINUTE;
  for (let t = Math.ceil((from - offset) / step) * step + offset; t <= to; t += step) {
    const shifted = step >= HOUR ? t + new Date(t).getTimezoneOffset() * MINUTE - offset : t;
    if (shifted >= from && shifted <= to) ticks.push(shifted);
  }
  return { step, ticks };
}

export function tickLabel(t: number, step: number): string {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, '0');
  const time = `${two(d.getHours())}:${two(d.getMinutes())}${step < MINUTE ? `:${two(d.getSeconds())}` : ''}`;
  if (step >= 365 * DAY) return String(d.getFullYear());
  if (step >= 30 * DAY) return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (step >= DAY) return date;
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 ? date : time;
}

// The time under x (in chart units), kept within the axis.
export function timeAt(x: number, from: number, to: number, width = TIME_CHART.width): number {
  const left = PAD.l;
  const right = width - PAD.r;
  const share = Math.min(1, Math.max(0, (x - left) / (right - left)));
  return from + share * (to - from);
}

export function timeChart({
  points,
  from,
  to,
  gap,
  color = 'var(--accent)',
  width = TIME_CHART.width,
  height = TIME_CHART.height,
  yLabel = '',
  levels = [],
  spans = [],
  title = yLabel,
}: TimeChartOptions): string {
  const shown = points.filter((p) => p.t >= from && p.t <= to);
  const when = `from ${at(from)} to ${at(to)}`;
  if (!shown.length)
    return `${open(width, height, title, `No readings ${when}`)}<text class="axis" x="${width / 2}" y="${height / 2}" text-anchor="middle">No readings in this range</text></svg>`;
  const marks = levels.filter((l) => Number.isFinite(l.v)).map((l) => l.v);
  const [dataLo] = extent(shown.map((p) => p.lo));
  const [, dataHi] = extent(shown.map((p) => p.hi));
  let lo = Math.min(dataLo, ...marks);
  let hi = Math.max(dataHi, ...marks);
  if (lo === hi) [lo, hi] = [lo - 1, hi + 1];
  const x = scale(from, to, PAD.l, width - PAD.r);
  const y = scale(lo, hi, height - PAD.b, PAD.t);
  // Runs of points close enough to join.
  const runs: TimePoint[][] = [];
  shown.forEach((p, i) => {
    const prev = shown[i - 1];
    if (!prev || p.t - prev.t > gap) runs.push([p]);
    else runs[runs.length - 1]!.push(p);
  });
  const xy = (t: number, v: number) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`;
  const band = runs
    .filter((r) => r.some((p) => p.hi > p.lo))
    .map(
      (r) =>
        `<path d="M${r.map((p) => xy(p.t, p.hi)).join('L')}L${[...r]
          .reverse()
          .map((p) => xy(p.t, p.lo))
          .join('L')}Z" fill="${color}" fill-opacity="0.18" stroke="none"/>`,
    )
    .join('');
  const lines = runs
    .map((r) =>
      r.length === 1
        ? `<circle cx="${x(r[0]!.t).toFixed(1)}" cy="${y(r[0]!.v).toFixed(1)}" r="2" fill="${color}"/>`
        : `<path d="M${r.map((p) => xy(p.t, p.v)).join('L')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`,
    )
    .join('');
  const yt = ticks(lo, hi, 4);
  const { step, ticks: xt } = timeTicks(from, to);
  const shade = spans
    .map((s) => [Math.max(s.from, from), Math.min(s.to, to)] as const)
    .filter(([a, b]) => b >= a)
    .map(([a, b]) => {
      const w = Math.max(2, x(b) - x(a));
      return `<rect class="span" x="${x(a).toFixed(1)}" y="${PAD.t}" width="${w.toFixed(1)}" height="${height - PAD.b - PAD.t}"/>`;
    })
    .join('');
  // Each label sits just above its line; one too close to the label above it goes below its line.
  let lastLabel = -Infinity;
  const refs = levels
    .filter((l) => Number.isFinite(l.v))
    .map((l) => ({ ...l, at: y(l.v) }))
    .sort((a, b) => a.at - b.at)
    .map((l) => {
      const above = l.at - 4;
      const labelY = above - lastLabel < 12 ? l.at + 12 : above;
      lastLabel = labelY;
      return `<line class="level" x1="${PAD.l}" x2="${width - PAD.r}" y1="${l.at.toFixed(1)}" y2="${l.at.toFixed(1)}"/><text class="axis" x="${width - PAD.r}" y="${labelY.toFixed(1)}" text-anchor="end">${esc(l.label)}</text>`;
    })
    .join('');
  const last = shown[shown.length - 1]!;
  const summary = [
    `${shown.length} reading${shown.length === 1 ? '' : 's'} ${when}`,
    `values ${span([dataLo, dataHi])}`,
    `latest ${num(last.v)} at ${at(last.t)}`,
    ...levels.filter((l) => Number.isFinite(l.v)).map((l) => `${l.label} ${num(l.v)}`),
    spans.length ? `${spans.length} shaded stretch${spans.length === 1 ? '' : 'es'}` : '',
  ].filter(Boolean);
  return `${open(width, height, title, summary.join('; '))}
    ${yt.map((t) => `<line class="grid" x1="${PAD.l}" x2="${width - PAD.r}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${PAD.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t, Math.abs(hi - lo) < 10 ? 2 : 0)}</text>`).join('')}
    ${xt.map((t) => `<text class="tick" x="${x(t)}" y="${height - PAD.b + 16}" text-anchor="middle">${esc(tickLabel(t, step))}</text>`).join('')}
    ${shade}${band}${lines}${refs}
    ${yLabel ? `<text class="axis" x="4" y="${PAD.t - 10}">${esc(yLabel)}</text>` : ''}
  </svg>`;
}
