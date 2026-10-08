import { esc, field, fmt, onAll } from '../lib/dom.ts';
import type { SignalInfo, SignalSeries } from '../lib/api.ts';
import { fitWidth, TIME_CHART, timeAt, timeChart, type TimePoint } from '../lib/svg.ts';
import { catalogue } from './signals.ts';
import type { Context, View } from './types.ts';

// Data Explorer (T2.10): plot any of the site's signals over a time range. The API downsamples
// long ranges into buckets (average, minimum and maximum), so a year plots as fast as an hour;
// drag across a chart to zoom in.

const MAX_SIGNALS = 8;
const POINTS = 900; // about one per pixel of a chart
const HOUR = 3_600_000;
const PRESETS = { '1h': HOUR, '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR } as const;
type Preset = keyof typeof PRESETS | 'data';

export interface Picked {
  id: string;
  tag: string;
  unit: string | null;
  last_at: string | null;
}

export interface Range {
  from: string; // ISO times; `to` is excluded
  to: string;
}

interface Ui {
  picked: Picked[];
  range: Range | null;
  catalogue: string; // the catalogue `picked` belongs to
}

const ui = (ctx: Context): Ui => ctx.ui<Ui>('explorer', { picked: [], range: null, catalogue: '' });

let latestLoad = 0; // charts from an earlier load are dropped
let latestFind = 0;
let findTimer: ReturnType<typeof setTimeout> | undefined;

const iso = (t: number) => new Date(t).toISOString();

// A preset range: the last hour, day, week or month, or the day up to the latest reading picked.
export function presetRange(preset: Preset, picked: Picked[], now: number): Range {
  if (preset !== 'data') return { from: iso(now - PRESETS[preset]), to: iso(now) };
  const last = Math.max(...picked.map((p) => (p.last_at ? Date.parse(p.last_at) : -Infinity)));
  const end = Number.isFinite(last) ? last + 1 : now; // `to` is excluded
  return { from: iso(end - PRESETS['24h']), to: iso(end) };
}

// Twice as long, around the same middle.
export function zoomOut(range: Range): Range {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const half = to - from;
  return { from: iso(from - half / 2), to: iso(to + half / 2) };
}

// Half a range earlier (-1) or later (+1).
export function pan(range: Range, direction: -1 | 1): Range {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const shift = ((to - from) / 2) * direction;
  return { from: iso(from + shift), to: iso(to + shift) };
}

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

function duration(seconds: number): string {
  if (seconds < 60) return `${+seconds.toPrecision(3)} s`;
  if (seconds < 3600) return `${+(seconds / 60).toPrecision(3)} min`;
  if (seconds < 48 * 3600) return `${+(seconds / 3600).toPrecision(3)} h`;
  return `${+(seconds / 86400).toPrecision(3)} d`;
}

export function describe(series: SignalSeries): string {
  const readings = series.points.reduce((n, p) => n + p.n, 0);
  if (!readings) return 'No readings in this range';
  return series.bucket_s === null
    ? `${fmt(readings, 0)} reading(s)`
    : `${fmt(readings, 0)} readings, as ${fmt(series.points.length, 0)} averages of ${duration(series.bucket_s)} with their range`;
}

function textReadings(series: SignalSeries): string {
  const texts = series.points.filter((p) => p.text !== null).slice(-20);
  if (!texts.length) return '';
  return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Value</th></tr></thead><tbody>${texts
    .map((p) => `<tr><td>${esc(new Date(p.at).toLocaleString('en-GB'))}</td><td>${esc(p.text ?? '')}</td></tr>`)
    .join('')}</tbody></table></div><p class="small soft">The latest ${texts.length} text value(s) in the range.</p>`;
}

function chartFor(series: SignalSeries, range: Range): string {
  const points = toPoints(series);
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const chart =
    points.length || !series.points.length
      ? timeChart({
          points,
          from,
          to,
          gap: gapFor(series, points),
          yLabel: series.unit ?? '',
          width: fitWidth(TIME_CHART.width),
        })
      : '';
  return `<div class="explorer-chart" data-zoom>${chart}<div class="zoom-box" hidden></div></div>
    ${textReadings(series)}
    <p class="small soft" data-series-note>${esc(describe(series))}</p>`;
}

const localInput = (isoTime: string): string => {
  const d = new Date(isoTime);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};

function setRange(ctx: Context, range: Range): void {
  ui(ctx).range = range;
  ctx.rerender();
}

function add(ctx: Context, s: Pick<SignalInfo, 'id' | 'tag' | 'unit' | 'last_at'>): void {
  const u = ui(ctx);
  if (u.picked.some((p) => p.id === s.id)) return;
  if (u.picked.length >= MAX_SIGNALS) {
    ctx.toast(`Plot at most ${MAX_SIGNALS} signals at once; remove one first`);
    return;
  }
  u.picked = [...u.picked, { id: s.id, tag: s.tag, unit: s.unit, last_at: s.last_at }];
  u.range ??= presetRange('data', u.picked, Date.now());
  ctx.rerender();
}

function loadCharts(root: HTMLElement, ctx: Context): void {
  const site = ctx.ontology.site;
  const { picked, range } = ui(ctx);
  if (!ctx.api || !site || !range) return;
  const mine = ++latestLoad;
  for (const p of picked) {
    const box = root.querySelector<HTMLElement>(`[data-chart="${CSS.escape(p.id)}"]`);
    ctx.api.signals.series(site.id, p.id, range.from, range.to, POINTS).then(
      (series) => {
        if (mine !== latestLoad || !box?.isConnected) return;
        box.innerHTML = chartFor(series, range);
        bindZoom(box, ctx, range);
      },
      () => {
        if (mine === latestLoad && box?.isConnected)
          box.innerHTML = '<p class="small soft">The readings could not be loaded.</p>';
      },
    );
  }
}

// Drag across a chart to zoom into that stretch of time.
function bindZoom(box: HTMLElement, ctx: Context, range: Range): void {
  const area = box.querySelector<HTMLElement>('[data-zoom]');
  const svg = area?.querySelector('svg');
  const marker = area?.querySelector<HTMLElement>('.zoom-box');
  if (!area || !svg || !marker) return;
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const width = svg.viewBox.baseVal.width; // the chart is drawn to the page's width (fitWidth)
  const units = (clientX: number) => {
    const rect = svg.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * width;
  };
  let start: number | null = null;
  area.addEventListener('pointerdown', (e) => {
    start = e.clientX;
    area.setPointerCapture(e.pointerId);
  });
  area.addEventListener('pointermove', (e) => {
    if (start === null) return;
    const rect = area.getBoundingClientRect();
    marker.hidden = false;
    marker.style.left = `${Math.min(start, e.clientX) - rect.left}px`;
    marker.style.width = `${Math.abs(e.clientX - start)}px`;
  });
  area.addEventListener('pointerup', (e) => {
    if (start === null) return;
    const [a, b] = [units(start), units(e.clientX)].sort((p, q) => p - q) as [number, number];
    start = null;
    marker.hidden = true;
    if (b - a < 8) return; // a click, not a drag
    const t0 = timeAt(a, from, to, width);
    const t1 = timeAt(b, from, to);
    if (t1 - t0 >= 1) setRange(ctx, { from: iso(t0), to: iso(t1) });
  });
}

function bindSearch(root: HTMLElement, ctx: Context): void {
  const input = root.querySelector<HTMLInputElement>('#explorer-search [name=q]');
  const list = root.querySelector<HTMLElement>('[data-explorer-found]');
  if (!input || !list) return;
  const find = async () => {
    const site = ctx.ontology.site;
    if (!ctx.api || !site || !root.querySelector('#explorer-search')) return; // the page was left
    const mine = ++latestFind;
    let found: SignalInfo[] = [];
    try {
      found = (await ctx.api.signals.list(site.id, { q: input.value, limit: 8 })).signals;
    } catch {
      // the client showed why
    }
    if (mine !== latestFind || !list.isConnected) return;
    const picked = new Set(ui(ctx).picked.map((p) => p.id));
    const choices = found.filter((s) => !picked.has(s.id));
    list.innerHTML = choices.length
      ? choices
          .map(
            (s) =>
              `<button class="btn sm" type="button" data-add="${esc(s.id)}">+ ${esc(s.tag)}${s.unit ? ` <span class="soft">${esc(s.unit)}</span>` : ''}</button>`,
          )
          .join('')
      : '<span class="small soft">No other signals match.</span>';
    onAll(list, '[data-add]', 'click', (el) => {
      const s = choices.find((c) => c.id === el.dataset.add);
      if (s) add(ctx, s);
    });
  };
  input.addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(() => void find(), 250);
  });
  root.querySelector('#explorer-search')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void find();
  });
  void find();
}

// `#/explorer?signal=<id>` (the Signals page links here) adds that signal.
function addFromLink(ctx: Context): void {
  const id = new URLSearchParams(location.hash.split('?')[1] ?? '').get('signal');
  const site = ctx.ontology.site;
  if (!id || !ctx.api || !site) return;
  history.replaceState(null, '', `${location.pathname}${location.search}#/explorer`);
  ctx.api.signals.get(site.id, id).then(
    (s) => add(ctx, s),
    () => undefined, // the client showed why
  );
}

const view: View = {
  id: 'explorer',
  title: 'Data explorer',
  icon: '⌁',
  render(ctx) {
    const head = `<div class="page-head"><div><div class="eyebrow">Data</div><h1>Data explorer</h1>
        <p class="soft">Plot any signals over a time range. Long ranges show averages with their minimum and maximum; drag across a chart to zoom in.</p></div></div>`;
    if (!ctx.api || !ctx.ontology.site)
      return `${head}<div class="card"><p class="small soft">Readings are kept in the Tiles API. Connect to it in <a href="#/settings">Settings</a> (data source: Tiles API).</p></div>`;
    const u = ui(ctx);
    if (u.catalogue !== catalogue(ctx)) Object.assign(u, { picked: [], range: null, catalogue: catalogue(ctx) });
    const { picked, range } = u;
    const chips = picked
      .map(
        (p) =>
          `<span class="badge">${esc(p.tag)} <button class="btn-link" type="button" data-remove="${esc(p.id)}" aria-label="Remove ${esc(p.tag)}">×</button></span>`,
      )
      .join(' ');
    const rangeBar = range
      ? `<form id="explorer-range" class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
          ${(['1h', '24h', '7d', '30d'] as const).map((p) => `<button class="btn sm" type="button" data-preset="${p}">Last ${p}</button>`).join('')}
          <button class="btn sm" type="button" data-preset="data" title="The 24 hours up to the latest reading">Latest data</button>
          <label class="field">From<input type="datetime-local" name="from" value="${localInput(range.from)}"></label>
          <label class="field">To<input type="datetime-local" name="to" value="${localInput(range.to)}"></label>
          <button class="btn sm" type="submit">Show</button>
          <button class="btn sm" type="button" data-pan="-1" aria-label="Earlier">←</button>
          <button class="btn sm" type="button" data-zoom-out>Zoom out</button>
          <button class="btn sm" type="button" data-pan="1" aria-label="Later">→</button>
        </form>`
      : '';
    const charts = picked
      .map(
        (p) => `<div class="card stack" style="gap:6px">
          <div class="row" style="justify-content:space-between"><strong><code>${esc(p.tag)}</code></strong><span class="small soft">${esc(p.unit ?? '')}</span></div>
          <div data-chart="${esc(p.id)}"><p class="small soft">Loading…</p></div>
        </div>`,
      )
      .join('');
    return `${head}<div class="card stack" style="gap:12px">
        <form id="explorer-search" class="row" style="gap:12px;flex-wrap:wrap" role="search">
          <label class="field" style="flex:1;min-width:200px">Add a signal<input type="search" name="q" placeholder="Tag, description or node" autocomplete="off"></label>
        </form>
        <div class="row" style="gap:6px;flex-wrap:wrap" data-explorer-found></div>
        ${picked.length ? `<div class="row" style="gap:6px;flex-wrap:wrap" data-picked>${chips}</div>` : '<p class="small soft">Pick up to eight signals to plot them on one time axis.</p>'}
        ${rangeBar}
      </div>
      <div class="stack" style="gap:12px;margin-top:12px" data-charts>${charts}</div>`;
  },
  bind(root, ctx) {
    clearTimeout(findTimer);
    addFromLink(ctx);
    bindSearch(root, ctx);
    onAll(root, '[data-remove]', 'click', (el) => {
      const u = ui(ctx);
      u.picked = u.picked.filter((p) => p.id !== el.dataset.remove);
      if (!u.picked.length) u.range = null;
      ctx.rerender();
    });
    const form = root.querySelector<HTMLFormElement>('#explorer-range');
    const range = ui(ctx).range;
    if (form && range) {
      onAll(form, '[data-preset]', 'click', (el) =>
        setRange(ctx, presetRange(el.dataset.preset as Preset, ui(ctx).picked, Date.now())),
      );
      onAll(form, '[data-pan]', 'click', (el) => setRange(ctx, pan(range, el.dataset.pan === '-1' ? -1 : 1)));
      onAll(form, '[data-zoom-out]', 'click', () => setRange(ctx, zoomOut(range)));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const from = Date.parse(field(form, 'from'));
        const to = Date.parse(field(form, 'to'));
        if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) {
          ctx.toast('Choose a start before the end');
          return;
        }
        setRange(ctx, { from: iso(from), to: iso(to) });
      });
    }
    loadCharts(root, ctx);
  },
};

export default view;
