import { esc, onAll, onSubmit, onNavigate, routeOf, bound, onAction, download } from '../lib/dom.ts';
import type { PerformanceReport, PlannedStops } from '../lib/api.ts';
import { duration, HORIZONS, kpis, parseCodes, PERIODS, share, spread, type Kpi } from '../lib/performance.ts';
import { when } from '../lib/warnings.ts';
import type { Context, View } from './types.ts';
import {
  card,
  emptyState,
  needsApi,
  pageHead,
  skeleton,
  apiUnreachable,
  loadFailed,
  term,
  inSentence,
  field,
  input,
  button,
  table,
  kv,
} from '../lib/ui.ts';
import { GLOSSARY } from '../lib/glossary-data.ts';
import { showErrors } from '../lib/forms.ts';
import { dateTime, fromInput, month, number, percent } from '../lib/format.ts';
import {
  change,
  defaultPeriods,
  fileName,
  roiRequest,
  type RoiForm,
  type RoiPeriod,
  type RoiReport,
} from '../lib/roi.ts';
import { t, tHtml } from '../lib/i18n.ts';

// Warning performance (T3.10): how the real warnings did against the downtime and scrap the MES
// reported, live: per detector and in total, with what people resolved them as. Events are
// readings on signals marked as event streams (Signals page), matched to a detector by asset.

interface Ui {
  days: number;
  horizonHours: number;
  codes: string; // as typed
}

const uiState = (ctx: Context) => ctx.ui<Ui>('performance', { days: 30, horizonHours: 8, codes: '' });

let fetched: { key: string; report: PerformanceReport | null } | null = null; // null report: loading
let seq = 0;
// The form as being changed, not yet shown: kept when an answer re-renders the page meanwhile.
let pending: { days: number; horizonHours: number; codes: string } | null = null;
const assetDrafts = new Map<string, string>(); // detector id -> the asset being typed
// The ROI report (T6.01): the form as last sent (drawn again with it) and the report it made.
let roi: { form: RoiForm; report: RoiReport | null } | null = null;
// Planned stops (T7.03): null while loading, 'failed' when the API refused.
let planned: PlannedStops | null | 'failed' = null;
let plannedSeq = 0; // only the latest request's answer is shown
// What the add form held when sent, drawn again until the stop is added (a check that fails keeps it).
let plannedDraft: Record<'asset' | 'from' | 'to' | 'reason', string> | null = null;

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;
const keyFor = (ctx: Context): string => {
  const u = uiState(ctx);
  return `${siteId(ctx)}|${u.days}|${u.horizonHours}|${parseCodes(u.codes).join(',')}`;
};

// Warnings and events come in all the time: each visit fetches afresh.
onNavigate((hash) => {
  if (routeOf(hash) !== 'performance') {
    fetched = null;
    pending = null;
    assetDrafts.clear();
    roi = null;
    planned = null;
    plannedSeq++;
    plannedDraft = null;
  }
});

async function loadPlanned(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const mine = ++plannedSeq;
  let answer: PlannedStops | 'failed';
  try {
    answer = await ctx.api.plannedStops(site);
  } catch {
    answer = 'failed'; // the client showed why
  }
  if (mine !== plannedSeq) return; // a later request, or the page was left
  planned = answer;
  ctx.rerender();
}

async function load(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const key = keyFor(ctx);
  const mine = ++seq;
  fetched = { key, report: null };
  void loadPlanned(ctx); // what the report left out, asked with it
  const u = uiState(ctx);
  try {
    const report = await ctx.api.performance(site, {
      days: u.days,
      horizonHours: u.horizonHours,
      codes: parseCodes(u.codes),
    });
    if (mine === seq) fetched = { key, report };
  } catch {
    if (mine === seq) fetched = { key: `${key}|failed`, report: null }; // the client showed why
  }
  if (mine === seq) ctx.rerender();
}

// A headline's label with its glossary term: the words themselves when they are the term ("Warning
// time (median)"), else the term after them ("Events warned of (recall)").
function kpiLabel(k: Kpi): string {
  if (!k.term) return esc(k.label);
  const name = GLOSSARY[k.term].term;
  if (k.label.toLowerCase().startsWith(name.toLowerCase()))
    return `${term(k.term, k.label.slice(0, name.length))}${esc(k.label.slice(name.length))}`;
  return `${esc(k.label)} (${term(k.term, inSentence(name))})`;
}

function controls(shown: Ui): string {
  const u = pending ?? shown;
  const option = (v: number, label: string, current: number) =>
    `<option value="${v}" ${v === current ? 'selected' : ''}>${label}</option>`;
  return `<form class="card source-bar small" id="performance-form">
      <span class="row gap-3 wrap items-end">
        <label class="row gap-1_5">${esc(t('performance.form.last'))} <select name="days">${PERIODS.map((d) => option(d, esc(t('performance.form.days', { count: d })), u.days)).join('')}</select></label>
        <label class="row gap-1_5" title="${esc(t('performance.form.horizonHint'))}">${esc(t('performance.form.horizon'))} <select name="horizon">${HORIZONS.map((h) => option(h, `${h} h`, u.horizonHours)).join('')}</select></label>
        <label class="row gap-1_5 grow min-w-field">${esc(t('performance.form.codes'))} <input type="text" name="codes" value="${esc(u.codes)}" placeholder="${esc(t('performance.form.codesPlaceholder'))}" class="grow"></label>
        <button class="btn sm primary" type="submit">${esc(t('performance.form.show'))}</button>
      </span>
    </form>`;
}

function detectorsCard(ctx: Context, r: PerformanceReport): string {
  const canEdit = ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';
  const rows = r.detectors
    .map((d) => {
      const asset = canEdit
        ? `<form class="row gap-1_5 nowrap" data-asset-form="${esc(d.id)}"><input type="text" name="asset" value="${esc(assetDrafts.get(d.id) ?? d.asset ?? '')}" maxlength="100" placeholder="${esc(t('performance.assetPlaceholder'))}" aria-label="${esc(t('performance.assetLabel', { name: d.name }))}" class="w-7em"><button class="btn sm" type="submit">${esc(t('performance.set'))}</button></form>`
        : esc(d.asset ?? '–');
      const c = d.confirmed;
      const scored = d.matched
        ? `<td>${d.caught} / ${d.events} · ${share(d.recall)}</td><td>${share(d.precision)}${d.pending_warnings ? ` <span class="small soft">${esc(t('performance.pending', { count: d.pending_warnings }))}</span>` : ''}</td><td>${d.false_per_day === null ? '–' : d.false_per_day.toFixed(2)}</td><td>${spread(d.warning_seconds)}</td>`
        : `<td colspan="4" class="small soft">${esc(t('performance.noAsset'))}</td>`;
      return `<tr data-detector-row="${esc(d.id)}"><td><b>${esc(d.name)}</b><div class="small soft mono">${esc(d.signal_tag)}</div></td><td>${asset}</td><td>${d.warnings}</td>${scored}<td class="small">${esc(t('performance.outcomes', { trueAlarm: c.true_alarm, falseAlarm: c.false_alarm, unknown: c.unknown, open: c.unresolved }))}</td></tr>`;
    })
    .join('');
  const unwatched = r.unwatched.length
    ? `<p class="small soft" data-unwatched>${tHtml('performance.unwatched', { assets: r.unwatched.map((u) => esc(t('performance.unwatchedAsset', { asset: u.asset, count: u.events }))).join(', ') })}</p>`
    : '';
  return `<div class="card stack gap-2_5">
      <h2>${esc(t('performance.byDetector'))}</h2>
      ${
        r.detectors.length
          ? `<div class="table-wrap"><table><thead><tr><th>${term('detector', 'Detector')}</th><th>${term('asset', 'Asset')}</th><th>${esc(t('performance.head.warnings'))}</th><th>${tHtml('performance.head.recall', { term: term('recall', 'recall') })}</th><th>${tHtml('performance.head.precision', { term: term('precision', 'precision') })}</th><th>${term('false-per-day', t('performance.head.falsePerDay'))}</th><th>${tHtml('performance.head.warningTime', { term: term('warning-time', t('performance.head.warningTimeTerm')), spread: term('percentile', 'p10 to p90') })}</th><th>${tHtml('performance.head.outcome', { term: term('outcome', 'outcome') })}</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : emptyState({
              illustration: 'chart',
              compact: true,
              level: 3,
              title: t('performance.noDetectors'),
              body: t('performance.noDetectorsBody'),
            })
      }
      ${unwatched}
    </div>`;
}

function eventsCard(r: PerformanceReport): string {
  const rows = r.events
    .map(
      (e) =>
        `<tr><td>${esc(when(e.at, Date.now()))}</td><td>${esc(e.asset)}</td><td>${esc(e.kind)}</td><td class="mono">${esc(e.code)}</td><td>${
          e.warned_at && e.warning_seconds !== null
            ? `<span class="badge good">${esc(t('performance.warned'))}</span> ${esc(t('performance.ahead', { duration: duration(e.warning_seconds), detector: e.detector ?? t('performance.aDetector') }))}`
            : `<span class="badge bad">${esc(t('performance.missed'))}</span>`
        }</td></tr>`,
    )
    .join('');
  return `<div class="card stack gap-2_5">
      <h2>${esc(t('performance.events'))}</h2>
      ${
        r.events.length
          ? `<div class="table-wrap"><table><thead><tr><th>${esc(t('performance.head.when'))}</th><th>${esc(t('performance.head.asset'))}</th><th>${esc(t('performance.head.kind'))}</th><th>${esc(t('performance.head.code'))}</th><th>${esc(t('performance.head.warning'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : emptyState({
              compact: true,
              level: 3,
              title: t('performance.noEvents'),
              bodyHtml: tHtml('performance.noEventsBody', {
                link: `<a href="#/signals">${esc(t('performance.signalsLink'))}</a>`,
              }),
            })
      }
    </div>`;
}

// Time to cause (T10.04): per month, the median time from a stop to its warning resolved as a true alarm.
function causeCard(r: PerformanceReport): string {
  const rows = r.time_to_cause
    .map(
      (m) =>
        `<tr data-key="${esc(m.month)}"><td>${esc(month(`${m.month}-15T12:00:00Z`))}</td><td>${esc(number(m.stops))}</td><td>${esc(duration(m.median_seconds))}</td></tr>`,
    )
    .join('');
  return `<div class="card stack gap-2_5" data-cause>
      <h2>${esc(t('performance.cause.title'))}</h2>
      <p class="small soft">${esc(t('performance.cause.lead'))}</p>
      ${
        r.time_to_cause.length
          ? table({
              headers: [t('performance.cause.month'), t('performance.cause.stops'), t('performance.cause.median')],
              rowsHtml: rows,
            })
          : `<p class="small soft">${esc(t('performance.cause.none'))}</p>`
      }
    </div>`;
}

// A number for the report: a dash when there is none.
const num = (v: number | null, digits = 1): string => (v === null ? '–' : number(v, digits));

function roiResult(r: RoiReport): string {
  const b = r.periods.baseline;
  const p = r.periods.pilot;
  const perParts = b.parts !== null;
  const unit = t(perParts ? 'performance.roi.perParts' : 'performance.roi.perDay');
  const rateRow = (label: string, k: 'downtime' | 'scrap') => {
    const c = change(b.rates[k], p.rates[k]);
    return `<tr><th scope="row">${esc(label)}</th><td>${esc(num(b.rates[k], 2))}</td><td>${esc(num(p.rates[k], 2))}</td><td>${esc(c === null ? '–' : `${c > 0 ? '+' : ''}${percent(c)}`)}</td></tr>`;
  };
  const warnRow = (label: string, f: (w: RoiPeriod['warnings']) => string) =>
    `<tr><th scope="row">${esc(label)}</th><td>${esc(f(b.warnings))}</td><td>${esc(f(p.warnings))}</td><td></td></tr>`;
  const minutes = (s: number | null) => (s === null ? '–' : duration(s));
  const rows =
    rateRow(t('performance.roi.stops', { unit }), 'downtime') +
    rateRow(t('performance.roi.scrap', { unit }), 'scrap') +
    warnRow(t('performance.roi.recall'), (w) => share(w.recall)) +
    warnRow(t('performance.roi.precision'), (w) => share(w.precision)) +
    warnRow(t('performance.roi.falsePerDay'), (w) => num(w.false_per_day, 2)) +
    warnRow(t('performance.roi.warningTime'), (w) => minutes(w.median_warning_seconds));
  const a = r.avoided;
  const currency = typeof r.inputs.currency === 'string' ? r.inputs.currency : '';
  const cost = a.cost === null ? '–' : `${number(a.cost)}${currency ? ` ${currency}` : ''}`;
  return `<div class="stack gap-3" data-roi-result>
      ${table({ headers: [t('performance.roi.measure'), t('performance.roi.baseline'), t('performance.roi.pilot'), t('performance.roi.change')], rowsHtml: rows })}
      <h3>${esc(t('performance.roi.avoided'))}</h3>
      ${kv([
        [t('performance.roi.avoidedStops'), num(a.stops)],
        [t('performance.roi.avoidedHours'), num(a.downtime_hours)],
        [t('performance.roi.avoidedScrap'), num(a.scrap)],
        [t('performance.roi.avoidedCost'), cost],
      ])}
      <p class="small soft">${esc(t('performance.roi.digest'))} <code class="mono roi-digest" data-roi-digest>${esc(r.digest)}</code></p>
      <div class="row gap-2 wrap no-print">${button(t('performance.roi.download'), { icon: 'download', attrs: { 'data-roi-download': '' } })}</div>
    </div>`;
}

function plannedCard(ctx: Context): string {
  const canEdit = ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';
  const head = `<h2>${esc(t('performance.planned.title'))}</h2>
      <p class="small soft">${esc(t('performance.planned.lead'))}</p>`;
  if (planned === 'failed')
    return `<div class="card stack gap-3" data-planned>${head}${loadFailed(t('performance.planned.title'), 3)}</div>`;
  if (!planned)
    return `<div class="card stack gap-3" data-planned>${head}${skeleton.table(3, 4, t('performance.planned.loading'))}</div>`;
  const codes = planned.codes.join(', ');
  const codesPart = canEdit
    ? `<form id="planned-codes" class="row gap-2 wrap items-end no-print">
        ${field(t('performance.planned.codes'), input({ name: 'codes', value: codes, placeholder: 'PM, CHANGEOVER', class: 'grow' }), { class: 'grow', hint: t('performance.planned.codesHint') })}
        ${button(t('performance.planned.saveCodes'), { type: 'submit', size: 'sm' })}
      </form>`
    : `<p class="small">${esc(t('performance.planned.codesAre', { codes: codes || t('performance.planned.none') }))}</p>`;
  const rows = planned.stops
    .map(
      (s) => `<tr data-key="${esc(s.id)}">
          <td>${esc(s.asset ?? t('performance.planned.wholeSite'))}</td>
          <td>${esc(dateTime(s.starts_at))}</td>
          <td>${esc(dateTime(s.ends_at))}</td>
          <td>${esc(s.reason)}</td>
          ${canEdit ? `<td class="no-print">${button(t('performance.planned.remove'), { size: 'sm', variant: 'ghost', attrs: { 'data-planned-remove': s.id } })}</td>` : ''}
        </tr>`,
    )
    .join('');
  const headers = [
    t('performance.planned.asset'),
    t('performance.planned.from'),
    t('performance.planned.to'),
    t('performance.planned.reason'),
    ...(canEdit ? [{ label: t('performance.planned.actions'), srOnly: true }] : []),
  ];
  const more = planned.more ? `<p class="small soft">${esc(t('performance.planned.more'))}</p>` : '';
  const list = planned.stops.length
    ? table({ headers, rowsHtml: rows }) + more
    : `<p class="small soft">${esc(t('performance.planned.noStops'))}</p>`;
  const d = plannedDraft;
  const addForm = canEdit
    ? `<form id="planned-form" class="roi-form no-print">
        ${field(t('performance.planned.asset'), input({ name: 'asset', value: d?.asset ?? '', placeholder: t('performance.planned.wholeSite'), attrs: { maxlength: '100' } }), { hint: t('performance.planned.assetHint') })}
        ${field(t('performance.planned.from'), input({ name: 'from', type: 'datetime-local', value: d?.from ?? '', attrs: { required: true } }))}
        ${field(t('performance.planned.to'), input({ name: 'to', type: 'datetime-local', value: d?.to ?? '', attrs: { required: true } }))}
        ${field(t('performance.planned.reason'), input({ name: 'reason', value: d?.reason ?? '', attrs: { maxlength: '200' } }))}
        <div>${button(t('performance.planned.add'), { type: 'submit', variant: 'primary' })}</div>
      </form>`
    : '';
  return `<div class="card stack gap-3" data-planned>${head}${codesPart}${list}${addForm}</div>`;
}

function roiCard(): string {
  const f: RoiForm = roi?.form ?? defaultPeriods(Date.now());
  const date = (name: string, label: string) =>
    field(label, input({ name, type: 'date', value: f[name] ?? '', attrs: { required: true } }));
  const amount = (name: string, label: string, hint?: string) =>
    field(label, input({ name, type: 'number', value: f[name] ?? '', attrs: { min: '0', step: 'any' } }), { hint });
  return `<div class="card stack gap-3" id="roi">
      <h2>${esc(t('performance.roi.title'))}</h2>
      <p class="small soft">${esc(t('performance.roi.lead'))}</p>
      <form id="roi-form" class="stack gap-3 no-print">
        <div class="roi-form">
          ${date('baselineFrom', t('performance.roi.baselineFrom'))}
          ${date('baselineTo', t('performance.roi.baselineTo'))}
          ${date('pilotFrom', t('performance.roi.pilotFrom'))}
          ${date('pilotTo', t('performance.roi.pilotTo'))}
          ${amount('hoursPerStop', t('performance.roi.hoursPerStop'), t('performance.roi.hoursPerStopHint'))}
          ${field(t('performance.roi.hoursSource'), input({ name: 'hoursSource', value: f.hoursSource ?? '', attrs: { maxlength: '200' } }))}
          ${amount('costPerHour', t('performance.roi.costPerHour'))}
          ${amount('costPerScrap', t('performance.roi.costPerScrap'))}
          ${field(t('performance.roi.currency'), input({ name: 'currency', value: f.currency ?? '', placeholder: 'EUR', attrs: { maxlength: '3', pattern: '[A-Za-z]{3}', title: t('performance.roi.error.currency') } }))}
          ${amount('baselineParts', t('performance.roi.baselineParts'), t('performance.roi.partsHint'))}
          ${amount('pilotParts', t('performance.roi.pilotParts'))}
        </div>
        <div>${button(t('performance.roi.make'), { variant: 'primary', type: 'submit' })}</div>
      </form>
      ${roi?.report ? roiResult(roi.report) : ''}
    </div>`;
}

const view: View = {
  id: 'performance',
  get title() {
    return t('performance.title');
  },
  icon: 'target',
  render(ctx) {
    const head = pageHead({
      eyebrow: t('performance.eyebrow'),
      title: t('performance.title'),
      leadHtml: tHtml('performance.lead', { warnings: term('warning', 'warnings'), events: term('event', 'events') }),
    });
    if (!ctx.api) return `${head}<div class="card">${needsApi(t('performance.needsApi'))}</div>`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}<div class="card">${skeleton.card(t('performance.loading'))}</div>`;
    if (o.status !== 'ready')
      return `${head}${apiUnreachable(o.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })}`;
    const u = uiState(ctx);
    const key = keyFor(ctx);
    let body: string;
    if (fetched?.key === `${key}|failed`) body = card(loadFailed(t('performance.report'), 2));
    else if (fetched?.key !== key || !fetched.report)
      body = `<div class="card">${skeleton.table(4, 6, t('performance.loadingReport'))}</div>`;
    else {
      const r = fetched.report;
      const tiles = kpis(r.totals)
        .map(
          (k) =>
            `<div class="card kpi ${k.tone}"><div class="label">${kpiLabel(k)}</div><div class="value">${esc(k.value)}</div><div class="note">${esc(k.note)}</div></div>`,
        )
        .join('');
      body = `<div class="grid g4" data-kpis>${tiles}</div>${detectorsCard(ctx, r)}${eventsCard(r)}${causeCard(r)}${plannedCard(ctx)}${roiCard()}`;
    }
    return `${head}${controls(u)}<div class="stack gap-4 mt-4">${body}</div>`;
  },
  bind(root, ctx) {
    if (!ctx.api || ctx.ontology.status !== 'ready') return;
    const key = keyFor(ctx);
    if (fetched?.key !== key && fetched?.key !== `${key}|failed`) void load(ctx);
    onSubmit(root, '#performance-form', (form) => {
      const u = uiState(ctx);
      const data = new FormData(form);
      u.days = Number(data.get('days')) || 30;
      u.horizonHours = Number(data.get('horizon')) || 8;
      u.codes = String(data.get('codes') ?? '');
      pending = null;
      fetched = null; // Show: always fresh
      ctx.rerender();
    });
    const form = root.querySelector<HTMLFormElement>('#performance-form');
    form?.addEventListener(
      'input',
      () => {
        const data = new FormData(form);
        pending = {
          days: Number(data.get('days')) || 30,
          horizonHours: Number(data.get('horizon')) || 8,
          codes: String(data.get('codes') ?? ''),
        };
      },
      { signal: bound() },
    );
    onSubmit(root, '#roi-form', (form) => {
      const site = siteId(ctx);
      const api = ctx.api;
      if (!site || !api) return;
      const values: RoiForm = {};
      new FormData(form).forEach((v, k) => (values[k] = String(v)));
      const u = uiState(ctx);
      const body = roiRequest(values, u.horizonHours, parseCodes(u.codes));
      if (Array.isArray(body)) return showErrors(form, body);
      roi = { form: values, report: null }; // the last report was made from other values
      return api.roi(site, body).then(
        (report) => {
          roi = { form: values, report };
          ctx.rerender();
        },
        () => undefined, // the client showed why, on the form
      );
    });
    // Planned stops (T7.03): a change shows in the report at once.
    const changed = (): void => {
      fetched = null;
      if (roi) roi = { ...roi, report: null }; // made with the planned stops as they were
      ctx.rerender();
    };
    onSubmit(root, '#planned-codes', (form) => {
      const site = siteId(ctx);
      if (!site || !ctx.api) return;
      const codes = parseCodes(String(new FormData(form).get('codes') ?? ''));
      return ctx.api.setPlannedCodes(site, codes).then(
        () => {
          ctx.toast(t('performance.planned.codesSaved'));
          changed();
        },
        () => undefined, // the client showed why
      );
    });
    onSubmit(root, '#planned-form', (form) => {
      const site = siteId(ctx);
      if (!site || !ctx.api) return;
      const data = new FormData(form);
      const text = (name: string): string => String(data.get(name) ?? '');
      plannedDraft = { asset: text('asset'), from: text('from'), to: text('to'), reason: text('reason') };
      const from = fromInput(plannedDraft.from);
      const to = fromInput(plannedDraft.to);
      if (!(to > from)) return showErrors(form, [{ name: 'to', message: t('performance.planned.order') }]);
      const asset = plannedDraft.asset.trim();
      return ctx.api
        .addPlannedStop(site, {
          asset: asset || null,
          starts_at: new Date(from).toISOString(),
          ends_at: new Date(to).toISOString(),
          reason: plannedDraft.reason.trim(),
        })
        .then(
          () => {
            plannedDraft = null;
            form.reset();
            ctx.toast(t('performance.planned.added'));
            changed();
          },
          () => undefined, // the client showed why
        );
    });
    onAction(root, '[data-planned-remove]', (el) => {
      const site = siteId(ctx);
      const id = el.dataset.plannedRemove ?? '';
      if (!site || !ctx.api || !id) return;
      return ctx.api.removePlannedStop(site, id).then(
        () => {
          ctx.toast(t('performance.planned.removed'));
          changed();
        },
        () => undefined, // the client showed why
      );
    });
    onAction(root, '[data-roi-download]', () => {
      if (roi?.report) download(fileName(roi.report), roi.report.markdown, 'text/markdown');
    });
    onAll(root, '[data-asset-form] [name=asset]', 'input', (el) => {
      const id = el.closest<HTMLElement>('[data-asset-form]')?.dataset.assetForm;
      if (id) assetDrafts.set(id, (el as HTMLInputElement).value);
    });
    onAll(root, '[data-asset-form]', 'submit', (el, e) => {
      e.preventDefault();
      const site = siteId(ctx);
      const api = ctx.api;
      const id = el.dataset.assetForm ?? '';
      const input = el.querySelector<HTMLInputElement>('[name=asset]');
      if (!site || !api || !input) return;
      const asset = input.value.trim() || null;
      api.setDetectorAsset(site, id, asset).then(
        () => {
          assetDrafts.delete(id);
          ctx.toast(asset ? t('performance.matched', { asset }) : t('performance.cleared'));
          fetched = null;
          ctx.rerender();
        },
        () => undefined, // the client showed why
      );
    });
  },
};

export default view;
