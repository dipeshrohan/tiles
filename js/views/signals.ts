import { esc, field, fmt, onAll } from '../lib/dom.ts';
import type { SignalChange, SignalInfo, SignalQuery } from '../lib/api.ts';
import type { Context, View } from './types.ts';

// Signal catalogue (T2.08): every tag the site has readings for, searchable, with what is known
// about it. Engineers add the unit, sample rate and a description, and link each tag to its
// Signal node in the ontology.

const PAGE = 100;

interface Ui {
  query: Required<Pick<SignalQuery, 'q' | 'source' | 'linked'>>;
  editing: string | null; // the signal being edited
}

let results: { total: number; signals: SignalInfo[] } | null = null;
let failed = false;
let latestSearch = 0; // answers to earlier searches are dropped
let resultsFor = ''; // the catalogue `results` came from: see catalogue()
let resultsQuery = ''; // and the search they answer
let saving: string | null = null; // the signal whose change is being saved

// Which catalogue is shown: the API, the site and who is asking. Results from another are never shown.
const catalogue = (ctx: Context): string =>
  [ctx.api?.baseUrl ?? '', ctx.ontology.site?.id ?? '', ctx.state.user.email, ctx.auth.signedIn].join('|');
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const ui = (ctx: Context): Ui => ctx.ui<Ui>('signals', { query: { q: '', source: '', linked: '' }, editing: null });

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

// What the edit form changes, as the API takes it: only fields that differ; blanks clear.
export function changeFrom(
  form: { unit: string; rate: string; description: string; node: string },
  s: SignalInfo,
): SignalChange | string {
  const change: SignalChange = {};
  const unit = form.unit.trim() || null;
  if (unit !== s.unit) change.unit = unit;
  const rateText = form.rate.trim().replace(',', '.');
  const rate = rateText === '' ? null : Number(rateText);
  if (rate !== null && !(Number.isFinite(rate) && rate > 0))
    return 'The sample rate is a number of readings per second, above 0.';
  if (rate !== s.sample_rate_hz) change.sample_rate_hz = rate;
  const description = form.description.trim();
  if (description !== s.description) change.description = description;
  const node = form.node || null;
  if (node !== s.node_id) change.node_id = node;
  return change;
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
  return `<tr class="edit-row"><td colspan="8">
      <form id="signal-form" data-signal="${esc(s.id)}" class="row" style="gap:12px;flex-wrap:wrap;align-items:end">
        <fieldset style="display:contents" ${saving === s.id ? 'disabled' : ''}>
        <label class="field">Unit<input type="text" name="unit" value="${esc(s.unit ?? '')}" placeholder="e.g. °C" maxlength="40" style="width:7em"></label>
        <label class="field">Sample rate (Hz)<input type="text" name="rate" value="${s.sample_rate_hz ?? ''}" inputmode="decimal" style="width:7em"></label>
        <label class="field" style="flex:1;min-width:200px">Description<input type="text" name="description" value="${esc(s.description)}" maxlength="1000"></label>
        <label class="field">Ontology node<select name="node">${options}</select></label>
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
  const { editing } = ui(ctx);
  const more =
    page.total > page.signals.length
      ? ` Showing the first ${page.signals.length}; narrow the search to see others.`
      : '';
  return `<p class="small soft" data-signal-count>${esc(fmt(page.total, 0))} signal(s).${esc(more)}</p>
    <div class="table-wrap"><table><thead><tr><th>Tag</th><th>Description</th><th>Unit</th><th>Rate</th><th>Source</th><th>Ontology node</th><th>Latest reading</th><th></th></tr></thead><tbody>${page.signals
      .map(
        (s) =>
          `<tr data-row="${esc(s.id)}"><td><code>${esc(s.tag)}</code></td><td>${esc(s.description) || '<span class="soft">—</span>'}</td>
            <td>${esc(s.unit ?? '—')}</td><td>${s.sample_rate_hz === null ? '—' : `${esc(String(s.sample_rate_hz))} Hz`}</td>
            <td>${esc(sourceLabel(s.source))}</td><td>${linkCell(s)}</td><td>${esc(latest(s))}</td>
            <td>${canEdit && editing !== s.id ? `<button class="btn sm" type="button" data-edit="${esc(s.id)}">Edit</button>` : ''}</td></tr>
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

function fill(root: HTMLElement, ctx: Context): void {
  const box = root.querySelector('[data-signal-results]');
  if (!box) return;
  // An edit in progress survives the refresh: its fields, and where the cursor was.
  const form = box.querySelector<HTMLFormElement>('#signal-form');
  // Only fields the user changed: the rest show what the refresh brings (another engineer's edit, say).
  const changed = form
    ? [...form.elements].flatMap((el): [string, string][] =>
        (el instanceof HTMLInputElement && el.value !== el.defaultValue) ||
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
    if (!site || !ctx.api || !sig || saving) return;
    const change = changeFrom(
      {
        unit: field(form, 'unit'),
        rate: field(form, 'rate'),
        description: field(form, 'description'),
        node: field(form, 'node'),
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
        </form>
        <div data-signal-results aria-live="polite"><p class="small soft">Loading…</p></div>
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
  },
};

export default view;
