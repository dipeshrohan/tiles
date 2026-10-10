import { esc, field, fmt, onAll } from '../lib/dom.ts';
import type { MappingSuggestion, QualityReport, SignalChange, SignalInfo, SignalQuery } from '../lib/api.ts';
import type { Context, View } from './types.ts';

// Signal catalogue (T2.08): every tag the site has readings for, searchable, with what is known
// about it. Engineers add the unit, sample rate and a description, and link each tag to its
// Signal node in the ontology. Each signal shows the badge of its latest data-quality check
// (T2.09): gaps, stuck values, out-of-range values, unit mismatches.

const PAGE = 100;

interface Ui {
  query: Required<Pick<SignalQuery, 'q' | 'source' | 'linked' | 'quality'>>;
  editing: string | null; // the signal being edited
  skipped: string[]; // mapping suggestions skipped (signal ids)
  open: string | null; // the signal whose quality report is shown
}

let results: { total: number; signals: SignalInfo[] } | null = null;
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
    events?: string; // '' (a measurement), downtime, scrap or other
    asset?: string;
  },
  s: SignalInfo,
): SignalChange | string {
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
  if (rate === undefined || (rate !== null && rate <= 0))
    return 'The sample rate is a number of readings per second, above 0.';
  if (rate !== s.sample_rate_hz) change.sample_rate_hz = rate;
  if (form.description !== s.description) {
    const description = form.description.trim();
    if (description !== s.description) change.description = description;
  }
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
  const text = [s.event_kind ? `${s.event_kind} events` : '', s.asset ?? ''].filter(Boolean).join(' · ');
  return ` <span class="badge" data-event-badge>${esc(text)}</span>`;
}

function linkCell(s: SignalInfo): string {
  if (!s.node_id) return '<span class="soft">—</span>';
  return s.node_label !== null // a label may be empty: the node is still there
    ? `<a href="#/ontology">${esc(s.node_label || s.node_id)}</a>`
    : `<span class="badge warn" title="${esc(s.node_id)} is no longer a Signal node of the committed ontology">missing node</span>`;
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
  const stuck = s.stuck_after_s === null ? '' : String(+(s.stuck_after_s / 60).toPrecision(12));
  return `<tr class="edit-row"><td colspan="9">
      <form id="signal-form" data-signal="${esc(s.id)}" class="row" style="gap:12px;flex-wrap:wrap;align-items:end">
        <fieldset style="display:contents" ${saving === s.id ? 'disabled' : ''}>
        <label class="field">Unit<input type="text" name="unit" value="${esc(s.unit ?? '')}" placeholder="e.g. °C" maxlength="40" style="width:7em"></label>
        <label class="field">Sample rate (Hz)<input type="text" name="rate" value="${esc(String(s.sample_rate_hz ?? ''))}" inputmode="decimal" style="width:7em"></label>
        <label class="field" style="flex:1;min-width:200px">Description<input type="text" name="description" value="${esc(s.description)}" maxlength="1000"></label>
        <label class="field">Ontology node<select name="node">${options}</select></label>
        <label class="field">Expected min<input type="text" name="min" value="${esc(String(s.range_min ?? ''))}" inputmode="decimal" style="width:7em"></label>
        <label class="field">Expected max<input type="text" name="max" value="${esc(String(s.range_max ?? ''))}" inputmode="decimal" style="width:7em"></label>
        <label class="field">Stuck after (min)<input type="text" name="stuck" value="${esc(stuck)}" placeholder="60" inputmode="decimal" style="width:6em"></label>
        <label class="field" title="Each reading of an event stream is an event: its value is the code">Events<select name="events">${(
          [
            ['', 'none: readings'],
            ['downtime', 'downtime'],
            ['scrap', 'scrap'],
            ['other', 'other events'],
          ] as const
        )
          .map(([v, label]) => `<option value="${v}" ${v === (s.event_kind ?? '') ? 'selected' : ''}>${label}</option>`)
          .join('')}</select></label>
        <label class="field" title="The machine, as the MES names it: its events are matched to its detectors' warnings">Asset<input type="text" name="asset" value="${esc(s.asset ?? '')}" maxlength="100" placeholder="e.g. DC-01" style="width:8em"></label>
        <button class="btn primary" type="submit">${saving === s.id ? 'Saving…' : 'Save'}</button>
        <button class="btn" type="button" data-cancel-edit>Cancel</button>
        </fieldset>
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
    <div class="table-wrap"><table><thead><tr><th>Tag</th><th>Description</th><th>Unit</th><th>Rate</th><th>Source</th><th>Ontology node</th><th>Latest reading</th><th>Quality</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${page.signals
      .map(
        (s) =>
          `<tr data-row="${esc(s.id)}"><td><a href="#/explorer?signal=${esc(encodeURIComponent(s.id))}" title="Plot it in the Data explorer"><code>${esc(s.tag)}</code></a>${eventBadge(s)}</td><td>${esc(s.description) || '<span class="soft">—</span>'}</td>
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

function fill(root: HTMLElement, ctx: Context): void {
  const box = root.querySelector('[data-signal-results]');
  if (!box) return;
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
  box.innerHTML = failed
    ? '<p class="small soft">The signals could not be loaded.</p>'
    : results
      ? resultsTable(ctx, results, canEdit)
      : '<p class="small soft">Loading…</p>';
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
    if (saving) {
      const other = results?.signals.find((s) => s.id === saving);
      ctx.toast(`Wait for ${other ? other.tag : 'the other change'} to be saved, then save this one`);
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
    if (typeof change === 'string') {
      ctx.toast(change);
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
    ctx.api.signals.update(site.id, sig.id, change).then(
      (updated) => {
        saving = null;
        if (results) results.signals = results.signals.map((s) => (s.id === updated.id ? updated : s));
        if (ui(ctx).editing === sig.id) ui(ctx).editing = null; // not another signal opened meanwhile
        ctx.toast(`Saved ${updated.tag}`);
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
      ? `<span class="badge good">Link to</span> ${esc(s.node_label)}`
      : `<span class="badge accent">New node</span> ${esc(s.node_label)}`;
  return `<div class="suggestion" data-suggestion="${esc(s.signal_id)}">
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
        <code>${esc(s.tag)}</code><span class="soft">→</span>${what}
        <span class="small soft" title="How sure Tiles is">${Math.round(s.score * 100)}%</span>
        <span style="flex:1"></span>
        ${canEdit ? `<button class="btn sm primary" type="button" data-accept="${esc(s.signal_id)}" ${busy ? 'disabled' : ''}>${s.kind === 'link' ? 'Link' : 'Stage node'}</button><button class="btn sm" type="button" data-skip="${esc(s.signal_id)}" ${busy ? 'disabled' : ''}>Skip</button>` : ''}
      </div>
      <ul class="small soft" style="margin:4px 0 0 18px">${s.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>`;
}

function mappingHtml(ctx: Context): string {
  if (!mapping || mapping.for !== catalogue(ctx)) return '';
  const skipped = new Set(ui(ctx).skipped);
  const items = mapping.items.filter((s) => !skipped.has(s.signal_id));
  const staged = mapping.staged.length
    ? `<p class="small">Your staged change adds a node for ${mapping.staged.map((t) => `<code>${esc(t)}</code>`).join(', ')}: commit it on the <a href="#/ontology">Ontology</a> page, then suggest again to link it.</p>`
    : '';
  if (!mapping.unmapped) return '<p class="small soft">Every tag is linked to an ontology node.</p>';
  if (!items.length)
    return `${staged}<p class="small soft">${skipped.size ? 'No suggestions left here. Suggest again to see the skipped ones.' : 'No suggestions left here.'}</p>`;
  const canEdit = ctx.ontology.role !== 'viewer';
  const links = items.filter((s) => s.kind === 'link').length;
  const shown = mapping.items.length + mapping.staged.length;
  const more = mapping.unmapped > shown ? ` for ${mapping.items.length} of ${mapping.unmapped} unlinked tags` : '';
  return `${staged}<p class="small soft">${items.length} suggestion(s)${esc(more)}. New nodes are staged: commit them on the <a href="#/ontology">Ontology</a> page, then link them here in one step.</p>
    ${canEdit && links > 1 ? `<div><button class="btn sm" type="button" data-accept-links ${linkingAll ? 'disabled' : ''}>Link all ${links}</button></div>` : ''}
    <div class="stack" style="gap:10px">${items.map((s) => suggestionRow(s, canEdit, linkingAll)).join('')}</div>`;
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
        ctx.toast(s.kind === 'link' ? `Linked ${s.tag}` : `Staged ${s.node_label}: commit it on the Ontology page`);
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
      ctx.toast(`Linked ${done} of ${links.length} tag(s)`);
      fillMapping(root, ctx);
      void search(root, ctx);
    })();
  });
}

const view: View = {
  id: 'signals',
  title: 'Signals',
  icon: 'activity',
  render(ctx) {
    const head = `<div class="page-head"><div><div class="eyebrow">Data</div><h1>Signals</h1>
        <p class="soft">Every tag with readings on this site: its unit, sample rate, where it comes from and the ontology node it maps to.</p></div></div>`;
    if (!ctx.api)
      return `${head}<div class="card"><p class="small soft">The signal catalogue is kept in the Tiles API. Connect to it in <a href="#/settings">Settings</a> (data source: Tiles API).</p></div>`;
    if (!ctx.ontology.site)
      return `${head}<div class="card"><p class="small soft">${
        ctx.ontology.status === 'error'
          ? `The site could not be loaded from the Tiles API: ${esc(ctx.ontology.error ?? 'unknown error')}`
          : 'Loading the site from the Tiles API…'
      }</p></div>`;
    const { query } = ui(ctx);
    const opt = (value: string, label: string, current: string) =>
      `<option value="${value}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;
    return `${head}<div class="card stack" style="gap:12px">
        <form id="signal-search" class="row" style="gap:12px;flex-wrap:wrap" role="search">
          <label class="field" style="flex:1;min-width:200px">Search<input type="search" name="q" value="${esc(query.q)}" placeholder="Tag, description or node"></label>
          <label class="field">Source<select name="source">${opt('', 'Any', query.source)}${opt('edge', 'Edge agents', query.source)}${opt('import', 'Imports', query.source)}${opt('manual', 'Entered by hand', query.source)}</select></label>
          <label class="field">Ontology link<select name="linked">${opt('', 'Any', query.linked)}${opt('yes', 'Linked', query.linked)}${opt('no', 'Not linked', query.linked)}</select></label>
          <label class="field">Quality<select name="quality">${opt('', 'Any', query.quality)}${opt('bad', 'Problems', query.quality)}${opt('warn', 'Warnings', query.quality)}${opt('good', 'Good', query.quality)}${opt('unknown', 'No data', query.quality)}${opt('unchecked', 'Not checked', query.quality)}</select></label>
          ${ctx.ontology.role !== 'viewer' ? `<button class="btn" type="button" data-check-quality ${checking ? 'disabled' : ''} title="Look for gaps, stuck values, out-of-range values and unit mismatches in the last 24 hours of each signal listed">${checking ? 'Checking…' : 'Check quality'}</button>` : ''}
        </form>
        <div data-signal-results aria-live="polite"><p class="small soft">Loading…</p></div>
      </div>
      <div class="card stack" style="gap:10px;margin-top:12px" data-mapping>
        <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div><h2>Map tags to the ontology</h2><p class="small soft">Tiles suggests a Signal node for each tag that has none: one to link, or one to create under the PLC the tag comes from. Every suggestion says why.</p></div>
          <button class="btn" type="button" data-suggest>Suggest mappings</button>
        </div>
        <div data-mapping-results aria-live="polite">${mappingHtml(ctx)}</div>
      </div>`;
  },
  bind(root, ctx) {
    const form = root.querySelector<HTMLFormElement>('#signal-search');
    if (!form) return;
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
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void search(root, ctx), 250);
    };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      update();
    });
    root.querySelector('[data-suggest]')?.addEventListener('click', () => void suggest(root, ctx));
    bindMapping(root, ctx);
    const checkButton = root.querySelector<HTMLButtonElement>('[data-check-quality]');
    // The button as it is now: the page may have been left and shown again while a check ran.
    const setButton = (busy: boolean) => {
      const button = root.querySelector<HTMLButtonElement>('[data-check-quality]');
      if (!button) return;
      button.disabled = busy;
      button.textContent = busy ? 'Checking…' : 'Check quality';
    };
    checkButton?.addEventListener('click', () => {
      const site = ctx.ontology.site;
      if (!ctx.api || !site || checking) return;
      // Only the signals listed for this site and search, not an answer to an earlier one.
      const current = results && resultsFor === catalogue(ctx) && resultsQuery === JSON.stringify(ui(ctx).query);
      const ids = current ? (results?.signals.map((s) => s.id) ?? []) : [];
      if (!ids.length) {
        ctx.toast(current ? 'No signals listed to check' : 'Wait for the list to load, then check it');
        return;
      }
      checking = true;
      setButton(true);
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
          setButton(false);
        });
    });
  },
};

export default view;
