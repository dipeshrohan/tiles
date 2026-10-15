import { ux } from '../lib/analytics.ts';
import { esc, field, fmt, need, onAll, onSubmit, bound } from '../lib/dom.ts';
import {
  LINKED,
  QUALITY_FILTERS,
  SIGNAL_SOURCES,
  type MappingSuggestion,
  type QualityReport,
  type SignalChange,
  type SignalInfo,
  type SignalQuery,
} from '../lib/api.ts';
import { oneOf } from '../lib/url-state.ts';
import type { Context, View } from './types.ts';
import { bindFilterBar, filterBar, type BarOptions } from '../lib/filter-bar.ts';
import { isFieldError, showErrors, type FieldError } from '../lib/forms.ts';
import {
  badge,
  button,
  card,
  emptyState,
  field as labelled,
  linkButton,
  input,
  needsApi,
  pageHead,
  select,
  type Tone,
  apiUnreachable,
  skeleton,
  setBusy,
  loadFailed,
} from '../lib/ui.ts';
import { keyAttrs } from '../lib/shortcuts.ts';
import { bindTable, dataTable, type Column, type TableOptions } from '../lib/data-table.ts';
import { t, tHtml, type MessageKey } from '../lib/i18n.ts';
import { dateTime, percent as percentOf } from '../lib/format.ts';

// Signal catalogue (T2.08): every tag the site has readings for, searchable, with what is known
// about it. Engineers add the unit, sample rate and a description, and link each tag to its
// Signal node in the ontology. Each signal shows the badge of its latest data-quality check
// (T2.09): gaps, stuck values, out-of-range values, unit mismatches.

// The catalogue is fetched a page at a time, the table filling as they come (virtual rows past 200,
// U5.02), up to MAX_ROWS: a search narrows it beyond.
const PAGE = 500;
const MAX_ROWS = 10_000;
const PLOT_MAX = 8; // the Data explorer's limit
const CHECK_MAX = 1000; // signals the API checks in one request

interface Ui {
  query: Required<Pick<SignalQuery, 'q' | 'source' | 'linked' | 'quality'>>;
  editing: string | null; // the signal being edited
  skipped: string[]; // mapping suggestions skipped (signal ids)
  open: string | null; // the signal whose quality report is shown
}

let results: { total: number; signals: SignalInfo[]; loading?: boolean } | null = null;
let failed = false;
let checking = false;
let latestSearch = 0; // answers to earlier searches are dropped
let resultsFor = ''; // the catalogue `results` came from: see catalogue()
let resultsQuery = ''; // and the search they answer
let saving: string | null = null; // the signal whose change is being saved

// Which catalogue is shown: the API, the site and who is asking. Results from another are never shown.
export const catalogue = (ctx: Context): string =>
  [ctx.api?.baseUrl ?? '', ctx.ontology.site?.id ?? '', ctx.state.user.email, ctx.auth.signedIn].join('|');
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const ui = (ctx: Context): Ui =>
  ctx.ui<Ui>('signals', {
    query: { q: '', source: '', linked: '', quality: '' },
    editing: null,
    open: null,
    skipped: [],
  });

export function sourceLabel(source: string): string {
  const [kind, ...rest] = source.split(':');
  const name = rest.join(':');
  if (kind === 'edge') return t('signals.source.edge', { name });
  if (kind === 'import') return t('signals.source.import', { name });
  return source === 'manual' ? t('signals.source.manual') : source;
}

export function latest(s: Pick<SignalInfo, 'last_value' | 'last_at' | 'unit'>): string {
  if (s.last_at === null || s.last_value === null) return '—';
  const v = s.last_value;
  const value = typeof v === 'number' ? String(+v.toPrecision(6)) : String(v);
  const unit = typeof v === 'number' && s.unit ? ` ${s.unit}` : '';
  return `${value}${unit} · ${dateTime(s.last_at)}`;
}

const QUALITY: Record<QualityReport['badge'] | 'unchecked', [MessageKey, Tone]> = {
  good: ['signals.quality.good', 'good'],
  warn: ['signals.quality.warn', 'warn'],
  bad: ['signals.quality.bad', 'bad'],
  unknown: ['signals.quality.unknown', ''],
  unchecked: ['signals.quality.unchecked', ''],
};

export function qualityBadge(report: QualityReport | null): string {
  const [key, tone] = QUALITY[report ? report.badge : 'unchecked'];
  const label = t(key);
  const title = report?.issues.length ? report.issues.map((i) => i.message).join('\n') : label;
  return badge(label, tone, { title });
}

// Rounded down, as the API does, so a share just below a limit doesn't read as on it.
const percent = (x: number) => percentOf(Math.floor(x * 1000) / 1000, 1); // never rounded up to 100%

// The report behind a badge: what was checked and what was found.
export function qualityDetail(report: QualityReport): string {
  const when = dateTime(report.checked_at);
  const facts = [
    t('signals.quality.readings', {
      count: report.readings,
      n: fmt(report.readings, 0),
      hours: +report.window_hours.toPrecision(3),
    }),
    report.period_s === null ? '' : t('signals.quality.expected', { seconds: +report.period_s.toPrecision(3) }),
    report.coverage === null ? '' : t('signals.quality.coverage', { percent: percent(report.coverage) }),
  ].filter(Boolean);
  const issues = report.issues.length
    ? `<ul class="small">${report.issues.map((i) => `<li>${badge(t(i.severity === 'bad' ? 'signals.quality.problem' : 'signals.quality.warning'), i.severity)} ${esc(i.message)}</li>`).join('')}</ul>`
    : `<p class="small">${esc(t(report.readings ? 'signals.quality.none' : 'signals.quality.noReadings'))}</p>`;
  return `<div class="stack gap-1_5"><p class="small soft">${esc(t('signals.quality.checked', { when, facts: facts.join(', ') }))}</p>${issues}</div>`;
}

function number(text: string): number | null | undefined {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

// What the edit form changes, as the API takes it: only fields that differ; blanks clear.
export function changeFrom(
  form: {
    unit: string;
    rate: string;
    description: string;
    node: string;
    min?: string;
    max?: string;
    stuck?: string; // minutes
    events?: string; // '' (a measurement), downtime, scrap or other
    asset?: string;
  },
  s: SignalInfo,
): SignalChange | FieldError {
  const change: SignalChange = {};
  if (form.events !== undefined) {
    const kind = (form.events || null) as SignalInfo['event_kind'];
    if (kind !== s.event_kind) change.event_kind = kind;
  }
  if (form.asset !== undefined && form.asset !== (s.asset ?? '')) {
    const asset = form.asset.trim() || null;
    if (asset !== s.asset) change.asset = asset;
  }
  // A text field the user left as it was is not sent, even if stored with spaces around it.
  if (form.unit !== (s.unit ?? '')) {
    const unit = form.unit.trim() || null;
    if (unit !== s.unit) change.unit = unit;
  }
  const rate = number(form.rate);
  if (rate === undefined || (rate !== null && rate <= 0)) return { name: 'rate', message: t('signals.error.rate') };
  if (rate !== s.sample_rate_hz) change.sample_rate_hz = rate;
  if (form.description !== s.description) {
    const description = form.description.trim();
    if (description !== s.description) change.description = description;
  }
  const node = form.node || null;
  if (node !== s.node_id) change.node_id = node;
  const min = number(form.min ?? '');
  const max = number(form.max ?? '');
  if (min === undefined || max === undefined)
    return {
      name: min === undefined ? 'min' : 'max',
      message: t('signals.error.range'),
    };
  if (min !== null && max !== null && min >= max) return { name: 'max', message: t('signals.error.rangeOrder') };
  if (min !== s.range_min) change.range_min = min;
  if (max !== s.range_max) change.range_max = max;
  const stuck = number(form.stuck ?? '');
  if (stuck === undefined || (stuck !== null && (stuck <= 0 || stuck > 30 * 24 * 60)))
    return { name: 'stuck', message: t('signals.error.stuck') };
  const stuckS = stuck === null ? null : stuck * 60;
  // Minutes shown and read back can differ from the stored seconds in the last digits: not an edit.
  const sameStuck =
    stuckS === null || s.stuck_after_s === null
      ? stuckS === s.stuck_after_s
      : Math.abs(stuckS - s.stuck_after_s) < 1e-6;
  if (!sameStuck) change.stuck_after_s = stuckS;
  return change;
}

// An event stream's kind and asset (T3.10); an asset alone for a measurement that names one.
function eventBadge(s: SignalInfo): string {
  if (!s.event_kind && !s.asset) return '';
  const text = [s.event_kind ? t('signals.eventKind', { kind: s.event_kind }) : '', s.asset ?? '']
    .filter(Boolean)
    .join(' · ');
  return ` ${badge(text, '', { attrs: { 'data-event-badge': true } })}`;
}

function linkCell(s: SignalInfo): string {
  if (!s.node_id) return '<span class="soft">—</span>';
  return s.node_label !== null // a label may be empty: the node is still there
    ? `<a href="#/ontology">${esc(s.node_label || s.node_id)}</a>`
    : badge(t('signals.missingNode'), 'warn', { title: t('signals.missingNodeHint', { node: s.node_id }) });
}

function editRow(ctx: Context, s: SignalInfo): string {
  const nodes = Object.values(ctx.state.repo.head.nodes)
    .filter((n) => n.type === 'Signal')
    .sort((a, b) => a.label.localeCompare(b.label));
  const nodeOptions: (readonly [string, string])[] = [
    ['', t('signals.edit.notLinked')],
    ...(s.node_id && !nodes.some((n) => n.id === s.node_id)
      ? [[s.node_id, t('signals.edit.missing', { id: s.node_id })] as const]
      : []),
    ...nodes.map((n) => [n.id, `${n.label} (${n.id})`] as const),
  ];
  const stuck = s.stuck_after_s === null ? '' : String(+(s.stuck_after_s / 60).toPrecision(12));
  return `<tr class="edit-row"><td colspan="100">
      <form id="signal-form" data-signal="${esc(s.id)}" class="row gap-3 wrap items-end">
        <fieldset class="contents" ${saving === s.id ? 'disabled' : ''}>
        ${labelled(t('signals.edit.unit'), input({ name: 'unit', value: s.unit ?? '', class: 'w-7em', attrs: { placeholder: t('signals.edit.unitPlaceholder'), maxlength: 40 } }))}
        ${labelled(t('signals.edit.rate'), input({ name: 'rate', value: String(s.sample_rate_hz ?? ''), class: 'w-7em', attrs: { inputmode: 'decimal', 'data-api': 'sample_rate_hz' } }))}
        ${labelled(t('signals.edit.description'), input({ name: 'description', value: s.description, attrs: { maxlength: 1000 } }), { class: 'grow min-w-field' })}
        ${labelled(t('signals.edit.node'), select('node', nodeOptions, s.node_id ?? '', { attrs: { 'data-api': 'node_id' } }))}
        ${labelled(t('signals.edit.min'), input({ name: 'min', value: String(s.range_min ?? ''), class: 'w-7em', attrs: { inputmode: 'decimal', 'data-api': 'range_min' } }))}
        ${labelled(t('signals.edit.max'), input({ name: 'max', value: String(s.range_max ?? ''), class: 'w-7em', attrs: { inputmode: 'decimal', 'data-api': 'range_max' } }))}
        ${labelled(t('signals.edit.stuck'), input({ name: 'stuck', value: stuck, class: 'w-6em', attrs: { placeholder: '60', inputmode: 'decimal', 'data-api': 'stuck_after_s' } }))}
        ${labelled(
          t('signals.edit.events'),
          select(
            'events',
            [
              ['', t('signals.edit.eventsNone')],
              ['downtime', t('signals.edit.downtime')],
              ['scrap', t('signals.edit.scrap')],
              ['other', t('signals.edit.other')],
            ],
            s.event_kind ?? '',
            { attrs: { 'data-api': 'event_kind' } },
          ),
          { title: t('signals.edit.eventsHint') },
        )}
        ${labelled(
          t('signals.edit.asset'),
          input({
            name: 'asset',
            value: s.asset ?? '',
            class: 'w-8em',
            attrs: { placeholder: t('signals.edit.assetPlaceholder'), maxlength: 100 },
          }),
          {
            title: t('signals.edit.assetHint'),
          },
        )}
        ${button(t('signals.edit.save'), { variant: 'primary', type: 'submit', busy: saving === s.id })}
        ${button(t('signals.edit.cancel'), { attrs: { 'data-cancel-edit': true } })}
        </fieldset>
      </form>
      ${nodes.length ? '' : `<p class="small soft">${esc(t('signals.edit.noNodes'))}</p>`}
    </td></tr>`;
}

export function resultsTable(ctx: Context, page: { total: number; signals: SignalInfo[] }, canEdit: boolean): string {
  if (!page.signals.length) {
    const searched = Object.values(ui(ctx).query).some(Boolean);
    return searched
      ? emptyState({
          illustration: 'search',
          compact: true,
          level: 3,
          title: t('signals.empty.noMatch'),
          body: t('signals.empty.noMatchBody'),
          action: button(t('signals.empty.clear'), { size: 'sm', attrs: { 'data-clear-search': true } }),
        })
      : emptyState({
          illustration: 'chart',
          compact: true,
          level: 3,
          title: t('signals.empty.none'),
          body: canEdit ? t('signals.empty.noneEngineer') : t('signals.empty.noneViewer'),
          action: canEdit
            ? linkButton(t('signals.empty.import'), '#/import', { variant: 'primary', size: 'sm', icon: 'upload' })
            : undefined,
        });
  }
  return dataTable(tableOptions(ctx, page, canEdit));
}

const QUALITY_RANK: Record<string, number> = { bad: 0, warn: 1, unknown: 2, good: 3 };

// The catalogue as a table (U5.02): sorted, its columns chosen, signals selected to plot or check.
export function tableOptions(
  ctx: Context,
  page: { total: number; signals: SignalInfo[]; loading?: boolean },
  canEdit: boolean,
): TableOptions<SignalInfo> {
  const { editing, open } = ui(ctx);
  const more = page.loading
    ? ` ${t('signals.table.loadingMore', { n: fmt(page.total - page.signals.length, 0) })}`
    : page.total > page.signals.length
      ? ` ${t('signals.table.firstOnly', { n: fmt(page.signals.length, 0) })}`
      : '';
  const columns: Column<SignalInfo>[] = [
    {
      key: 'tag',
      label: t('signals.table.tag'),
      value: (s) => s.tag,
      cell: (s) =>
        `<a href="#/explorer?signal=${esc(encodeURIComponent(s.id))}" title="${esc(t('signals.table.plotIt'))}"><code>${esc(s.tag)}</code></a>${eventBadge(s)}`,
    },
    {
      key: 'description',
      label: t('signals.table.description'),
      value: (s) => s.description,
      cell: (s) => esc(s.description) || '<span class="soft">—</span>',
    },
    { key: 'unit', label: t('signals.table.unit'), value: (s) => s.unit, cell: (s) => esc(s.unit ?? '—') },
    {
      key: 'rate',
      label: t('signals.table.rate'),
      numeric: true,
      value: (s) => s.sample_rate_hz,
      cell: (s) => (s.sample_rate_hz === null ? '—' : `${esc(String(s.sample_rate_hz))} Hz`),
    },
    {
      key: 'source',
      label: t('signals.table.source'),
      value: (s) => sourceLabel(s.source),
      cell: (s) => esc(sourceLabel(s.source)),
    },
    {
      key: 'node',
      label: t('signals.table.node'),
      value: (s) => s.node_label ?? s.node_id,
      csv: (s) => s.node_label ?? s.node_id ?? '',
      cell: (s) => linkCell(s),
    },
    { key: 'latest', label: t('signals.table.latest'), value: (s) => s.last_at, cell: (s) => esc(latest(s)) },
    {
      key: 'quality',
      label: t('signals.table.quality'),
      value: (s) => (s.quality ? (QUALITY_RANK[s.quality.badge] ?? 4) : null),
      csv: (s) => s.quality?.badge ?? t('signals.table.notChecked'),
      cell: (s) =>
        s.quality
          ? `<button class="btn-link" type="button" data-quality="${esc(s.id)}" aria-expanded="${open === s.id}">${qualityBadge(s.quality)}</button>`
          : qualityBadge(null),
    },
    {
      key: 'actions',
      label: t('signals.table.actions'),
      srOnly: true,
      fixed: true,
      cell: (s) =>
        canEdit && editing !== s.id
          ? button(t('signals.table.edit'), { size: 'sm', attrs: { 'data-edit': s.id } })
          : '',
    },
  ];
  return {
    id: 'signals',
    label: t('signals.table.label'),
    columns,
    rows: page.signals,
    key: (s) => s.id,
    empty: '',
    status: `<p class="small soft m-0" data-signal-count>${esc(t('signals.table.count', { count: page.total, n: fmt(page.total, 0) }))}${esc(more)}</p>`,
    rowAttrs: (s) => ({ 'data-row': s.id }),
    after: (s) =>
      `${open === s.id && s.quality ? `<tr class="quality-row" data-key="quality-${esc(s.id)}"><td colspan="100">${qualityDetail(s.quality)}</td></tr>` : ''}${
        canEdit && editing === s.id ? editRow(ctx, s) : ''
      }`,
    select: {
      actions: [
        { id: 'plot', label: t('signals.table.plot'), variant: 'primary' },
        ...(canEdit ? [{ id: 'check', label: t('signals.table.check') }] : []),
      ],
      run: (action, keys) => bulk(ctx, action, keys),
    },
    csv: 'signals.csv',
    drawn: () => {
      const root = document.querySelector<HTMLElement>('#view');
      if (root) bindResults(root, ctx);
    },
  };
}

// What the bar of bulk actions does with the signals selected.
function bulk(ctx: Context, action: string, keys: string[]): Promise<unknown> | void {
  const site = ctx.ontology.site;
  if (action === 'plot') {
    if (keys.length > PLOT_MAX) {
      ctx.toast(t('signals.plot.tooMany', { max: PLOT_MAX }), {
        description: t('signals.plot.tooManyHint', { max: PLOT_MAX, count: keys.length }),
      });
      return;
    }
    location.hash = `#/explorer?signals=${keys.map(encodeURIComponent).join(',')}`;
    return;
  }
  if (action === 'check' && ctx.api && site) {
    const api = ctx.api;
    // The API checks up to CHECK_MAX at a time: larger selections go in turns.
    const chunks = Array.from({ length: Math.ceil(keys.length / CHECK_MAX) }, (_, i) =>
      keys.slice(i * CHECK_MAX, (i + 1) * CHECK_MAX),
    );
    return chunks
      .reduce<Promise<{ checked: number; badges: Record<string, number> }>>(
        (sum, ids) =>
          sum.then((t) =>
            api.signals.checkQuality(site.id, ids).then((r) => ({
              checked: t.checked + r.checked,
              badges: Object.fromEntries(Object.entries(r.badges).map(([k, v]) => [k, (t.badges[k] ?? 0) + v])),
            })),
          ),
        Promise.resolve({ checked: 0, badges: {} }),
      )
      .then((r) => {
        ctx.toast(t('signals.check.done', { count: r.checked }), {
          type: 'success',
          description: t('signals.check.badges', {
            good: r.badges.good ?? 0,
            warn: r.badges.warn ?? 0,
            bad: r.badges.bad ?? 0,
          }),
        });
        ux('task', 'signal.quality-checked');
        const root = document.querySelector<HTMLElement>('#view');
        if (root) void search(root, ctx);
      });
  }
}

async function search(root: HTMLElement, ctx: Context): Promise<void> {
  const site = ctx.ontology.site;
  // A search typed on a page that has since been left asks for nothing (`root` stays, its content changes).
  if (!ctx.api || !site || !root.querySelector('#signal-search')) return;
  const mine = ++latestSearch;
  const from = catalogue(ctx);
  const query = JSON.stringify(ui(ctx).query);
  let page: typeof results = null;
  try {
    page = await ctx.api.signals.list(site.id, { ...ui(ctx).query, limit: PAGE });
  } catch {
    // shown below, unless a later search has answered
  }
  if (mine !== latestSearch) return;
  // The rest of the catalogue a page at a time, the table filling as they come.
  if (page && page.signals.length < Math.min(page.total, MAX_ROWS)) {
    const first = page;
    const asked = { ...ui(ctx).query }; // the search these pages answer, whatever is typed meanwhile
    void (async () => {
      const all = [...first.signals];
      for (let offset = PAGE; offset < Math.min(first.total, MAX_ROWS); offset += PAGE) {
        let next: { total: number; signals: SignalInfo[] };
        try {
          next = await ctx.api!.signals.list(site.id, { ...asked, limit: PAGE, offset });
        } catch {
          break; // the client showed why; what came stays
        }
        if (mine !== latestSearch || JSON.stringify(ui(ctx).query) !== query) return;
        all.push(...next.signals);
        results = { total: first.total, signals: [...all], loading: all.length < Math.min(first.total, MAX_ROWS) };
        if (!next.signals.length) break;
        fill(root, ctx);
      }
      if (mine !== latestSearch || !results) return;
      results.loading = false;
      fill(root, ctx);
    })();
    page = { ...page, loading: true };
  }
  if (!page && results && resultsFor === from && resultsQuery === query) return; // keep the last answer to it
  results = page;
  resultsFor = from;
  resultsQuery = query;
  failed = page === null;
  fill(root, ctx);
}

// Whether an input still shows what was rendered into it. A one-line input drops line breaks from
// its value (HTML's value sanitization), so they don't count as an edit.
export const untouched = (el: Pick<HTMLInputElement, 'value' | 'defaultValue'>): boolean =>
  el.value === el.defaultValue.replace(/[\r\n]/g, '');

// The filter bar and saved views (U5.06): the search and filters as chips, with how many match.
let bar: { redraw(): void } | null = null;
function barOptions(ctx: Context): BarOptions {
  return {
    page: 'signals',
    filters: () => ({ ...ui(ctx).query }),
    count: () =>
      results && !failed && resultsQuery === JSON.stringify(ui(ctx).query)
        ? t('signals.bar.count', { count: results.total, n: fmt(results.total) })
        : '',
    apply: (f) => {
      const u = ui(ctx);
      u.query = {
        q: f.q ?? '',
        source: (f.source ?? '') as Ui['query']['source'],
        linked: (f.linked ?? '') as Ui['query']['linked'],
        quality: (f.quality ?? '') as Ui['query']['quality'],
      };
      u.editing = null;
      ctx.rerender();
    },
  };
}

function fill(root: HTMLElement, ctx: Context): void {
  const box = root.querySelector('[data-signal-results]');
  if (!box) return;
  bar?.redraw();
  // An edit in progress survives the refresh: its fields, and where the cursor was.
  const form = box.querySelector<HTMLFormElement>('#signal-form');
  // Only fields the user changed: the rest show what the refresh brings (another engineer's edit, say).
  const changed = form
    ? [...form.elements].flatMap((el): [string, string][] =>
        (el instanceof HTMLInputElement && !untouched(el)) ||
        (el instanceof HTMLSelectElement && [...el.options].some((o) => o.selected !== o.defaultSelected))
          ? [[el.name, el.value]]
          : [],
      )
    : [];
  const typed = form ? { signal: form.dataset.signal, values: changed } : null;
  const focused = form?.contains(document.activeElement) ? document.activeElement?.getAttribute('name') : null;
  const canEdit = ctx.ontology.role !== 'viewer';
  // Where the table was scrolled to, kept as its pages arrive and it is drawn again.
  const frame = box.querySelector('.table-frame');
  const scrolled = frame ? { top: frame.scrollTop, left: frame.scrollLeft } : null;
  box.innerHTML = failed
    ? loadFailed(t('signals.loadFailed'))
    : results
      ? resultsTable(ctx, results, canEdit)
      : skeleton.table(6, 9, t('signals.loading'));
  const frameAfter = box.querySelector('.table-frame');
  if (frameAfter && scrolled) {
    frameAfter.scrollTop = scrolled.top;
    frameAfter.scrollLeft = scrolled.left;
  }
  if (results?.signals.length && !failed) bindTable(box, tableOptions(ctx, results, canEdit));
  const again = box.querySelector<HTMLFormElement>('#signal-form');
  if (typed && again && again.dataset.signal === typed.signal) {
    for (const [name, value] of typed.values) {
      const el = again.elements.namedItem(name);
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = value;
    }
    if (focused) (again.elements.namedItem(focused) as HTMLElement | null)?.focus();
  }
  bindResults(root, ctx);
}

// The rows' buttons, wired once per binding on the box that holds the table (the table draws rows
// again as it scrolls and sorts), and the edit form each time one is drawn.
const delegated = new WeakMap<Element, AbortSignal>();
const formsBound = new WeakMap<Element, AbortSignal>();

function bindResults(root: HTMLElement, ctx: Context): void {
  const box = root.querySelector<HTMLElement>('[data-signal-results]');
  if (box && delegated.get(box) !== bound()) {
    delegated.set(box, bound());
    box.addEventListener(
      'click',
      (e) => {
        const t = e.target instanceof Element ? e.target : null;
        const quality = t?.closest<HTMLElement>('[data-quality]')?.dataset.quality;
        const edit = t?.closest<HTMLElement>('[data-edit]')?.dataset.edit;
        if (quality !== undefined) {
          const u = ui(ctx);
          u.open = u.open === quality ? null : quality;
          fill(root, ctx);
        } else if (edit !== undefined) {
          ui(ctx).editing = edit;
          fill(root, ctx);
        } else if (t?.closest('[data-cancel-edit]')) {
          ui(ctx).editing = null;
          fill(root, ctx);
        }
      },
      { signal: bound() },
    );
  }
  const form = root.querySelector('#signal-form');
  if (!form || formsBound.get(form) === bound()) return;
  formsBound.set(form, bound());
  onSubmit(root, '#signal-form', (form) => {
    const site = ctx.ontology.site;
    const sig = results?.signals.find((s) => s.id === form.dataset.signal);
    if (!site || !ctx.api || !sig) return;
    if (saving) {
      const other = results?.signals.find((s) => s.id === saving);
      ctx.toast(t('signals.save.wait', { name: other ? other.tag : t('signals.save.otherChange') }));
      return;
    }
    // A text field the user didn't touch stands for its stored value: the browser may show it changed
    // (a one-line input drops line breaks), and that must not count as an edit.
    const text = (name: string, stored: string) => {
      const el = form.elements.namedItem(name);
      return el instanceof HTMLInputElement && untouched(el) ? stored : field(form, name);
    };
    const change = changeFrom(
      {
        unit: text('unit', sig.unit ?? ''),
        rate: field(form, 'rate'),
        description: text('description', sig.description),
        node: field(form, 'node'),
        min: field(form, 'min'),
        max: field(form, 'max'),
        stuck: field(form, 'stuck'),
        events: field(form, 'events'),
        asset: text('asset', sig.asset ?? ''),
      },
      sig,
    );
    if (isFieldError(change)) {
      showErrors(form, [change]);
      return;
    }
    if (!Object.keys(change).length) {
      ui(ctx).editing = null;
      fill(root, ctx);
      return;
    }
    // The form is locked while the change is saved: nothing typed meanwhile is lost, nothing sent twice.
    saving = sig.id;
    fill(root, ctx);
    return ctx.api.signals.update(site.id, sig.id, change).then(
      (updated) => {
        saving = null;
        if (results) results.signals = results.signals.map((s) => (s.id === updated.id ? updated : s));
        if (ui(ctx).editing === sig.id) ui(ctx).editing = null; // not another signal opened meanwhile
        ctx.toast(t('signals.save.saved', { tag: updated.tag }));
        ux('task', 'signal.saved');
        fill(root, ctx);
        void search(root, ctx); // the change may take it out of (or into) the current search
      },
      () => {
        saving = null; // the client showed why; the form opens again as it was
        fill(root, ctx);
      },
    );
  });
}

// ---- mapping suggestions (T2.11) ------------------------------------------

let mapping: { for: string; unmapped: number; staged: string[]; items: MappingSuggestion[] } | null = null;
let suggesting = false;
let linkingAll = false; // while Link all runs, the other buttons wait

export function suggestionRow(s: MappingSuggestion, canEdit: boolean, busy = false): string {
  const what =
    s.kind === 'link'
      ? `${badge(t('signals.map.linkTo'), 'good')} ${esc(s.node_label)}`
      : `${badge(t('signals.map.newNode'), 'accent')} ${esc(s.node_label)}`;
  return `<div class="suggestion" data-suggestion="${esc(s.signal_id)}">
      <div class="row gap-2 wrap items-center">
        <code>${esc(s.tag)}</code><span class="soft">→</span>${what}
        <span class="small soft" title="${esc(t('signals.map.sure'))}">${Math.round(s.score * 100)}%</span>
        <span class="grow"></span>
        ${canEdit ? `${button(t(s.kind === 'link' ? 'signals.map.link' : 'signals.map.stage'), { size: 'sm', variant: 'primary', disabled: busy, attrs: { 'data-accept': s.signal_id } })}${button(t('signals.map.skip'), { size: 'sm', disabled: busy, attrs: { 'data-skip': s.signal_id } })}` : ''}
      </div>
      <ul class="small soft mt-1 ml-4 m-0">${s.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>`;
}

const ontologyLink = (): string => `<a href="#/ontology">${esc(t('signals.map.ontology'))}</a>`;

function mappingHtml(ctx: Context): string {
  if (!mapping || mapping.for !== catalogue(ctx)) return '';
  const skipped = new Set(ui(ctx).skipped);
  const items = mapping.items.filter((s) => !skipped.has(s.signal_id));
  const staged = mapping.staged.length
    ? `<p class="small">${tHtml('signals.map.staged', { tags: mapping.staged.map((tag) => `<code>${esc(tag)}</code>`).join(', '), link: ontologyLink() })}</p>`
    : '';
  if (!mapping.unmapped) return `<p class="small soft">${esc(t('signals.map.allLinked'))}</p>`;
  if (!items.length)
    return `${staged}<p class="small soft">${esc(t(skipped.size ? 'signals.map.noneLeftSkipped' : 'signals.map.noneLeft'))}</p>`;
  const canEdit = ctx.ontology.role !== 'viewer';
  const links = items.filter((s) => s.kind === 'link').length;
  const shown = mapping.items.length + mapping.staged.length;
  const suggestions =
    mapping.unmapped > shown
      ? t('signals.map.countOf', { count: items.length, shown: mapping.items.length, unmapped: mapping.unmapped })
      : t('signals.map.count', { count: items.length });
  return `${staged}<p class="small soft">${tHtml('signals.map.lead', { suggestions: esc(suggestions), link: ontologyLink() })}</p>
    ${canEdit && links > 1 ? `<div>${button(t('signals.map.linkAll', { count: links }), { size: 'sm', disabled: linkingAll, attrs: { 'data-accept-links': true } })}</div>` : ''}
    <div class="stack gap-2_5">${items.map((s) => suggestionRow(s, canEdit, linkingAll)).join('')}</div>`;
}

function fillMapping(root: HTMLElement, ctx: Context): void {
  const box = root.querySelector<HTMLElement>('[data-mapping-results]');
  if (!box) return;
  box.innerHTML = mappingHtml(ctx);
  bindMapping(root, ctx);
}

async function suggest(root: HTMLElement, ctx: Context): Promise<void> {
  const site = ctx.ontology.site;
  if (!ctx.api || !site || suggesting) return;
  suggesting = true;
  const from = catalogue(ctx);
  try {
    const out = await ctx.api.signals.suggestions(site.id);
    mapping = { for: from, unmapped: out.unmapped, staged: out.staged, items: out.suggestions };
    ui(ctx).skipped = [];
  } catch {
    // the client showed why
  } finally {
    suggesting = false;
  }
  if (root.querySelector('[data-mapping]')) fillMapping(root, ctx);
}

async function accept(root: HTMLElement, ctx: Context, s: MappingSuggestion): Promise<boolean> {
  const site = ctx.ontology.site;
  if (!ctx.api || !site) return false;
  const ok =
    s.kind === 'link'
      ? await ctx.api.signals.update(site.id, s.signal_id, { node_id: s.node_id }).then(
          () => true,
          () => false, // the client showed why
        )
      : await ctx.ontology.act((store, repo) => store.stage(repo, s.ops));
  if (ok && mapping) {
    mapping.items = mapping.items.filter((x) => x.signal_id !== s.signal_id);
    if (s.kind === 'link')
      mapping.unmapped -= 1; // a staged node leaves its tag unlinked until committed
    else mapping.staged = [...mapping.staged, s.tag];
  }
  return ok;
}

function bindMapping(root: HTMLElement, ctx: Context): void {
  const find = (id: string | undefined) => mapping?.items.find((s) => s.signal_id === id);
  onAll(root, '[data-accept]', 'click', (el) => {
    const s = find(el.dataset.accept);
    if (!s || linkingAll) return;
    el.setAttribute('disabled', '');
    void accept(root, ctx, s).then((ok) => {
      if (ok)
        ctx.toast(
          s.kind === 'link'
            ? t('signals.map.linked', { tag: s.tag })
            : t('signals.map.stagedToast', { label: s.node_label }),
        );
      fillMapping(root, ctx);
      if (ok && s.kind === 'link') void search(root, ctx);
    });
  });
  onAll(root, '[data-skip]', 'click', (el) => {
    if (el.dataset.skip) ui(ctx).skipped = [...ui(ctx).skipped, el.dataset.skip];
    fillMapping(root, ctx);
  });
  onAll(root, '[data-accept-links]', 'click', () => {
    if (linkingAll) return;
    const skipped = new Set(ui(ctx).skipped);
    const links = (mapping?.items ?? []).filter((s) => s.kind === 'link' && !skipped.has(s.signal_id));
    linkingAll = true;
    fillMapping(root, ctx); // every button waits
    void (async () => {
      let done = 0;
      try {
        for (const s of links) if (await accept(root, ctx, s)) done++;
      } finally {
        linkingAll = false;
      }
      ctx.toast(t('signals.map.linkedAll', { count: links.length, done }));
      fillMapping(root, ctx);
      void search(root, ctx);
    })();
  });
}

const view: View = {
  id: 'signals',
  get title() {
    return t('signals.title');
  },
  icon: 'activity',
  // Its search and filters, in the address (U3.05): `#/signals?q=press&linked=no`.
  query: {
    read(params, ctx) {
      ui(ctx).query = {
        q: (params.get('q') ?? '').slice(0, 200),
        source: oneOf<(typeof SIGNAL_SOURCES)[number] | ''>(params.get('source'), SIGNAL_SOURCES, ''),
        linked: oneOf<(typeof LINKED)[number] | ''>(params.get('linked'), LINKED, ''),
        quality: oneOf<(typeof QUALITY_FILTERS)[number] | ''>(params.get('quality'), QUALITY_FILTERS, ''),
      };
    },
    write(ctx) {
      return { ...ui(ctx).query };
    },
  },
  render(ctx) {
    const head = pageHead({
      eyebrow: t('signals.eyebrow'),
      title: t('signals.title'),
      lead: t('signals.lead'),
    });
    if (!ctx.api) return `${head}${card(needsApi(t('signals.needsApi')))}`;
    if (!ctx.ontology.site)
      return `${head}${
        ctx.ontology.status === 'error'
          ? apiUnreachable(ctx.ontology.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })
          : card(skeleton.card(t('signals.loadingSite')))
      }`;
    const { query } = ui(ctx);
    const search = `<form id="signal-search" class="row gap-3 wrap" role="search">
          ${labelled(t('signals.filter.search'), input({ type: 'search', name: 'q', value: query.q, placeholder: t('signals.filter.placeholder'), attrs: keyAttrs('/') }), { class: 'grow min-w-field' })}
          ${labelled(
            t('signals.filter.source'),
            select(
              'source',
              [
                ['', t('signals.filter.any')],
                ['edge', t('signals.filter.edge')],
                ['import', t('signals.filter.imports')],
                ['manual', t('signals.source.manual')],
              ],
              query.source,
            ),
          )}
          ${labelled(
            t('signals.filter.link'),
            select(
              'linked',
              [
                ['', t('signals.filter.any')],
                ['yes', t('signals.filter.linked')],
                ['no', t('signals.filter.notLinked')],
              ],
              query.linked,
            ),
          )}
          ${labelled(
            t('signals.filter.quality'),
            select(
              'quality',
              [
                ['', t('signals.filter.any')],
                ['bad', t('signals.quality.bad')],
                ['warn', t('signals.quality.warn')],
                ['good', t('signals.quality.good')],
                ['unknown', t('signals.quality.unknown')],
                ['unchecked', t('signals.quality.unchecked')],
              ],
              query.quality,
            ),
          )}
          ${
            ctx.ontology.role !== 'viewer'
              ? button(t('signals.check.button'), {
                  busy: checking,
                  attrs: {
                    'data-check-quality': true,
                    title: t('signals.check.hint'),
                  },
                })
              : ''
          }
        </form>`;
    return `${head}${card(`${search}${filterBar(ctx, barOptions(ctx))}<div data-signal-results aria-live="polite">${skeleton.table(6, 9, t('signals.loading'))}</div>`, { class: 'stack gap-3' })}
      ${card(
        `<div class="row justify-between wrap gap-2">
          <div><h2>${esc(t('signals.map.title'))}</h2><p class="small soft">${esc(t('signals.map.hint'))}</p></div>
          ${button(t('signals.map.suggest'), { attrs: { 'data-suggest': true } })}
        </div>
        <div data-mapping-results aria-live="polite">${mappingHtml(ctx)}</div>`,
        { class: 'stack gap-2_5 mt-3', attrs: { 'data-mapping': true } },
      )}`;
  },
  bind(root, ctx) {
    const form = root.querySelector<HTMLFormElement>('#signal-search');
    if (!form) return;
    bar = bindFilterBar(root, ctx, barOptions(ctx));
    clearTimeout(searchTimer); // a search typed on the page this one replaces
    if (results && resultsFor === catalogue(ctx) && resultsQuery === JSON.stringify(ui(ctx).query))
      fill(root, ctx); // show the last answer at once, then refresh it
    else results = null;
    void search(root, ctx);
    const update = () => {
      const u = ui(ctx);
      u.query = {
        q: field(form, 'q'),
        source: field(form, 'source') as Ui['query']['source'],
        linked: field(form, 'linked') as Ui['query']['linked'],
        quality: field(form, 'quality') as Ui['query']['quality'],
      };
      u.editing = null;
      ctx.address(); // the search and filters, in the address as they change
      bar?.redraw();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void search(root, ctx), 250);
    };
    form.addEventListener('input', update, { signal: bound() });
    form.addEventListener('change', update, { signal: bound() });
    // On the results box (drawn afresh with the page), whose contents change as answers arrive.
    need(root, '[data-signal-results]').addEventListener(
      'click',
      (e) => {
        if (!(e.target instanceof Element) || !e.target.closest('[data-clear-search]')) return;
        for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name]')) el.value = '';
        update();
        need<HTMLInputElement>(form, '[name=q]').focus();
      },
      { signal: bound() },
    );
    form.addEventListener(
      'submit',
      (e) => {
        e.preventDefault();
        update();
      },
      { signal: bound() },
    );
    root.querySelector('[data-suggest]')?.addEventListener('click', () => void suggest(root, ctx), { signal: bound() });
    bindMapping(root, ctx);
    const checkButton = root.querySelector<HTMLButtonElement>('[data-check-quality]');
    // The button as it is now: the page may have been left and shown again while a check ran.
    const setButton = (busy: boolean) => {
      const button = root.querySelector<HTMLButtonElement>('[data-check-quality]');
      if (!button) return;
      setBusy(button, busy);
    };
    checkButton?.addEventListener(
      'click',
      () => {
        const site = ctx.ontology.site;
        if (!ctx.api || !site || checking) return;
        // Only the signals listed for this site and search, not an answer to an earlier one.
        const current = results && resultsFor === catalogue(ctx) && resultsQuery === JSON.stringify(ui(ctx).query);
        const ids = current ? (results?.signals.map((s) => s.id) ?? []) : [];
        if (!ids.length) {
          ctx.toast(t(current ? 'signals.check.none' : 'signals.check.wait'));
          return;
        }
        checking = true;
        setButton(true);
        ctx.api.signals
          .checkQuality(site.id, ids)
          .then(
            (out) => {
              const { good, warn, bad, unknown } = out.badges;
              const counts = { count: out.checked, good, warn, bad, unknown };
              ctx.toast(t(unknown ? 'signals.check.resultUnknown' : 'signals.check.result', counts));
              void search(root, ctx);
            },
            () => undefined, // the client showed why
          )
          .finally(() => {
            checking = false;
            setButton(false);
          });
      },
      { signal: bound() },
    );
  },
};

export default view;
