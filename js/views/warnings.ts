import { esc, need, onAll } from '../lib/dom.ts';
import { fitWidth, TIME_CHART, timeChart } from '../lib/svg.ts';
import type { Membership, SignalSeries, WarningDetail, WarningInfo, WarningOutcome } from '../lib/api.ts';
import {
  actionsFor,
  activityText,
  chartRange,
  DEFAULT_FILTERS,
  howFar,
  OUTCOMES,
  payload,
  queryFor,
  SHOW_LABELS,
  STATUS,
  type Filters,
  type Show,
  when,
} from '../lib/warnings.ts';
import { gapFor, toPoints } from './explorer.ts';
import type { Context, View } from './types.ts';

// The warnings inbox (T3.08): the warnings detectors raised on the site, filtered by where they
// are in their workflow and who has them; each with a chart of its signal around it, its payload
// and activity, and the steps people take: acknowledge, assign, resolve with an outcome, reopen,
// comment. Shared through the Tiles API, so it needs API mode.

interface Ui {
  filters: Filters;
  selected: string | null;
  site: string | null; // the site `selected` is a warning of
}

const uiState = (ctx: Context) =>
  ctx.ui<Ui>('warnings', { filters: { ...DEFAULT_FILTERS }, selected: null, site: null });

// Fetched data, for the site and filters (or warning) it was fetched for.
let listing: { key: string; items: WarningInfo[] | null } | null = null;
let detail: { key: string; warning: WarningDetail } | null = null;
let series: { key: string; data: SignalSeries | null | undefined } | null = null; // undefined: loading
let members: { site: string; people: Membership[] } | null = null;
let listSeq = 0;
let detailSeq = 0;
let seriesSeq = 0;
let busy = false; // a step is on its way; the buttons wait
let draft = { key: '', text: '' }; // the note being written, kept across re-renders

const ago = (iso: string): string => when(iso, Date.now());

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;

// Others act on warnings and detectors raise new ones while you are elsewhere: each visit fetches afresh.
if (typeof window !== 'undefined')
  window.addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#/warnings')) {
      listing = null;
      detail = null;
      series = null;
    }
  });

const listKey = (ctx: Context): string => `${siteId(ctx)}|${JSON.stringify(uiState(ctx).filters)}`;
const detailKey = (ctx: Context): string => `${siteId(ctx)}|${uiState(ctx).selected}`;
const seriesKey = (w: WarningDetail): string => `${w.signal_id}|${w.started_at}|${w.ended_at ?? w.last_at}`;

function badge(w: Pick<WarningInfo, 'status'>): string {
  const [cls, label] = STATUS[w.status];
  return `<span class="badge ${cls}">${label}</span>`;
}

const signalState = (w: WarningInfo): string => (w.ended_at ? `back ${ago(w.ended_at)}` : '<b>still out</b>');

function filterBar(ctx: Context, f: Filters): string {
  const tabs = (Object.keys(SHOW_LABELS) as Show[])
    .map(
      (s) =>
        `<button class="tab ${f.show === s ? 'active' : ''}" data-show="${s}" role="tab">${SHOW_LABELS[s]}</button>`,
    )
    .join('');
  const option = (value: string, label: string, current: string) =>
    `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;
  return `<div class="card source-bar small">
      <div class="tabs" role="tablist" aria-label="Status">${tabs}</div>
      <span class="row" style="gap:12px;flex-wrap:wrap">
        <label class="row" style="gap:6px">Assigned to <select data-filter="who">${option('anyone', 'anyone', f.who)}${option('me', 'me', f.who)}${option('none', 'nobody', f.who)}</select></label>
        <label class="row" style="gap:6px">Signal <select data-filter="signal">${option('all', 'out or back', f.signal)}${option('open', 'still out', f.signal)}${option('ended', 'back in', f.signal)}</select></label>
        <button class="btn sm" data-refresh-warnings>Refresh</button>
      </span>
    </div>`;
}

function listCard(ctx: Context, ui: Ui): string {
  const items = listing?.key === listKey(ctx) ? listing.items : null;
  const empty =
    ui.filters.show === 'unresolved' && ui.filters.who === 'anyone' && ui.filters.signal === 'all'
      ? 'Nothing to do: no warning waits for anyone.'
      : 'No warnings match these filters.';
  const rows =
    items === null
      ? '<div class="empty">Loading…</div>'
      : items
          .map(
            (w) => `
        <button class="review-row ${ui.selected === w.id ? 'sel' : ''}" data-warning="${esc(w.id)}">
          <span class="row" style="gap:8px;justify-content:space-between"><b class="mono">${esc(w.signal_tag)}</b>${badge(w)}</span>
          <span class="small muted">${ago(w.started_at)} · ${esc(w.detector)} · ${signalState(w)}</span>
          <span class="small">${w.assignee ? `For ${esc(w.assignee)}` : 'Unassigned'}${w.outcome ? ` · ${OUTCOMES[w.outcome]}` : ''}</span>
        </button>`,
          )
          .join('') || `<div class="empty">${empty}</div>`;
  return `<div class="card"><div class="review-list" data-warning-list>${rows}</div></div>`;
}

function chartCard(w: WarningDetail): string {
  const s = series?.key === seriesKey(w) ? series.data : undefined;
  if (s === undefined) return '<div class="empty">Loading the signal…</div>';
  if (s === null) return '<p class="small muted">The signal’s readings could not be loaded.</p>';
  const { from, to, start, end } = chartRange(w, Date.now());
  const points = toPoints(s);
  return `<div class="explorer-chart">${timeChart({
    points,
    from,
    to,
    gap: gapFor(s, points),
    yLabel: s.unit ?? '',
    width: fitWidth(TIME_CHART.width),
    levels: [
      { v: w.threshold, label: 'threshold' },
      { v: w.baseline, label: 'baseline' },
    ],
    spans: [{ from: start, to: end }],
  })}</div>`;
}

function actionsForm(ctx: Context, w: WarningDetail): string {
  const actions = actionsFor(w, ctx.ontology.role);
  if (!actions.length) return '';
  const people = (members?.site === siteId(ctx) ? members.people : []).filter((m) => m.role !== 'viewer');
  const has = (a: string) => actions.includes(a as never);
  const assign = has('assign')
    ? `<span class="row" style="gap:6px"><label class="row" style="gap:6px">Assign to <select name="assignee">
        <option value="">nobody</option>
        ${people.map((m) => `<option value="${esc(m.user_id)}" ${m.user_id === w.assignee_id ? 'selected' : ''}>${esc(m.name)}${m.user_id === ctx.ontology.userId ? ' (me)' : ''}</option>`).join('')}
      </select></label><button class="btn" type="button" data-act="assign">Assign</button></span>`
    : '';
  const resolve = has('resolve')
    ? `<span class="row" style="gap:6px"><label class="row" style="gap:6px">Outcome <select name="outcome">
        ${(Object.keys(OUTCOMES) as WarningOutcome[]).map((o) => `<option value="${o}">${OUTCOMES[o]}</option>`).join('')}
      </select></label><button class="btn primary" type="button" data-act="resolve">Resolve</button></span>`
    : '';
  return `<form class="stack" id="warning-form" style="gap:8px;margin-top:10px">
      <textarea name="note" rows="2" maxlength="2000" placeholder="A note (optional, except for a comment)" aria-label="Note">${draft.key === detailKey(ctx) ? esc(draft.text) : ''}</textarea>
      <fieldset class="row" style="gap:8px 16px;border:0;padding:0;margin:0;flex-wrap:wrap" ${busy ? 'disabled' : ''}>
        ${has('acknowledge') ? '<button class="btn primary" type="button" data-act="acknowledge">Acknowledge</button>' : ''}
        ${assign}
        ${resolve}
        ${has('reopen') ? '<button class="btn" type="button" data-act="reopen">Reopen</button>' : ''}
        <button class="btn" type="button" data-act="comment">Comment</button>
      </fieldset>
    </form>`;
}

function detailCard(ctx: Context, ui: Ui): string {
  if (ui.selected === null)
    return '<div class="card"><div class="empty">Select a warning to see its signal and what was done.</div></div>';
  const w = detail?.key === detailKey(ctx) ? detail.warning : null;
  if (!w) return '<div class="card" data-warning-detail><div class="empty">Loading…</div></div>';
  const activity = w.activity
    .map(
      (a) => `
      <div class="comment">
        <div class="small muted"><b>${esc(activityText(a))}</b> · ${ago(a.at)}</div>
        ${a.note ? `<div class="comment-body">${esc(a.note)}</div>` : ''}
      </div>`,
    )
    .join('');
  const rows = payload(w)
    .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td class="mono">${esc(v)}</td></tr>`)
    .join('');
  const resolved =
    w.status === 'resolved' && w.outcome
      ? `<p class="small">${OUTCOMES[w.outcome]}, resolved by ${esc(w.resolved_by ?? 'someone')} ${w.resolved_at ? ago(w.resolved_at) : ''}${w.resolution_note ? `: ${esc(w.resolution_note)}` : '.'}</p>`
      : '';
  const readOnly =
    ctx.ontology.role === 'viewer' ? '<p class="small soft">Engineers and admins of the site act on warnings.</p>' : '';
  return `
    <div class="card" data-warning-detail>
      <div class="card-head"><div>
        ${badge(w)} ${w.ended_at ? '' : '<span class="badge bad">Signal still out</span>'}
        <h2 style="margin-top:6px" class="mono">${esc(w.signal_tag)}</h2>
        <div class="small muted">${esc(w.detector)} · started ${ago(w.started_at)} · ${w.readings} reading(s) out · ${w.assignee ? `for ${esc(w.assignee)}` : 'unassigned'}</div>
      </div></div>
      <p class="small" data-how-far>${esc(howFar(w))}</p>
      ${resolved}
      ${chartCard(w)}
      <h3 style="margin:16px 0 6px">Activity</h3>
      <div class="thread">${activity}</div>
      ${readOnly}
      ${actionsForm(ctx, w)}
      <details style="margin-top:14px"><summary class="small">Payload</summary>
        <div class="table-wrap"><table class="small"><tbody>${rows}</tbody></table></div>
      </details>
    </div>`;
}

async function fetchList(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const key = listKey(ctx);
  const seq = ++listSeq;
  listing = { key, items: null };
  try {
    const items = await ctx.api.warnings.list(site, { ...queryFor(uiState(ctx).filters), limit: 200 });
    if (seq === listSeq) listing = { key, items };
  } catch {
    if (seq === listSeq) listing = { key, items: [] }; // the client showed why
  }
  if (seq === listSeq) ctx.rerender();
}

async function fetchSeries(ctx: Context, w: WarningDetail): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const key = seriesKey(w);
  const seq = ++seriesSeq;
  const { from, to } = chartRange(w, Date.now());
  let data: SignalSeries | null;
  try {
    data = await ctx.api.signals.series(
      site,
      w.signal_id,
      new Date(from).toISOString(),
      new Date(to).toISOString(),
      400,
    );
  } catch {
    data = null; // the client showed why
  }
  if (seq !== seriesSeq) return;
  series = { key, data };
  ctx.rerender();
}

async function fetchDetail(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  const id = uiState(ctx).selected;
  if (!ctx.api || !site || id === null) return;
  const key = detailKey(ctx);
  const seq = ++detailSeq;
  try {
    const warning = await ctx.api.warnings.get(site, id);
    if (seq !== detailSeq) return;
    detail = { key, warning };
  } catch {
    if (seq !== detailSeq) return;
    uiState(ctx).selected = null; // gone, or another site's
  }
  ctx.rerender();
}

async function fetchMembers(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  members = { site, people: [] };
  try {
    const people = await ctx.api.members(site);
    if (members.site === site) members = { site, people };
  } catch {
    // The client showed why; assigning lists nobody.
  }
  ctx.rerender();
}

async function act(ctx: Context, action: string, note: string, form: HTMLFormElement): Promise<void> {
  const site = siteId(ctx);
  const w = detail?.warning;
  if (!ctx.api || !site || !w || busy) return;
  const api = ctx.api.warnings;
  const value = (name: string) => form.querySelector<HTMLSelectElement>(`[name="${name}"]`)?.value ?? '';
  const calls: Record<string, () => Promise<WarningDetail>> = {
    acknowledge: () => api.acknowledge(site, w.id, note),
    assign: () => api.assign(site, w.id, value('assignee') || null, note),
    resolve: () => api.resolve(site, w.id, value('outcome') as WarningOutcome, note),
    reopen: () => api.reopen(site, w.id, note),
    comment: () => api.comment(site, w.id, note),
  };
  const call = calls[action];
  if (!call) return;
  busy = true;
  ctx.rerender();
  try {
    const warning = await call();
    detail = { key: `${site}|${warning.id}`, warning };
    draft = { key: '', text: '' };
    const done: Record<string, string> = {
      acknowledge: 'Acknowledged',
      assign: warning.assignee ? `Assigned to ${warning.assignee}` : 'Unassigned',
      resolve: `Resolved as ${warning.outcome ? OUTCOMES[warning.outcome].toLowerCase() : 'done'}`,
      reopen: 'Reopened',
      comment: 'Comment added',
    };
    ctx.toast(done[action] ?? 'Done');
    if (action !== 'comment') listing = null; // it may have left the list's filters
  } catch {
    // The client showed why; show the warning as it is now.
    detail = null;
    listing = null;
  } finally {
    busy = false;
    ctx.rerender();
  }
}

const view: View = {
  id: 'warnings',
  title: 'Warnings',
  icon: '⚠',
  render(ctx) {
    const head = `<div class="page-head"><div><div class="eyebrow">Operations · Detection</div><h1>Warnings</h1>
        <p class="soft">What the detectors raised: see the signal around each warning, then acknowledge it, assign it, and resolve it with what it turned out to be.</p></div></div>`;
    if (!ctx.api)
      return `${head}<div class="card"><p>Warnings come from detectors running on the Tiles API, and everyone on a site works the same ones. Connect to it in <a href="#/settings">Settings</a>.</p></div>`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}<div class="card">Loading from the Tiles API…</div>`;
    if (o.status !== 'ready')
      return `${head}<div class="card" role="alert">Can't reach the Tiles API: ${esc(o.error)}</div>`;
    const ui = uiState(ctx);
    return `${head}${filterBar(ctx, ui.filters)}<div class="reviews">${listCard(ctx, ui)}${detailCard(ctx, ui)}</div>`;
  },
  bind(root, ctx) {
    if (!ctx.api || ctx.ontology.status !== 'ready') return;
    const ui = uiState(ctx);
    const site = siteId(ctx);
    if (ui.site !== site) Object.assign(ui, { selected: null, site }); // another site's warning
    if (listing?.key !== listKey(ctx)) void fetchList(ctx);
    if (ui.selected !== null && detail?.key !== detailKey(ctx)) void fetchDetail(ctx);
    const shown = detail?.key === detailKey(ctx) ? detail.warning : null;
    if (shown && series?.key !== seriesKey(shown)) {
      series = { key: seriesKey(shown), data: undefined }; // fetched once per warning
      void fetchSeries(ctx, shown);
    }
    if (site && members?.site !== site && actionsFor({ status: 'raised' }, ctx.ontology.role).length)
      void fetchMembers(ctx);

    onAll(root, '[data-show]', 'click', (el) => {
      ui.filters = { ...ui.filters, show: (el.dataset.show as Show | undefined) ?? 'unresolved' };
      ctx.rerender();
    });
    onAll(root, '[data-filter]', 'change', (el) => {
      const value = (el as HTMLSelectElement).value;
      ui.filters = { ...ui.filters, [el.dataset.filter ?? '']: value } as Filters;
      ctx.rerender();
    });
    onAll(root, '[data-warning]', 'click', (el) => {
      ui.selected = el.dataset.warning ?? null;
      ctx.rerender();
    });
    onAll(root, '[data-refresh-warnings]', 'click', () => {
      listing = null;
      detail = null;
      series = null;
      ctx.rerender();
    });
    root.querySelector<HTMLTextAreaElement>('#warning-form textarea')?.addEventListener('input', (e) => {
      draft = { key: detailKey(ctx), text: (e.target as HTMLTextAreaElement).value };
    });
    onAll(root, '[data-act]', 'click', (el) => {
      const form = need<HTMLFormElement>(root, '#warning-form');
      const box = need<HTMLTextAreaElement>(form, 'textarea');
      const action = el.dataset.act ?? '';
      const note = box.value.trim();
      if (action === 'comment' && !note) {
        ctx.toast('Write the comment first');
        return void box.focus();
      }
      void act(ctx, action, note, form);
    });
  },
};

export default view;
