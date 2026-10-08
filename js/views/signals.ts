import { esc, field, fmt, onAll } from '../lib/dom.ts';
import type { QualityReport, SignalChange, SignalInfo, SignalQuery } from '../lib/api.ts';
import type { Context, View } from './types.ts';

// Signal catalogue (T2.08): every tag the site has readings for, searchable, with what is known
// about it. Engineers add the unit, sample rate and a description, and link each tag to its
// Signal node in the ontology. Each signal shows the badge of its latest data-quality check
// (T2.09): gaps, stuck values, out-of-range values, unit mismatches.

const PAGE = 100;

interface Ui {
  query: Required<Pick<SignalQuery, 'q' | 'source' | 'linked' | 'quality'>>;
  editing: string | null; // the signal being edited
  open: string | null; // the signal whose quality report is shown
}

let results: { total: number; signals: SignalInfo[] } | null = null;
let failed = false;
let checking = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const ui = (ctx: Context): Ui =>
  ctx.ui<Ui>('signals', { query: { q: '', source: '', linked: '', quality: '' }, editing: null, open: null });

export function sourceLabel(source: string): string {
  const [kind, ...rest] = source.split(':');
  const name = rest.join(':');
  if (kind === 'edge') return `Edge agent ${name}`;
  if (kind === 'import') return `Import ${name}`;
  return source === 'manual' ? 'Entered by hand' : source;
}

export function latest(s: Pick<SignalInfo, 'last_value' | 'last_at' | 'unit'>): string {
  if (s.last_at === null || s.last_value === null) return '—';
  const v = s.last_value;
  const value = typeof v === 'number' ? String(+v.toPrecision(6)) : String(v);
  const unit = typeof v === 'number' && s.unit ? ` ${s.unit}` : '';
  return `${value}${unit} · ${new Date(s.last_at).toLocaleString('en-GB')}`;
}

const QUALITY: Record<QualityReport['badge'] | 'unchecked', [string, string]> = {
  good: ['Good', 'good'],
  warn: ['Warnings', 'warn'],
  bad: ['Problems', 'bad'],
  unknown: ['No data', ''],
  unchecked: ['Not checked', ''],
};

export function qualityBadge(report: QualityReport | null): string {
  const [label, tone] = QUALITY[report ? report.badge : 'unchecked'];
  const title = report?.issues.length ? report.issues.map((i) => i.message).join('\n') : label;
  return `<span class="badge ${tone}" title="${esc(title)}">${esc(label)}</span>`;
}

// Rounded down, as the API does, so a share just below a limit doesn't read as on it.
const percent = (x: number) => `${(Math.floor(x * 1000) / 10).toFixed(1)}%`;

// The report behind a badge: what was checked and what was found.
export function qualityDetail(report: QualityReport): string {
  const when = new Date(report.checked_at).toLocaleString('en-GB');
  const facts = [
    `${fmt(report.readings, 0)} reading(s) in the ${+report.window_hours.toPrecision(3)} h up to the latest`,
    report.period_s === null ? '' : `expected every ${+report.period_s.toPrecision(3)} s`,
    report.coverage === null ? '' : `${percent(report.coverage)} of the time covered`,
  ].filter(Boolean);
  const issues = report.issues.length
    ? `<ul class="small">${report.issues.map((i) => `<li><span class="badge ${i.severity}">${i.severity === 'bad' ? 'problem' : 'warning'}</span> ${esc(i.message)}</li>`).join('')}</ul>`
    : `<p class="small">${report.readings ? 'No gaps, stuck values, out-of-range values or unit mismatches found.' : 'No readings to check.'}</p>`;
  return `<div class="stack" style="gap:6px"><p class="small soft">Checked ${esc(when)}: ${esc(facts.join(', '))}.</p>${issues}</div>`;
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
  },
  s: SignalInfo,
): SignalChange | string {
  const change: SignalChange = {};
  const unit = form.unit.trim() || null;
  if (unit !== s.unit) change.unit = unit;
  const rate = number(form.rate);
  if (rate === undefined || (rate !== null && rate <= 0))
    return 'The sample rate is a number of readings per second, above 0.';
  if (rate !== s.sample_rate_hz) change.sample_rate_hz = rate;
  const description = form.description.trim();
  if (description !== s.description) change.description = description;
  const node = form.node || null;
  if (node !== s.node_id) change.node_id = node;
  const min = number(form.min ?? '');
  const max = number(form.max ?? '');
  if (min === undefined || max === undefined) return 'The expected range is two numbers (either may be blank).';
  if (min !== null && max !== null && min >= max) return "The expected range's minimum must be below its maximum.";
  if (min !== s.range_min) change.range_min = min;
  if (max !== s.range_max) change.range_max = max;
  const stuck = number(form.stuck ?? '');
  if (stuck === undefined || (stuck !== null && (stuck <= 0 || stuck > 30 * 24 * 60)))
    return 'Stuck after is a number of minutes, above 0 and at most 30 days.';
  const stuckS = stuck === null ? null : stuck * 60;
  if (stuckS !== s.stuck_after_s) change.stuck_after_s = stuckS;
  return change;
}

function linkCell(s: SignalInfo): string {
  if (!s.node_id) return '<span class="soft">—</span>';
  return s.node_label
    ? `<a href="#/ontology">${esc(s.node_label)}</a>`
    : `<span class="badge warn" title="${esc(s.node_id)} is no longer in the committed ontology">missing node</span>`;
}

function editRow(ctx: Context, s: SignalInfo): string {
  const nodes = Object.values(ctx.state.repo.head.nodes)
    .filter((n) => n.type === 'Signal')
    .sort((a, b) => a.label.localeCompare(b.label));
  const options = [
    `<option value="">— not linked —</option>`,
    ...(s.node_id && !nodes.some((n) => n.id === s.node_id)
      ? [`<option value="${esc(s.node_id)}" selected>${esc(s.node_id)} (missing)</option>`]
      : []),
    ...nodes.map(
      (n) =>
        `<option value="${esc(n.id)}" ${n.id === s.node_id ? 'selected' : ''}>${esc(n.label)} (${esc(n.id)})</option>`,
    ),
  ].join('');
  const stuck = s.stuck_after_s === null ? '' : String(s.stuck_after_s / 60);
  return `<tr class="edit-row"><td colspan="9">
      <form id="signal-form" data-signal="${esc(s.id)}" class="row" style="gap:12px;flex-wrap:wrap;align-items:end">
        <label class="field">Unit<input type="text" name="unit" value="${esc(s.unit ?? '')}" placeholder="e.g. °C" maxlength="40" style="width:7em"></label>
        <label class="field">Sample rate (Hz)<input type="text" name="rate" value="${s.sample_rate_hz ?? ''}" inputmode="decimal" style="width:7em"></label>
        <label class="field" style="flex:1;min-width:200px">Description<input type="text" name="description" value="${esc(s.description)}" maxlength="1000"></label>
        <label class="field">Ontology node<select name="node">${options}</select></label>
        <label class="field">Expected min<input type="text" name="min" value="${s.range_min ?? ''}" inputmode="decimal" style="width:7em"></label>
        <label class="field">Expected max<input type="text" name="max" value="${s.range_max ?? ''}" inputmode="decimal" style="width:7em"></label>
        <label class="field">Stuck after (min)<input type="text" name="stuck" value="${esc(stuck)}" placeholder="60" inputmode="decimal" style="width:6em"></label>
        <button class="btn primary" type="submit">Save</button>
        <button class="btn" type="button" data-cancel-edit>Cancel</button>
      </form>
      ${nodes.length ? '' : '<p class="small soft">The committed ontology has no Signal nodes yet: add them on the Ontology page, then link them here.</p>'}
    </td></tr>`;
}

export function resultsTable(ctx: Context, page: { total: number; signals: SignalInfo[] }, canEdit: boolean): string {
  if (!page.signals.length)
    return '<p class="small soft">No signals match. Signals appear here once an edge agent or an import sends their readings.</p>';
  const { editing, open } = ui(ctx);
  const more =
    page.total > page.signals.length
      ? ` Showing the first ${page.signals.length}; narrow the search to see others.`
      : '';
  return `<p class="small soft" data-signal-count>${esc(fmt(page.total, 0))} signal(s).${esc(more)}</p>
    <div class="table-wrap"><table><thead><tr><th>Tag</th><th>Description</th><th>Unit</th><th>Rate</th><th>Source</th><th>Ontology node</th><th>Latest reading</th><th>Quality</th><th></th></tr></thead><tbody>${page.signals
      .map(
        (s) =>
          `<tr data-row="${esc(s.id)}"><td><code>${esc(s.tag)}</code></td><td>${esc(s.description) || '<span class="soft">—</span>'}</td>
            <td>${esc(s.unit ?? '—')}</td><td>${s.sample_rate_hz === null ? '—' : `${esc(String(s.sample_rate_hz))} Hz`}</td>
            <td>${esc(sourceLabel(s.source))}</td><td>${linkCell(s)}</td><td>${esc(latest(s))}</td>
            <td>${s.quality ? `<button class="btn-link" type="button" data-quality="${esc(s.id)}" aria-expanded="${open === s.id}">${qualityBadge(s.quality)}</button>` : qualityBadge(null)}</td>
            <td>${canEdit && editing !== s.id ? `<button class="btn sm" type="button" data-edit="${esc(s.id)}">Edit</button>` : ''}</td></tr>
          ${open === s.id && s.quality ? `<tr class="quality-row"><td colspan="9">${qualityDetail(s.quality)}</td></tr>` : ''}
          ${canEdit && editing === s.id ? editRow(ctx, s) : ''}`,
      )
      .join('')}</tbody></table></div>`;
}

async function search(root: HTMLElement, ctx: Context): Promise<void> {
  const site = ctx.ontology.site;
  if (!ctx.api || !site) return;
  try {
    results = await ctx.api.signals.list(site.id, { ...ui(ctx).query, limit: PAGE });
    failed = false;
  } catch {
    failed = true;
  }
  fill(root, ctx);
}

function fill(root: HTMLElement, ctx: Context): void {
  const box = root.querySelector('[data-signal-results]');
  if (!box) return;
  const canEdit = ctx.ontology.role !== 'viewer';
  box.innerHTML = failed
    ? '<p class="small soft">The signals could not be loaded.</p>'
    : results
      ? resultsTable(ctx, results, canEdit)
      : '<p class="small soft">Loading…</p>';
  bindResults(root, ctx);
}

function bindResults(root: HTMLElement, ctx: Context): void {
  onAll(root, '[data-quality]', 'click', (el) => {
    const u = ui(ctx);
    u.open = u.open === el.dataset.quality ? null : (el.dataset.quality ?? null);
    fill(root, ctx);
  });
  onAll(root, '[data-edit]', 'click', (el) => {
    ui(ctx).editing = el.dataset.edit ?? null;
    fill(root, ctx);
  });
  onAll(root, '[data-cancel-edit]', 'click', () => {
    ui(ctx).editing = null;
    fill(root, ctx);
  });
  const form = root.querySelector<HTMLFormElement>('#signal-form');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const site = ctx.ontology.site;
    const sig = results?.signals.find((s) => s.id === form.dataset.signal);
    if (!site || !ctx.api || !sig) return;
    const change = changeFrom(
      {
        unit: field(form, 'unit'),
        rate: field(form, 'rate'),
        description: field(form, 'description'),
        node: field(form, 'node'),
        min: field(form, 'min'),
        max: field(form, 'max'),
        stuck: field(form, 'stuck'),
      },
      sig,
    );
    if (typeof change === 'string') {
      ctx.toast(change);
      return;
    }
    if (!Object.keys(change).length) {
      ui(ctx).editing = null;
      fill(root, ctx);
      return;
    }
    ctx.api.signals.update(site.id, sig.id, change).then(
      (updated) => {
        if (results) results.signals = results.signals.map((s) => (s.id === updated.id ? updated : s));
        ui(ctx).editing = null;
        ctx.toast(`Saved ${updated.tag}`);
        fill(root, ctx);
      },
      () => undefined, // the client showed why
    );
  });
}

const view: View = {
  id: 'signals',
  title: 'Signals',
  icon: '≋',
  render(ctx) {
    const head = `<div class="page-head"><div><div class="eyebrow">Data</div><h1>Signals</h1>
        <p class="soft">Every tag with readings on this site: its unit, sample rate, where it comes from and the ontology node it maps to.</p></div></div>`;
    if (!ctx.api || !ctx.ontology.site)
      return `${head}<div class="card"><p class="small soft">The signal catalogue is kept in the Tiles API. Connect to it in <a href="#/settings">Settings</a> (data source: Tiles API).</p></div>`;
    const { query } = ui(ctx);
    const opt = (value: string, label: string, current: string) =>
      `<option value="${value}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;
    return `${head}<div class="card stack" style="gap:12px">
        <form id="signal-search" class="row" style="gap:12px;flex-wrap:wrap" role="search">
          <label class="field" style="flex:1;min-width:200px">Search<input type="search" name="q" value="${esc(query.q)}" placeholder="Tag, description or node"></label>
          <label class="field">Source<select name="source">${opt('', 'Any', query.source)}${opt('edge', 'Edge agents', query.source)}${opt('import', 'Imports', query.source)}${opt('manual', 'Entered by hand', query.source)}</select></label>
          <label class="field">Ontology link<select name="linked">${opt('', 'Any', query.linked)}${opt('yes', 'Linked', query.linked)}${opt('no', 'Not linked', query.linked)}</select></label>
          <label class="field">Quality<select name="quality">${opt('', 'Any', query.quality)}${opt('bad', 'Problems', query.quality)}${opt('warn', 'Warnings', query.quality)}${opt('good', 'Good', query.quality)}${opt('unknown', 'No data', query.quality)}${opt('unchecked', 'Not checked', query.quality)}</select></label>
          ${ctx.ontology.role !== 'viewer' ? '<button class="btn" type="button" data-check-quality title="Look for gaps, stuck values, out-of-range values and unit mismatches in the last 24 hours of each signal listed">Check quality</button>' : ''}
        </form>
        <div data-signal-results aria-live="polite"><p class="small soft">Loading…</p></div>
      </div>`;
  },
  bind(root, ctx) {
    const form = root.querySelector<HTMLFormElement>('#signal-search');
    if (!form) return;
    if (results) fill(root, ctx); // show the last answer at once, then refresh it
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
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void search(root, ctx), 250);
    };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      update();
    });
    const checkButton = root.querySelector<HTMLButtonElement>('[data-check-quality]');
    checkButton?.addEventListener('click', () => {
      const site = ctx.ontology.site;
      const ids = results?.signals.map((s) => s.id) ?? [];
      if (!ctx.api || !site || checking || !ids.length) return;
      checking = true;
      checkButton.disabled = true;
      checkButton.textContent = 'Checking…';
      ctx.api.signals
        .checkQuality(site.id, ids)
        .then(
          (out) => {
            const { good, warn, bad, unknown } = out.badges;
            ctx.toast(
              `Checked ${out.checked} signal(s): ${good} good, ${warn} with warnings, ${bad} with problems${unknown ? `, ${unknown} without data` : ''}`,
            );
            void search(root, ctx);
          },
          () => undefined, // the client showed why
        )
        .finally(() => {
          checking = false;
          checkButton.disabled = false;
          checkButton.textContent = 'Check quality';
        });
    });
  },
};

export default view;
