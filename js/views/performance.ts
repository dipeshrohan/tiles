import { esc, onAll, onSubmit, onNavigate, routeOf, bound } from '../lib/dom.ts';
import type { PerformanceReport } from '../lib/api.ts';
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
} from '../lib/ui.ts';
import { GLOSSARY } from '../lib/glossary-data.ts';
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
  }
});

async function load(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const key = keyFor(ctx);
  const mine = ++seq;
  fetched = { key, report: null };
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
        <label class="row gap-1_5">${t('performance.form.last')} <select name="days">${PERIODS.map((d) => option(d, esc(t('performance.form.days', { count: d })), u.days)).join('')}</select></label>
        <label class="row gap-1_5" title="${esc(t('performance.form.horizonHint'))}">${t('performance.form.horizon')} <select name="horizon">${HORIZONS.map((h) => option(h, `${h} h`, u.horizonHours)).join('')}</select></label>
        <label class="row gap-1_5 grow min-w-field">${t('performance.form.codes')} <input type="text" name="codes" value="${esc(u.codes)}" placeholder="${esc(t('performance.form.codesPlaceholder'))}" class="grow"></label>
        <button class="btn sm primary" type="submit">${t('performance.form.show')}</button>
      </span>
    </form>`;
}

function detectorsCard(ctx: Context, r: PerformanceReport): string {
  const canEdit = ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';
  const rows = r.detectors
    .map((d) => {
      const asset = canEdit
        ? `<form class="row gap-1_5 nowrap" data-asset-form="${esc(d.id)}"><input type="text" name="asset" value="${esc(assetDrafts.get(d.id) ?? d.asset ?? '')}" maxlength="100" placeholder="${esc(t('performance.assetPlaceholder'))}" aria-label="${esc(t('performance.assetLabel', { name: d.name }))}" class="w-7em"><button class="btn sm" type="submit">${t('performance.set')}</button></form>`
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
      <h2>${t('performance.byDetector')}</h2>
      ${
        r.detectors.length
          ? `<div class="table-wrap"><table><thead><tr><th>${term('detector', 'Detector')}</th><th>${term('asset', 'Asset')}</th><th>${t('performance.head.warnings')}</th><th>${tHtml('performance.head.recall', { term: term('recall', 'recall') })}</th><th>${tHtml('performance.head.precision', { term: term('precision', 'precision') })}</th><th>${term('false-per-day', t('performance.head.falsePerDay'))}</th><th>${tHtml('performance.head.warningTime', { term: term('warning-time', t('performance.head.warningTimeTerm')), spread: term('percentile', 'p10 to p90') })}</th><th>${tHtml('performance.head.outcome', { term: term('outcome', 'outcome') })}</th></tr></thead><tbody>${rows}</tbody></table></div>`
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
            ? `<span class="badge good">${t('performance.warned')}</span> ${esc(t('performance.ahead', { duration: duration(e.warning_seconds), detector: e.detector ?? t('performance.aDetector') }))}`
            : `<span class="badge bad">${t('performance.missed')}</span>`
        }</td></tr>`,
    )
    .join('');
  return `<div class="card stack gap-2_5">
      <h2>${t('performance.events')}</h2>
      ${
        r.events.length
          ? `<div class="table-wrap"><table><thead><tr><th>${t('performance.head.when')}</th><th>${t('performance.head.asset')}</th><th>${t('performance.head.kind')}</th><th>${t('performance.head.code')}</th><th>${t('performance.head.warning')}</th></tr></thead><tbody>${rows}</tbody></table></div>`
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
      body = `<div class="grid g4" data-kpis>${tiles}</div>${detectorsCard(ctx, r)}${eventsCard(r)}`;
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
