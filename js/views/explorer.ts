import { ux } from '../lib/analytics.ts';
import { esc, field, fmt, onAll, onSubmit, bound } from '../lib/dom.ts';
import type { SignalInfo, SignalSeries } from '../lib/api.ts';
import { fitWidth, gapFor, TIME_CHART, timeAt, timeChart, toPoints } from '../lib/svg.ts';
import { bindDraft, draftForm, insightLink, readDraft, seriesDraft, type DraftText } from '../lib/insights.ts';
import { parseLimit, wearBlock, wearPlan } from '../lib/wear.ts';
import type { WearCheckResult } from '../lib/api.ts';
import { catalogue } from './signals.ts';
import type { Context, View } from './types.ts';
import { needsApi, pageHead, skeleton, loadFailed } from '../lib/ui.ts';

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
      <label class="field">Wear moves it<select name="direction">${option('either', 'either way')}${option('up', 'up')}${option('down', 'down')}</select></label>
      <label class="field">Limit<input type="text" name="limit" inputmode="decimal" value="${esc(w.limit)}" placeholder="optional" class="w-8em"></label>
      <button class="btn sm" type="submit">Check for wear</button>
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
  if (!ctx.api || !site || !range) return void ctx.toast('Choose a range first');
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
          title: series.unit ? `${series.tag} (${series.unit})` : series.tag,
          width: fitWidth(TIME_CHART.width),
        })
      : '';
  return `<div class="explorer-chart" data-zoom>${chart}<div class="zoom-box" hidden></div></div>
    ${textReadings(series)}
    <p class="small soft" data-series-note>${esc(describe(series))}${
      series.points.length ? '' : ': pick a longer range above, or Latest data for the day up to its last reading.'
    }</p>`;
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
  ux('task', 'signal.plotted');
  // A signal whose readings are all outside the range shown brings the day up to its latest reading.
  const last = s.last_at ? Date.parse(s.last_at) : null;
  const outside = u.range && last !== null && (last < Date.parse(u.range.from) || last >= Date.parse(u.range.to));
  if (!u.range || outside) u.range = presetRange('data', [{ ...s }], Date.now());
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
        if (mine === latestLoad && box?.isConnected) box.innerHTML = loadFailed('The readings');
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
      if (t1 - t0 >= 1) setRange(ctx, { from: iso(t0), to: iso(t1) });
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
      : '<span class="small soft">No other signals match: try part of a tag, or its unit.</span>';
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
        else ctx.toast(`No signal tagged ${tag}`);
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
    Object.assign(ui(ctx), { picked, range: range ?? presetRange('data', picked, Date.now()) });
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
    ctx.toast(`Insight #${saved.number} saved: another engineer reviews it`);
    location.hash = insightLink(saved.number);
  } catch {
    // the client showed why
  } finally {
    savingBusy = false;
    ctx.rerender();
  }
}

const view: View = {
  id: 'explorer',
  title: 'Data explorer',
  icon: 'chart-line',
  // The signals plotted and the range, in the address (U3.05): `?signals=<id>,<id>&from=…&to=…`.
  query: {
    read(params, ctx) {
      const u = ui(ctx);
      if (params.get('signal') || params.get('tag')) linkParams = params;
      else if (linkIds(params).length) {
        const same =
          linkIds(params).join() === u.picked.map((p) => p.id).join() &&
          JSON.stringify(linkRange(params)) === JSON.stringify(u.range);
        if (!same) linkParams = params;
      }
    },
    write(ctx) {
      if (linkParams?.get('signals'))
        return { signals: linkParams.get('signals'), from: linkParams.get('from'), to: linkParams.get('to') };
      const u = ui(ctx);
      const ids = u.picked.map((p) => p.id).join(',');
      return { signals: ids || null, from: ids ? u.range?.from : null, to: ids ? u.range?.to : null };
    },
  },
  render(ctx) {
    const head = pageHead({
      eyebrow: 'Data',
      title: 'Data explorer',
      lead: 'Plot any signals over a time range. Long ranges show averages with their minimum and maximum; drag across a chart to zoom in.',
    });
    if (!ctx.api || !ctx.ontology.site)
      return `${head}<div class="card">${needsApi(`Readings are kept in the Tiles API.`)}</div>`;
    const u = ui(ctx);
    if (u.catalogue !== catalogue(ctx)) Object.assign(u, { picked: [], range: null, catalogue: catalogue(ctx) });
    for (const id of wearStates.keys()) if (!u.picked.some((p) => p.id === id)) wearStates.delete(id);
    const { picked, range } = u;
    const canSave = ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';
    const chips = picked
      .map(
        (p) =>
          `<span class="badge">${esc(p.tag)} <button class="btn-link" type="button" data-remove="${esc(p.id)}" aria-label="Remove ${esc(p.tag)}">×</button></span>`,
      )
      .join(' ');
    const rangeBar = range
      ? `<form id="explorer-range" class="row gap-2 wrap items-end">
          ${(['1h', '24h', '7d', '30d'] as const).map((p) => `<button class="btn sm" type="button" data-preset="${p}">Last ${p}</button>`).join('')}
          <button class="btn sm" type="button" data-preset="data" title="The 24 hours up to the latest reading">Latest data</button>
          <label class="field">From<input type="datetime-local" name="from" value="${localInput(range.from)}"></label>
          <label class="field">To<input type="datetime-local" name="to" value="${localInput(range.to)}"></label>
          <button class="btn sm" type="submit">Show</button>
          <button class="btn sm" type="button" data-pan="-1" aria-label="Earlier">←</button>
          <button class="btn sm" type="button" data-zoom-out>Zoom out</button>
          <button class="btn sm" type="button" data-pan="1" aria-label="Later">→</button>
          ${canSave && saving?.key !== chartsKey(u) ? '<button class="btn sm" type="button" data-save-insight>Save as insight</button>' : ''}
        </form>
        ${canSave && saving?.key === chartsKey(u) ? `<div class="stack gap-1_5"><h3>Save as an insight</h3><p class="small soft">The charts are kept as they are now, with what you write.</p>${draftForm('insight-save', saving.text, savingBusy)}</div>` : ''}`
      : '';
    const charts = picked
      .map(
        (p) => `<div class="card stack gap-1_5">
          <div class="row justify-between"><strong><code>${esc(p.tag)}</code></strong><span class="small soft">${esc(p.unit ?? '')}</span></div>
          <div data-chart="${esc(p.id)}">${skeleton.chart('Loading the readings…', TIME_CHART.height)}</div>
          <div data-wear="${esc(p.id)}"></div>
        </div>`,
      )
      .join('');
    return `${head}<div class="card stack gap-3">
        <form id="explorer-search" class="row gap-3 wrap" role="search">
          <label class="field grow min-w-field">Add a signal<input type="search" name="q" placeholder="Tag, description or node" autocomplete="off"></label>
        </form>
        <div class="row gap-1_5 wrap" data-explorer-found></div>
        ${picked.length ? `<div class="row gap-1_5 wrap" data-picked>${chips}</div>` : '<p class="small soft">Pick up to eight signals to plot them on one time axis.</p>'}
        ${rangeBar}
      </div>
      <div class="stack gap-3 mt-3" data-charts>${charts}</div>`;
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
            ctx.toast('Choose a start before the end');
            return;
          }
          if (to - from > MAX_SPAN) {
            ctx.toast('Choose at most five years');
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
  },
};

export default view;
