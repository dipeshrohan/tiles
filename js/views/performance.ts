import { esc, onAll, onSubmit, onNavigate, routeOf } from '../lib/dom.ts';
import type { PerformanceReport } from '../lib/api.ts';
import { duration, HORIZONS, kpis, parseCodes, PERIODS, share, spread } from '../lib/performance.ts';
import { when } from '../lib/warnings.ts';
import type { Context, View } from './types.ts';
import { loadingState, needsApi } from '../lib/ui.ts';

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

function controls(shown: Ui): string {
  const u = pending ?? shown;
  const option = (v: number, label: string, current: number) =>
    `<option value="${v}" ${v === current ? 'selected' : ''}>${label}</option>`;
  return `<form class="card source-bar small" id="performance-form">
      <span class="row" style="gap:12px;flex-wrap:wrap;align-items:end">
        <label class="row" style="gap:6px">Last <select name="days">${PERIODS.map((d) => option(d, d === 1 ? 'day' : `${d} days`, u.days)).join('')}</select></label>
        <label class="row" style="gap:6px" title="A warning counts for an event when it started this long before it, at most">Warned within <select name="horizon">${HORIZONS.map((h) => option(h, `${h} h`, u.horizonHours)).join('')}</select></label>
        <label class="row" style="gap:6px;flex:1;min-width:220px">Only codes <input type="text" name="codes" value="${esc(u.codes)}" placeholder="all, or e.g. DT-SEIZURE, DT-LUBRICATION" style="flex:1"></label>
        <button class="btn sm primary" type="submit">Show</button>
      </span>
    </form>`;
}

function detectorsCard(ctx: Context, r: PerformanceReport): string {
  const canEdit = ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';
  const rows = r.detectors
    .map((d) => {
      const asset = canEdit
        ? `<form class="row" data-asset-form="${esc(d.id)}" style="gap:6px;flex-wrap:nowrap"><input type="text" name="asset" value="${esc(assetDrafts.get(d.id) ?? d.asset ?? '')}" maxlength="100" placeholder="e.g. DC-01" aria-label="Asset of ${esc(d.name)}" style="width:7em"><button class="btn sm" type="submit">Set</button></form>`
        : esc(d.asset ?? '–');
      const c = d.confirmed;
      const scored = d.matched
        ? `<td>${d.caught} / ${d.events} · ${share(d.recall)}</td><td>${share(d.precision)}${d.pending_warnings ? ` <span class="small soft">(${d.pending_warnings} pending)</span>` : ''}</td><td>${d.false_per_day === null ? '–' : d.false_per_day.toFixed(2)}</td><td>${spread(d.warning_seconds)}</td>`
        : '<td colspan="4" class="small soft">Set its asset to match its warnings to that asset’s events.</td>';
      return `<tr data-detector-row="${esc(d.id)}"><td><b>${esc(d.name)}</b><div class="small soft mono">${esc(d.signal_tag)}</div></td><td>${asset}</td><td>${d.warnings}</td>${scored}<td class="small">${c.true_alarm} true · ${c.false_alarm} false · ${c.unknown} unknown · ${c.unresolved} open</td></tr>`;
    })
    .join('');
  const unwatched = r.unwatched.length
    ? `<p class="small soft" data-unwatched>No detector watches ${r.unwatched.map((u) => `${esc(u.asset)} (${u.events} event(s))`).join(', ')}: set a detector’s asset to count them.</p>`
    : '';
  return `<div class="card stack" style="gap:10px">
      <h2>By detector</h2>
      ${
        r.detectors.length
          ? `<div class="table-wrap"><table><thead><tr><th>Detector</th><th>Asset</th><th>Warnings</th><th>Events warned of</th><th>Followed by an event</th><th>False per day</th><th>Warning time (median, p10 to p90)</th><th>Resolved as</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<p class="small soft">No detectors yet. Detectors are set up through the Tiles API.</p>'
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
            ? `<span class="badge good">warned</span> ${esc(duration(e.warning_seconds))} ahead, by ${esc(e.detector ?? 'a detector')}`
            : '<span class="badge bad">missed</span>'
        }</td></tr>`,
    )
    .join('');
  return `<div class="card stack" style="gap:10px">
      <h2>Events</h2>
      ${
        r.events.length
          ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Asset</th><th>Kind</th><th>Code</th><th>Warning</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<p class="small soft">No events of watched assets in this period. Events are readings on signals marked as downtime or scrap on the Signals page, with their asset.</p>'
      }
    </div>`;
}

const view: View = {
  id: 'performance',
  title: 'Warning performance',
  icon: 'target',
  render(ctx) {
    const head = `<div class="page-head"><div><div class="eyebrow">Operations · Detection</div><h1>Warning performance</h1>
        <p class="soft">How the warnings did against the downtime and scrap the MES reported: the events they warned of, the warnings an event followed, and how far ahead.</p></div></div>`;
    if (!ctx.api)
      return `${head}<div class="card">${needsApi(`This compares the detectors’ warnings with the plant’s events, which the Tiles API keeps.`)}</div>`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}<div class="card">Loading from the Tiles API…</div>`;
    if (o.status !== 'ready')
      return `${head}<div class="card" role="alert">Can't reach the Tiles API: ${esc(o.error)}</div>`;
    const u = uiState(ctx);
    const key = keyFor(ctx);
    let body: string;
    if (fetched?.key === `${key}|failed`) body = '<div class="card"><p>This could not be loaded.</p></div>';
    else if (fetched?.key !== key || !fetched.report) body = `<div class="card">${loadingState()}</div>`;
    else {
      const r = fetched.report;
      const tiles = kpis(r.totals)
        .map(
          (k) =>
            `<div class="card kpi ${k.tone}"><div class="label">${esc(k.label)}</div><div class="value">${esc(k.value)}</div><div class="note">${esc(k.note)}</div></div>`,
        )
        .join('');
      body = `<div class="grid g4" data-kpis>${tiles}</div>${detectorsCard(ctx, r)}${eventsCard(r)}`;
    }
    return `${head}${controls(u)}<div class="stack" style="gap:16px;margin-top:16px">${body}</div>`;
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
    form?.addEventListener('input', () => {
      const data = new FormData(form);
      pending = {
        days: Number(data.get('days')) || 30,
        horizonHours: Number(data.get('horizon')) || 8,
        codes: String(data.get('codes') ?? ''),
      };
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
          ctx.toast(asset ? `Matched to ${asset}’s events` : 'Asset cleared');
          fetched = null;
          ctx.rerender();
        },
        () => undefined, // the client showed why
      );
    });
  },
};

export default view;
