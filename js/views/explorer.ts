import { ux } from '../lib/analytics.ts';
import { esc, field, fmt, onAll, onSubmit, bound } from '../lib/dom.ts';
import type { SignalInfo, SignalSeries } from '../lib/api.ts';
import { fitWidth, gapFor, lineChart, num, TIME_CHART, timeAt, timeChart, toPoints } from '../lib/svg.ts';
import {
  AGAINST,
  align,
  offsetLabel,
  otherRange,
  overlap,
  summarise,
  type Against,
  type Summary,
} from '../lib/compare.ts';
import { morph } from '../lib/morph.ts';
import { bindDraft, draftForm, insightLink, readDraft, seriesDraft, when, type DraftText } from '../lib/insights.ts';
import { parseLimit, wearBlock, wearPlan } from '../lib/wear.ts';
import type { WearCheckResult } from '../lib/api.ts';
import { catalogue } from './signals.ts';
import type { Context, View } from './types.ts';
import { card, field as labelled, input, needsApi, pageHead, select, skeleton, loadFailed, tabs } from '../lib/ui.ts';
import { keyAttr } from '../lib/shortcuts.ts';
import { t } from '../lib/i18n.ts';

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

// Compare mode (U5.09): one signal against another range of itself, or two signals.
export interface Compare {
  mode: 'off' | 'ranges' | 'signals';
  signal: string | null; // ranges: the signal
  against: Against;
  start: string | null; // ranges, custom: where the other range starts
  a: string | null; // signals: the two compared
  b: string | null;
}
const NO_COMPARE: Compare = { mode: 'off', signal: null, against: 'week', start: null, a: null, b: null };
const AGAINSTS = Object.keys(AGAINST) as Against[];

interface Ui {
  picked: Picked[];
  range: Range | null;
  compare?: Compare;
  zoomedFrom?: Range | null; // the range before dragging to zoom in (U5.03): Reset zoom goes back
  catalogue: string; // the catalogue `picked` belongs to
}

const ui = (ctx: Context): Ui => ctx.ui<Ui>('explorer', { picked: [], range: null, catalogue: '' });

let latestLoad = 0; // charts from an earlier load are dropped
let latestFind = 0;
let findTimer: ReturnType<typeof setTimeout> | undefined;
let searchText = '';
let saving: { key: string; text: DraftText } | null = null; // the insight being saved from the charts
let savingBusy = false; // its POST is on its way
// Each picked chart's wear check (T3.13): the choices typed, and the result for the range and
// choices it ran with. Running one redraws only its own section, not the charts.
interface WearState {
  direction: 'either' | 'up' | 'down';
  limit: string;
  busy: boolean;
  result: { key: string; data: WearCheckResult; limit: number | null } | null;
}
const wearStates = new Map<string, WearState>();
const wearOf = (id: string): WearState => {
  let w = wearStates.get(id);
  if (!w) wearStates.set(id, (w = { direction: 'either', limit: '', busy: false, result: null }));
  return w;
};
const wearKey = (id: string, range: Range | null, w: WearState): string =>
  JSON.stringify([id, range, w.direction, w.limit.trim()]);

function wearForm(id: string): string {
  const w = wearOf(id);
  const option = (v: WearState['direction'], text: string) =>
    `<option value="${v}" ${w.direction === v ? 'selected' : ''}>${text}</option>`;
  return `<form class="row gap-2 wrap items-end" data-wear-form="${esc(id)}">
      <label class="field">${esc(t('explorer.wear.moves'))}<select name="direction">${option('either', t('explorer.wear.either'))}${option('up', t('explorer.wear.up'))}${option('down', t('explorer.wear.down'))}</select></label>
      <label class="field">${esc(t('explorer.wear.limit'))}<input type="text" name="limit" inputmode="decimal" value="${esc(w.limit)}" placeholder="${esc(t('explorer.wear.optional'))}" class="w-8em"></label>
      <button class="btn sm" type="submit">${esc(t('explorer.wear.check'))}</button>
    </form>
    <div data-wear-out></div>`;
}

// The answer to the question the form asks now, if there is one, and whether one is on its way.
function showWear(box: HTMLElement, ctx: Context): void {
  const w = wearOf(box.dataset.wear ?? '');
  const r = w.result?.key === wearKey(box.dataset.wear ?? '', ui(ctx).range, w) ? w.result : null;
  const out = box.querySelector<HTMLElement>('[data-wear-out]');
  if (out) out.innerHTML = r ? wearBlock(r.data, r.limit, fitWidth(TIME_CHART.width)) : '';
  const button = box.querySelector<HTMLButtonElement>('button[type=submit]');
  if (button) button.disabled = w.busy;
}

// The form is drawn once per render; choosing and checking only redraw the answer under it.
function drawWear(box: HTMLElement, ctx: Context): void {
  const id = box.dataset.wear ?? '';
  box.innerHTML = wearForm(id);
  const form = box.querySelector<HTMLFormElement>('form');
  if (!form) return;
  const w = wearOf(id);
  form.addEventListener(
    'input',
    () => {
      w.limit = field(form, 'limit');
    },
    { signal: bound() },
  );
  form.addEventListener(
    'change',
    () => {
      w.direction = field(form, 'direction') as WearState['direction'];
      w.limit = field(form, 'limit');
      showWear(box, ctx); // an answer to another question goes, or comes back
    },
    { signal: bound() },
  );
  onSubmit(box, 'form', () => checkWear(ctx, box));
  showWear(box, ctx);
}

async function checkWear(ctx: Context, box: HTMLElement): Promise<void> {
  const site = ctx.ontology.site;
  const { range } = ui(ctx);
  const id = box.dataset.wear ?? '';
  const w = wearOf(id);
  if (w.busy) return;
  if (!ctx.api || !site || !range) return void ctx.toast(t('explorer.chooseRange'));
  const plan = wearPlan(range);
  if (typeof plan === 'string') return void ctx.toast(plan);
  const limit = parseLimit(w.limit);
  if (typeof limit === 'string') return void ctx.toast(limit);
  const key = wearKey(id, range, w);
  const query = { ...plan, direction: w.direction, limit };
  w.busy = true;
  showWear(box, ctx);
  try {
    w.result = { key, data: await ctx.api.signals.wearCheck(site.id, id, query), limit };
  } catch {
    // the client showed why
  } finally {
    w.busy = false;
    if (box.isConnected) showWear(box, ctx);
  }
}

const iso = (t: number) => new Date(t).toISOString();

// A preset range: the last hour, day, week or month, or the day up to the latest reading picked.
export function presetRange(preset: Preset, picked: Picked[], now: number): Range {
  if (preset !== 'data') return { from: iso(now - PRESETS[preset]), to: iso(now) };
  const last = Math.max(...picked.map((p) => (p.last_at ? Date.parse(p.last_at) : -Infinity)));
  const end = Number.isFinite(last) ? last + 1 : now; // `to` is excluded
  return { from: iso(end - PRESETS['24h']), to: iso(end) };
}

// The longest range the API serves (as long as samples are kept).
export const MAX_SPAN = 5 * 366 * 24 * HOUR;

// Twice as long, around the same middle; at most MAX_SPAN.
export function zoomOut(range: Range): Range {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const grow = Math.min(to - from, MAX_SPAN - (to - from)) / 2;
  return { from: iso(from - grow), to: iso(to + grow) };
}

// Half a range earlier (-1) or later (+1).
export function pan(range: Range, direction: -1 | 1): Range {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const shift = ((to - from) / 2) * direction;
  return { from: iso(from + shift), to: iso(to + shift) };
}

function duration(seconds: number): string {
  if (seconds < 60) return `${+seconds.toPrecision(3)} s`;
  if (seconds < 3600) return `${+(seconds / 60).toPrecision(3)} min`;
  if (seconds < 48 * 3600) return `${+(seconds / 3600).toPrecision(3)} h`;
  return `${+(seconds / 86400).toPrecision(3)} d`;
}

export function describe(series: SignalSeries): string {
  const readings = series.points.reduce((n, p) => n + p.n, 0);
  if (!readings) return t('explorer.noReadings');
  return series.bucket_s === null
    ? t('explorer.readings', { count: readings, readings: fmt(readings, 0) })
    : t('explorer.averages', {
        readings: fmt(readings, 0),
        averages: fmt(series.points.length, 0),
        bucket: duration(series.bucket_s),
      });
}

function textReadings(series: SignalSeries): string {
  const texts = series.points.filter((p) => p.text !== null).slice(-20);
  if (!texts.length) return '';
  return `<div class="table-wrap"><table><thead><tr><th>${esc(t('explorer.text.time'))}</th><th>${esc(t('explorer.text.value'))}</th></tr></thead><tbody>${texts
    .map((p) => `<tr><td>${esc(new Date(p.at).toLocaleString('en-GB'))}</td><td>${esc(p.text ?? '')}</td></tr>`)
    .join(
      '',
    )}</tbody></table></div><p class="small soft">${esc(t('explorer.text.latest', { count: texts.length }))}</p>`;
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
          title: series.unit ? `${series.tag} (${series.unit})` : series.tag,
          width: fitWidth(TIME_CHART.width),
        })
      : '';
  return `<div class="explorer-chart" data-zoom>${chart}<div class="zoom-box" hidden></div></div>
    ${textReadings(series)}
    <p class="small soft" data-series-note>${esc(describe(series))}${
      series.points.length ? '' : esc(t('explorer.noReadingsHint'))
    }</p>`;
}

const localInput = (isoTime: string): string => {
  const d = new Date(isoTime);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};

// A new range. `drag`: dragged across a chart to zoom in, so Reset zoom can go back to the range it
// started from; `move`: panned or zoomed out from there, which keeps that; `new`: another range
// altogether (a preset, From and To, a link), after which there is nothing to reset.
function setRange(ctx: Context, range: Range, how: 'drag' | 'move' | 'new' = 'new'): void {
  const u = ui(ctx);
  if (how === 'drag') u.zoomedFrom ??= u.range;
  else if (how === 'new') u.zoomedFrom = null;
  u.range = range;
  ctx.rerender();
}

function add(ctx: Context, s: Pick<SignalInfo, 'id' | 'tag' | 'unit' | 'last_at'>): void {
  const u = ui(ctx);
  if (u.picked.some((p) => p.id === s.id)) return;
  if (u.picked.length >= MAX_SIGNALS) {
    ctx.toast(t('explorer.atMost', { max: MAX_SIGNALS }));
    return;
  }
  u.picked = [...u.picked, { id: s.id, tag: s.tag, unit: s.unit, last_at: s.last_at }];
  ux('task', 'signal.plotted');
  // A signal whose readings are all outside the range shown brings the day up to its latest reading.
  const last = s.last_at ? Date.parse(s.last_at) : null;
  const outside = u.range && last !== null && (last < Date.parse(u.range.from) || last >= Date.parse(u.range.to));
  if (!u.range || outside) Object.assign(u, { range: presetRange('data', [{ ...s }], Date.now()), zoomedFrom: null });
  ctx.rerender();
}

function loadCharts(root: HTMLElement, ctx: Context): void {
  const site = ctx.ontology.site;
  const { picked, range } = ui(ctx);
  if (!ctx.api || !site || !range) return;
  const mine = ++latestLoad;
  for (const p of picked) {
    const box = root.querySelector<HTMLElement>(`[data-plot="${CSS.escape(p.id)}"]`);
    ctx.api.signals.series(site.id, p.id, range.from, range.to, POINTS).then(
      (series) => {
        if (mine !== latestLoad || !box?.isConnected) return;
        box.innerHTML = chartFor(series, range);
        bindZoom(box, ctx, range);
      },
      () => {
        if (mine === latestLoad && box?.isConnected) box.innerHTML = loadFailed(t('explorer.readingsFailed'));
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
  const cancel = () => {
    start = null;
    marker.hidden = true;
  };
  area.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return; // the main button only
      // On the chart itself: its tools (legend, PNG, CSV) are buttons, not the start of a drag.
      if (!(e.target instanceof Element) || !e.target.closest('svg[data-chart]')) return;
      start = e.clientX;
      area.setPointerCapture(e.pointerId);
    },
    { signal: bound() },
  );
  area.addEventListener('pointercancel', cancel, { signal: bound() });
  area.addEventListener(
    'lostpointercapture',
    () => {
      if (start !== null) cancel(); // e.g. a context menu took the pointer
    },
    { signal: bound() },
  );
  area.addEventListener(
    'pointermove',
    (e) => {
      if (start === null) return;
      const rect = area.getBoundingClientRect();
      marker.hidden = false;
      marker.style.left = `${Math.min(start, e.clientX) - rect.left}px`;
      marker.style.width = `${Math.abs(e.clientX - start)}px`;
    },
    { signal: bound() },
  );
  area.addEventListener(
    'pointerup',
    (e) => {
      if (start === null) return;
      const [a, b] = [units(start), units(e.clientX)].sort((p, q) => p - q) as [number, number];
      cancel();
      if (b - a < 8) return; // a click, not a drag
      const t0 = timeAt(a, from, to, width);
      const t1 = timeAt(b, from, to, width);
      if (t1 - t0 >= 1) setRange(ctx, { from: iso(t0), to: iso(t1) }, 'drag');
    },
    { signal: bound() },
  );
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
      : `<span class="small soft">${esc(t('explorer.noMatch'))}</span>`;
    onAll(list, '[data-add]', 'click', (el) => {
      const s = choices.find((c) => c.id === el.dataset.add);
      if (s) add(ctx, s);
    });
  };
  input.value = searchText; // kept across re-renders (adding a signal re-renders the page)
  input.addEventListener(
    'input',
    () => {
      searchText = input.value;
      clearTimeout(findTimer);
      findTimer = setTimeout(() => void find(), 250);
    },
    { signal: bound() },
  );
  root.querySelector('#explorer-search')?.addEventListener(
    'submit',
    (e) => {
      e.preventDefault();
      void find();
    },
    { signal: bound() },
  );
  void find();
}

// The charts shown, as a key: a saved-insight draft belongs to them.
const chartsKey = (u: Ui): string => JSON.stringify([u.picked.map((p) => p.id), u.range]);

// A link's range, if it is one the API serves.
export function linkRange(params: URLSearchParams): Range | null {
  const from = Date.parse(params.get('from') ?? '');
  const to = Date.parse(params.get('to') ?? '');
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= MAX_SPAN)) return null;
  return { from: iso(from), to: iso(to) };
}

// `#/explorer?signal=<id>` (the Signals page links here) adds that signal;
// `#/explorer?signals=<id>,<id>&from=…&to=…` (a saved insight links here) shows those over that range;
// `#/explorer?tag=<tag>` (the copilot's evidence links) adds the signal with that tag.
// The page's own address is the last (U3.05): a reload or a copied link shows the same charts.
// A link's query, read before the page is drawn (`query.read`), waits here for the site.
let linkParams: URLSearchParams | null = null;
const linkIds = (params: URLSearchParams): string[] =>
  (params.get('signals') ?? '').split(',').filter(Boolean).slice(0, MAX_SIGNALS);

function addFromLink(ctx: Context): void {
  const site = ctx.ontology.site;
  const api = ctx.api;
  if (!linkParams || !api || !site) return;
  const params = linkParams;
  linkParams = null;
  const id = params.get('signal');
  const tag = params.get('tag');
  const ids = linkIds(params);
  if (tag) {
    api.signals.list(site.id, { q: tag, limit: 500 }).then(
      (page) => {
        const s =
          page.signals.find((x) => x.tag === tag) ??
          page.signals.find((x) => x.tag.toLowerCase() === tag.toLowerCase());
        if (s) add(ctx, s);
        else ctx.toast(t('explorer.noTag', { tag }));
      },
      () => undefined, // the client showed why
    );
    return;
  }
  if (id) {
    api.signals.get(site.id, id).then(
      (s) => add(ctx, s),
      () => undefined, // the client showed why
    );
    return;
  }
  const range = linkRange(params);
  void Promise.allSettled(ids.map((i) => api.signals.get(site.id, i))).then((got) => {
    const picked = got.flatMap((r) =>
      r.status === 'fulfilled'
        ? [{ id: r.value.id, tag: r.value.tag, unit: r.value.unit, last_at: r.value.last_at }]
        : [],
    );
    if (!picked.length) return;
    Object.assign(ui(ctx), { picked, range: range ?? presetRange('data', picked, Date.now()), zoomedFrom: null });
    ctx.rerender();
  });
}

async function saveInsight(ctx: Context): Promise<void> {
  const site = ctx.ontology.site;
  const u = ui(ctx);
  if (!ctx.api || !site || !u.range || !saving || saving.key !== chartsKey(u) || savingBusy) return;
  const draft = readDraft(saving.text);
  if (typeof draft === 'string') return void ctx.toast(draft);
  const source = {
    kind: 'series' as const,
    signals: u.picked.map((p) => p.id),
    start: u.range.from,
    end: u.range.to,
    points: POINTS, // as the charts were drawn
  };
  savingBusy = true;
  ctx.rerender();
  try {
    const saved = await ctx.api.insights.create(site.id, draft, source);
    saving = null;
    ctx.toast(t('explorer.saved', { number: saved.number }));
    location.hash = insightLink(saved.number);
  } catch {
    // the client showed why
  } finally {
    savingBusy = false;
    ctx.rerender();
  }
}

// ---- compare mode (U5.09) -----------------------------------------------------------------------

const COMPARE_BUCKETS = 240;
let latestCompare = 0;
// The comparison last drawn, by what it compares: a page drawn again for something else shows it as
// it was, without asking for its readings again.
let compareDrawn: { key: string; html: string } | null = null;

// The comparison asked for, its signals checked against those plotted.
function compareOf(u: Ui): Compare {
  const c = { ...NO_COMPARE, ...u.compare };
  const ids = u.picked.map((p) => p.id);
  const pick = (id: string | null, fallback: number) => (id && ids.includes(id) ? id : (ids[fallback] ?? null));
  if (c.mode === 'signals' && ids.length < 2) c.mode = 'off';
  return { ...c, signal: pick(c.signal, 0), a: pick(c.a, 0), b: pick(c.b, ids.length > 1 ? 1 : 0) };
}

// In the address: `compare=ranges&cs=<id>&against=week[&cstart=…]` or `compare=signals&ca=…&cb=…`.
export function compareQuery(c: Compare): Record<string, string | null> {
  const none = { compare: null, cs: null, against: null, cstart: null, ca: null, cb: null };
  if (c.mode === 'ranges')
    return {
      ...none,
      compare: 'ranges',
      cs: c.signal,
      against: c.against,
      cstart: c.against === 'custom' ? c.start : null,
    };
  if (c.mode === 'signals') return { ...none, compare: 'signals', ca: c.a, cb: c.b };
  return none;
}
export function compareFromQuery(params: URLSearchParams): Compare | null {
  const mode = params.get('compare');
  if (mode !== 'ranges' && mode !== 'signals') return null;
  const against = params.get('against');
  const start = params.get('cstart');
  return {
    mode,
    signal: params.get('cs'),
    against: AGAINSTS.includes(against as Against) ? (against as Against) : 'week',
    start: start && Number.isFinite(Date.parse(start)) ? start : null,
    a: params.get('ca'),
    b: params.get('cb'),
  };
}

const spanText = (span: { from: number; to: number }): string =>
  t('explorer.span', { from: when(new Date(span.from).toISOString()), to: when(new Date(span.to).toISOString()) });

function compareForm(u: Ui, c: Compare): string {
  const signals = u.picked.map((p) => [p.id, p.tag] as const);
  if (c.mode === 'ranges')
    return `${labelled(t('explorer.compare.signal'), select('signal', signals, c.signal ?? ''))}
      ${labelled(
        t('explorer.compare.against'),
        select(
          'against',
          AGAINSTS.map((a) => [a, t(AGAINST[a])] as const),
          c.against,
        ),
      )}
      ${c.against === 'custom' ? labelled(t('explorer.compare.start'), input({ type: 'datetime-local', name: 'start', value: c.start ? localInput(c.start) : '' })) : ''}`;
  if (c.mode === 'signals')
    return `${labelled(t('explorer.compare.first'), select('a', signals, c.a ?? ''))}${labelled(t('explorer.compare.second'), select('b', signals, c.b ?? ''))}`;
  return '';
}

function compareCard(u: Ui): string {
  const c = compareOf(u);
  const modes = tabs({
    label: t('explorer.compare.title'),
    items: [
      ['off', t('explorer.compare.off')],
      ['ranges', t('explorer.compare.ranges')],
      ...(u.picked.length > 1 ? ([['signals', t('explorer.compare.signals')]] as const) : []),
    ],
    current: c.mode,
    data: 'compare-mode',
  });
  const form = compareForm(u, c);
  const key = compareKey(u);
  const result =
    c.mode === 'off'
      ? ''
      : `<div data-compare-result>${compareDrawn?.key === key ? compareDrawn.html : skeleton.chart(t('explorer.compare.loading'), TIME_CHART.height)}</div>`;
  return card(
    `<div class="row justify-between wrap gap-2"><div><h2>${esc(t('explorer.compare.title'))}</h2><p class="small soft">${esc(t('explorer.compare.hint'))}</p></div>${modes}</div>
      ${form ? `<form class="row gap-2 wrap items-end" id="compare-form">${form}</form>` : ''}
      ${result}`,
    { class: 'stack gap-2_5', attrs: { 'data-compare': true } },
  );
}

const compareKey = (u: Ui): string => JSON.stringify([compareOf(u), u.range, u.picked.map((p) => [p.id, p.unit])]);

export function summaryText(s: Summary, names: [string, string], unit: string): string {
  if (s.meanA === null || s.meanB === null || s.diff === null)
    return t('explorer.summary.none', { a: names[0], b: names[1] });
  const params = {
    b: names[1],
    unit: unit ? ` ${unit}` : '',
    meanA: num(s.meanA),
    meanB: num(s.meanB),
    count: s.shared,
    shared: s.shared,
    way: s.diff > 0 ? 'higher' : 'lower',
    diff: num(Math.abs(s.diff)),
  };
  if (s.diff === 0) return t('explorer.summary.same', params);
  if (s.pct === null) return t('explorer.summary.diff', params);
  return t('explorer.summary.diffPct', { ...params, pct: num(Math.abs(s.pct)) });
}

// Draws the comparison into its card, from the readings of both (or what was drawn last for it).
function loadCompare(root: HTMLElement, ctx: Context): void {
  const site = ctx.ontology.site;
  const u = ui(ctx);
  const c = compareOf(u);
  const box = root.querySelector<HTMLElement>('[data-compare-result]');
  if (!ctx.api || !site || !u.range || !box || c.mode === 'off') return;
  const key = compareKey(u);
  if (compareDrawn?.key === key) return; // drawn already, as it is now
  const show = (html: string) => {
    compareDrawn = { key, html };
    if (box.isConnected) box.innerHTML = html;
  };
  const range = { from: Date.parse(u.range.from), to: Date.parse(u.range.to) };
  if (c.mode === 'ranges' && c.against === 'custom' && !c.start)
    return show(`<p class="small soft">${esc(t('explorer.compare.pickStart'))}</p>`);
  const other = c.mode === 'ranges' ? otherRange(range, c.against, c.start ? Date.parse(c.start) : null) : range;
  if (c.mode === 'ranges' && overlap(range, other))
    return show(`<p class="small soft">${esc(t('explorer.compare.overlap', { span: spanText(other) }))}</p>`);
  const tagOf = (id: string | null) => u.picked.find((p) => p.id === id);
  const one = tagOf(c.mode === 'ranges' ? c.signal : c.a);
  const two = tagOf(c.mode === 'ranges' ? c.signal : c.b);
  if (!one || !two) return;
  const api = ctx.api;
  const mine = ++latestCompare;
  const get = (id: string, span: { from: number; to: number }) =>
    api.signals.series(site.id, id, new Date(span.from).toISOString(), new Date(span.to).toISOString(), POINTS);
  // A: the other range (or the first signal); B: this range (or the second signal).
  Promise.all([get(one.id, other), get(two.id, range)]).then(
    ([sa, sb]) => {
      if (mine !== latestCompare) return;
      const read = (r: SignalSeries) => toPoints(r).map((p) => ({ t: p.t, v: p.v }));
      const x = align(read(sa), other, read(sb), range, COMPARE_BUCKETS);
      const ranges = c.mode === 'ranges';
      const legend: [string, string] = ranges
        ? [t('explorer.compare.otherRange'), t('explorer.compare.thisRange')]
        : [one.tag, two.tag];
      const said: [string, string] = ranges
        ? [t('explorer.compare.theOtherRange'), t('explorer.compare.thisRangeSaid')]
        : [one.tag, two.tag];
      const unitsDiffer = !ranges && (one.unit ?? '') !== (two.unit ?? '');
      const unit = unitsDiffer ? '' : (one.unit ?? '');
      const xFormat = ranges
        ? (i: number) => offsetLabel(i * x.width)
        : (i: number) => when(new Date(range.from + i * x.width).toISOString());
      const width = fitWidth(TIME_CHART.width);
      show(`${lineChart({
        series: [
          { values: x.a, color: 'var(--soft)', label: legend[0], dash: '5 3' },
          { values: x.b, color: 'var(--accent)', label: legend[1] },
        ],
        xFormat,
        xLabel: ranges ? t('explorer.compare.sinceStart') : '',
        yLabel: unit,
        title: ranges
          ? t('explorer.compare.rangesTitle', { tag: one.tag, against: t(AGAINST[c.against]).toLowerCase() })
          : t('explorer.compare.signalsTitle', { a: one.tag, b: two.tag }),
        width,
        height: TIME_CHART.height,
      })}
      ${lineChart({
        series: [
          {
            values: x.diff,
            color: 'var(--warm)',
            label: t('explorer.compare.diffLabel', { a: legend[0], b: legend[1] }),
          },
        ],
        xFormat,
        yLabel: unit,
        title: unit
          ? t('explorer.compare.diffTitleUnit', { a: said[0], b: said[1], unit })
          : t('explorer.compare.diffTitle', { a: said[0], b: said[1] }),
        width,
        height: 160,
      })}
      <p class="small" data-compare-summary>${esc(summaryText(summarise(x), said, unit))}</p>
      ${ranges ? `<p class="small soft">${esc(t('explorer.compare.otherSpan', { span: spanText(other) }))}</p>` : ''}
      ${unitsDiffer ? `<p class="small text-warn">${esc(t('explorer.compare.unitsDiffer', { a: one.unit ?? t('explorer.compare.noUnit'), b: two.unit ?? t('explorer.compare.noUnit') }))}</p>` : ''}`);
      ux('task', 'signal.compared');
    },
    () => {
      if (mine === latestCompare && box.isConnected) box.innerHTML = loadFailed(t('explorer.compare.failed'));
    },
  );
}

// A change to the comparison draws its card alone (the charts above stay as they are).
function redrawCompare(root: HTMLElement, ctx: Context): void {
  const wrap = root.querySelector<HTMLElement>('[data-compare-wrap]');
  if (!wrap) return;
  morph(wrap, compareCard(ui(ctx)));
  ctx.address();
  loadCompare(root, ctx);
}

function bindCompare(root: HTMLElement, ctx: Context): void {
  const wrap = root.querySelector<HTMLElement>('[data-compare-wrap]');
  if (!wrap) return;
  wrap.addEventListener(
    'click',
    (e) => {
      const mode = (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-compare-mode]') : null)?.dataset
        .compareMode;
      if (mode !== 'off' && mode !== 'ranges' && mode !== 'signals') return;
      const u = ui(ctx);
      u.compare = { ...compareOf(u), mode };
      redrawCompare(root, ctx);
    },
    { signal: bound() },
  );
  wrap.addEventListener(
    'change',
    (e) => {
      const form = e.target instanceof Element ? e.target.closest<HTMLFormElement>('#compare-form') : null;
      if (!form) return;
      const u = ui(ctx);
      const c = compareOf(u);
      const read = (name: string) => form.querySelector<HTMLSelectElement | HTMLInputElement>(`[name=${name}]`)?.value;
      const against = read('against');
      const start = read('start');
      u.compare = {
        ...c,
        signal: read('signal') ?? c.signal,
        against: AGAINSTS.includes(against as Against) ? (against as Against) : c.against,
        // Cleared, it is cleared (the card then asks for one).
        start:
          start === undefined
            ? c.start
            : start && Number.isFinite(Date.parse(start))
              ? new Date(start).toISOString()
              : null,
        a: read('a') ?? c.a,
        b: read('b') ?? c.b,
      };
      redrawCompare(root, ctx);
    },
    { signal: bound() },
  );
  wrap.addEventListener('submit', (e) => e.preventDefault(), { signal: bound() });
  loadCompare(root, ctx);
}

const view: View = {
  id: 'explorer',
  get title() {
    return t('explorer.title');
  },
  icon: 'chart-line',
  // The signals plotted and the range, in the address (U3.05): `?signals=<id>,<id>&from=…&to=…`.
  query: {
    read(params, ctx) {
      const u = ui(ctx);
      u.compare = compareFromQuery(params) ?? { ...NO_COMPARE };
      if (params.get('signal') || params.get('tag')) linkParams = params;
      else if (linkIds(params).length) {
        const same =
          linkIds(params).join() === u.picked.map((p) => p.id).join() &&
          JSON.stringify(linkRange(params)) === JSON.stringify(u.range);
        if (!same) linkParams = params;
      }
    },
    write(ctx) {
      // A link not yet followed (the site still loading) stays in the address as it came.
      if (linkParams)
        return Object.fromEntries(['signal', 'tag', 'signals', 'from', 'to'].map((k) => [k, linkParams?.get(k)]));
      const u = ui(ctx);
      const ids = u.picked.map((p) => p.id).join(',');
      return {
        signals: ids || null,
        from: ids ? u.range?.from : null,
        to: ids ? u.range?.to : null,
        ...compareQuery(ids && u.range ? compareOf(u) : NO_COMPARE),
      };
    },
  },
  render(ctx) {
    const head = pageHead({
      eyebrow: t('explorer.eyebrow'),
      title: t('explorer.title'),
      lead: t('explorer.lead'),
    });
    if (!ctx.api || !ctx.ontology.site) return `${head}<div class="card">${needsApi(t('explorer.needsApi'))}</div>`;
    const u = ui(ctx);
    if (u.catalogue !== catalogue(ctx))
      Object.assign(u, {
        picked: [],
        range: null,
        zoomedFrom: null,
        compare: { ...NO_COMPARE },
        catalogue: catalogue(ctx),
      });
    for (const id of wearStates.keys()) if (!u.picked.some((p) => p.id === id)) wearStates.delete(id);
    const { picked, range } = u;
    const canSave = ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';
    const chips = picked
      .map(
        (p) =>
          `<span class="badge">${esc(p.tag)} <button class="btn-link" type="button" data-remove="${esc(p.id)}" aria-label="${esc(t('explorer.remove', { tag: p.tag }))}">×</button></span>`,
      )
      .join(' ');
    const rangeBar = range
      ? `<form id="explorer-range" class="row gap-2 wrap items-end" data-tour="explorer-range">
          ${(['1h', '24h', '7d', '30d'] as const).map((p) => `<button class="btn sm" type="button" data-preset="${p}">${esc(t('explorer.range.last', { period: p }))}</button>`).join('')}
          <button class="btn sm" type="button" data-preset="data" title="${esc(t('explorer.range.latestHint'))}">${esc(t('explorer.range.latest'))}</button>
          <label class="field">${esc(t('explorer.range.from'))}<input type="datetime-local" name="from" value="${localInput(range.from)}"></label>
          <label class="field">${esc(t('explorer.range.to'))}<input type="datetime-local" name="to" value="${localInput(range.to)}"></label>
          <button class="btn sm" type="submit">${esc(t('explorer.range.show'))}</button>
          <button class="btn sm" type="button" data-pan="-1" aria-label="${esc(t('explorer.range.earlier'))}">←</button>
          <button class="btn sm" type="button" data-zoom-out>${esc(t('explorer.range.zoomOut'))}</button>
          ${u.zoomedFrom ? `<button class="btn sm" type="button" data-zoom-reset>${esc(t('explorer.range.reset'))}</button>` : ''}
          <button class="btn sm" type="button" data-pan="1" aria-label="${esc(t('explorer.range.later'))}">→</button>
          ${canSave && saving?.key !== chartsKey(u) ? `<button class="btn sm" type="button" data-save-insight>${esc(t('explorer.range.save'))}</button>` : ''}
        </form>
        ${canSave && saving?.key === chartsKey(u) ? `<div class="stack gap-1_5"><h3>${esc(t('explorer.save.title'))}</h3><p class="small soft">${esc(t('explorer.save.hint'))}</p>${draftForm('insight-save', saving.text, savingBusy)}</div>` : ''}`
      : '';
    const charts = picked
      .map(
        (p) => `<div class="card stack gap-1_5">
          <div class="row justify-between"><strong><code>${esc(p.tag)}</code></strong><span class="small soft">${esc(p.unit ?? '')}</span></div>
          <div data-plot="${esc(p.id)}">${skeleton.chart(t('explorer.loadingReadings'), TIME_CHART.height)}</div>
          <div data-wear="${esc(p.id)}"></div>
        </div>`,
      )
      .join('');
    return `${head}<div class="card stack gap-3">
        <form id="explorer-search" class="row gap-3 wrap" role="search" data-tour="explorer-search">
          <label class="field grow min-w-field">${esc(t('explorer.search.label'))}<input type="search" name="q" placeholder="${esc(t('explorer.search.placeholder'))}" autocomplete="off"${keyAttr('/')}></label>
        </form>
        <div class="row gap-1_5 wrap" data-explorer-found></div>
        ${picked.length ? `<div class="row gap-1_5 wrap" data-picked>${chips}</div>` : `<p class="small soft">${esc(t('explorer.pickHint'))}</p>`}
        ${rangeBar}
      </div>
      <div class="stack gap-3 mt-3" data-charts data-tour="explorer-charts">${charts}</div>
      ${picked.length && range ? `<div class="mt-3" data-compare-wrap>${compareCard(u)}</div>` : ''}`;
  },
  bind(root, ctx) {
    clearTimeout(findTimer);
    addFromLink(ctx);
    bindSearch(root, ctx);
    onAll(root, '[data-remove]', 'click', (el) => {
      const u = ui(ctx);
      u.picked = u.picked.filter((p) => p.id !== el.dataset.remove);
      if (!u.picked.length) Object.assign(u, { range: null, zoomedFrom: null });
      ctx.rerender();
    });
    const form = root.querySelector<HTMLFormElement>('#explorer-range');
    const range = ui(ctx).range;
    if (form && range) {
      onAll(form, '[data-preset]', 'click', (el) =>
        setRange(ctx, presetRange(el.dataset.preset as Preset, ui(ctx).picked, Date.now())),
      );
      onAll(form, '[data-pan]', 'click', (el) => setRange(ctx, pan(range, el.dataset.pan === '-1' ? -1 : 1), 'move'));
      onAll(form, '[data-zoom-out]', 'click', () => setRange(ctx, zoomOut(range), 'move'));
      onAll(form, '[data-zoom-reset]', 'click', () => {
        const back = ui(ctx).zoomedFrom;
        if (back) setRange(ctx, back);
      });
      form.addEventListener(
        'submit',
        (e) => {
          e.preventDefault();
          // The inputs show whole minutes: one left as shown keeps its exact time.
          const read = (name: 'from' | 'to') => {
            const typed = field(form, name);
            return typed === localInput(range[name]) ? Date.parse(range[name]) : Date.parse(typed);
          };
          const from = read('from');
          const to = read('to');
          if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) {
            ctx.toast(t('explorer.startBeforeEnd'));
            return;
          }
          if (to - from > MAX_SPAN) {
            ctx.toast(t('explorer.atMostFiveYears'));
            return;
          }
          setRange(ctx, { from: iso(from), to: iso(to) });
        },
        { signal: bound() },
      );
    }
    onAll(root, '[data-save-insight]', 'click', () => {
      const u = ui(ctx);
      if (!u.range) return;
      saving = {
        key: chartsKey(u),
        text: seriesDraft(
          u.picked.map((p) => p.tag),
          u.range.from,
          u.range.to,
        ),
      };
      ctx.rerender();
    });
    const saveForm = root.querySelector<HTMLFormElement>('#insight-save');
    if (saveForm && saving) {
      bindDraft(saveForm, saving.text);
      onAll(saveForm, '[data-cancel]', 'click', () => {
        saving = null;
        ctx.rerender();
      });
      onSubmit(root, '#insight-save', () => saveInsight(ctx));
    }
    root.querySelectorAll<HTMLElement>('[data-wear]').forEach((box) => drawWear(box, ctx));
    loadCharts(root, ctx);
    bindCompare(root, ctx);
  },
};

export default view;
