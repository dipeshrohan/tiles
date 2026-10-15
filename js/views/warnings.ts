import { ux } from '../lib/analytics.ts';
import { esc, need, onAll, onNavigate, routeOf, bound, scrollBehavior } from '../lib/dom.ts';
import { fitWidth, gapFor, TIME_CHART, timeChart, toPoints } from '../lib/svg.ts';
import {
  ApiError,
  type Membership,
  type SignalSeries,
  type WarningDetail,
  type WarningInfo,
  type WarningOutcome,
} from '../lib/api.ts';
import {
  actionsFor,
  activityText,
  chartRange,
  DEFAULT_FILTERS,
  filtersFromQuery,
  filtersQuery,
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
import type { Context, View } from './types.ts';
import { listKeys, rowTarget, split } from '../lib/split.ts';
import { withQuery } from '../lib/url-state.ts';
import {
  badge,
  button,
  card,
  emptyState,
  errorState,
  field,
  kv,
  needsApi,
  pageHead,
  select,
  tabs,
  skeleton,
  apiUnreachable,
  term,
} from '../lib/ui.ts';
import { keyAttrs } from '../lib/shortcuts.ts';
import { bindTable, clearSelection, dataTable, tableOrder, type TableOptions } from '../lib/data-table.ts';

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
// `more`: the last page was full, so older warnings may follow.
let listing: { key: string; items: WarningInfo[] | null; more: boolean } | null = null;
let detail: { key: string; warning: WarningDetail } | null = null;
let detailFailed: string | null = null; // the detail key whose fetch failed (not because it is gone)
// The readings around a warning, and the stretch of time they were fetched for (undefined data: loading).
let series: { key: string; data: SignalSeries | null | undefined; range: ReturnType<typeof chartRange> } | null = null;
let members: { site: string; people: Membership[] } | null = null;
let listSeq = 0;
let detailSeq = 0;
let seriesSeq = 0;
let busy: string | false = false; // the step on its way (its button shows it); the others wait
let draft = { key: '', text: '' }; // the note being written, kept across re-renders

const PAGE = 100;

const ago = (iso: string): string => when(iso, Date.now());

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;

// A warning a link named (U3.05), opened once the site has loaded.
let linkedWarning: string | null = null;
function openLinked(ctx: Context): void {
  const site = siteId(ctx);
  if (!linkedWarning || !site) return;
  Object.assign(uiState(ctx), { selected: linkedWarning, site });
  linkedWarning = null;
}

// Others act on warnings and detectors raise new ones while you are elsewhere: each visit fetches afresh.
onNavigate((hash) => {
  if (routeOf(hash) !== 'warnings') {
    acted = null;
    wantNext = false;
    listing = null;
    detail = null;
    detailFailed = null;
    series = null;
    members = null; // roles change, and people join
  }
});

const listKey = (ctx: Context): string => `${siteId(ctx)}|${JSON.stringify(uiState(ctx).filters)}`;
const detailKey = (ctx: Context): string => `${siteId(ctx)}|${uiState(ctx).selected}`;
const seriesKey = (w: WarningDetail): string => `${w.signal_id}|${w.started_at}|${w.ended_at ?? w.last_at}`;

function statusBadge(w: Pick<WarningInfo, 'status'>): string {
  const [cls, label] = STATUS[w.status];
  return badge(label, cls);
}

const signalState = (w: WarningInfo): string => (w.ended_at ? `back ${ago(w.ended_at)}` : '<b>still out</b>');

function filterBar(ctx: Context, f: Filters): string {
  const shows = (Object.keys(SHOW_LABELS) as Show[]).map((s) => [s, SHOW_LABELS[s]] as const);
  return card(
    `${tabs({ label: 'Status', items: shows, current: f.show, data: 'show' })}
      <span class="row gap-3 wrap">
        ${field(
          'Assigned to',
          select(
            null,
            [
              ['anyone', 'anyone'],
              ['me', 'me'],
              ['none', 'nobody'],
            ],
            f.who,
            { attrs: { 'data-filter': 'who' } },
          ),
          { inline: true },
        )}
        ${field(
          'Signal',
          select(
            null,
            [
              ['all', 'out or back'],
              ['open', 'still out'],
              ['ended', 'back in'],
            ],
            f.signal,
            { attrs: { 'data-filter': 'signal' } },
          ),
          { inline: true },
        )}
        ${button('Refresh', { size: 'sm', attrs: { 'data-refresh-warnings': true } })}
      </span>`,
    { class: 'source-bar small', attrs: { 'data-tour': 'warning-filters' } },
  );
}

const STATUS_RANK: Record<WarningInfo['status'], number> = { raised: 0, acknowledged: 1, resolved: 2 };

// The warnings as a table (U5.02): each signal's button opens it beside the list; sorted, its
// columns chosen, exported; engineers acknowledge the ones selected at once.
function listTable(ctx: Context, ui: Ui, items: WarningInfo[], empty: string): TableOptions<WarningInfo> {
  const can = actionsFor({ status: 'raised' }, ctx.ontology.role);
  const bulk = [
    ...(can.includes('acknowledge') ? [{ id: 'acknowledge', label: 'Acknowledge', variant: 'primary' as const }] : []),
    ...(can.includes('assign') && ctx.ontology.userId ? [{ id: 'assign-me', label: 'Assign to me' }] : []),
  ];
  return {
    id: 'warnings',
    label: 'Warnings',
    columns: [
      {
        key: 'signal',
        label: 'Signal',
        value: (w) => w.signal_tag,
        csv: (w) => w.signal_tag,
        cell: (w) =>
          `<button class="row-open mono" type="button"${ui.selected === w.id ? ' aria-current="true"' : ''}>${esc(w.signal_tag)}</button>`,
      },
      {
        key: 'status',
        label: 'Status',
        value: (w) => STATUS_RANK[w.status],
        csv: (w) => w.status,
        cell: (w) => statusBadge(w),
      },
      {
        key: 'started',
        label: 'Started',
        value: (w) => w.started_at,
        csv: (w) => w.started_at,
        cell: (w) => esc(ago(w.started_at)),
      },
      {
        key: 'out',
        label: 'Still out',
        value: (w) => (w.ended_at ? 1 : 0),
        csv: (w) => (w.ended_at ? 'back' : 'still out'),
        cell: (w) => signalState(w),
      },
      { key: 'detector', label: 'Detector', value: (w) => w.detector, cell: (w) => esc(w.detector) },
      {
        key: 'assignee',
        label: 'Assigned to',
        value: (w) => w.assignee,
        cell: (w) => esc(w.assignee ?? 'Unassigned'),
      },
      {
        key: 'outcome',
        label: 'Outcome',
        value: (w) => (w.outcome ? OUTCOMES[w.outcome] : null),
        cell: (w) => (w.outcome ? esc(OUTCOMES[w.outcome]) : '—'),
      },
    ],
    rows: items,
    key: (w) => w.id,
    empty,
    rowAttrs: (w) => ({ 'data-warning': w.id, class: ui.selected === w.id ? 'sel' : undefined }),
    select: bulk.length ? { actions: bulk, run: (action, keys) => bulkAct(ctx, action, keys) } : undefined,
    csv: 'warnings.csv',
  };
}

// Acknowledges the warnings selected that nobody has yet, or assigns them to me (those not mine
// already), four at a time. A refusal stops it (the client says why); what was done is said, and
// the list fetched again.
async function bulkAct(ctx: Context, action: string, keys: string[]): Promise<void> {
  const site = siteId(ctx);
  const api = ctx.api;
  const me = ctx.ontology.userId;
  if (!site || !api) return;
  const byId = new Map((listing?.items ?? []).map((w) => [w.id, w]));
  const assigning = action === 'assign-me';
  // Only those it would change: not mine yet and not resolved (assigning), or new (acknowledging).
  const raised = keys.filter((k) => {
    const w = byId.get(k);
    return assigning ? Boolean(me) && w?.status !== 'resolved' && w?.assignee_id !== me : w?.status === 'raised';
  });
  let done = 0;
  let failed = false;
  const queue = [...raised];
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined && !failed; id = queue.shift()) {
      try {
        await (assigning ? api.warnings.assign(site, id, me) : api.warnings.acknowledge(site, id));
        done++;
      } catch {
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  if (done) {
    const verb = assigning ? 'assigned to you' : 'acknowledged';
    ctx.toast(done === 1 ? `1 warning ${verb}` : `${done} warnings ${verb}`, {
      type: 'success',
      description: failed
        ? `${raised.length - done} weren’t: the notice says why.`
        : raised.length < keys.length
          ? `${keys.length - raised.length} selected had been ${assigning ? 'yours' : 'acknowledged'} already.`
          : undefined,
    });
    ux('task', assigning ? 'warning.assign' : 'warning.acknowledge');
  } else if (!failed)
    ctx.toast(assigning ? 'Nothing to assign' : 'Nothing to acknowledge', {
      description: `The warnings selected had been ${assigning ? 'yours' : 'acknowledged'} already.`,
    });
  clearSelection('warnings');
  listing = null;
  detail = null;
  ctx.rerender();
}

function listCard(ctx: Context, ui: Ui): string {
  const items = listing?.key === listKey(ctx) ? listing.items : null;
  const unfiltered = ui.filters.show === 'unresolved' && ui.filters.who === 'anyone' && ui.filters.signal === 'all';
  // Every warning shown, and none: the site has none yet (not a filter hiding them).
  const none = ui.filters.show === 'all' && ui.filters.who === 'anyone' && ui.filters.signal === 'all';
  const empty = none
    ? emptyState({
        illustration: 'inbox',
        compact: true,
        title: 'No warnings yet',
        body: 'Detectors raise a warning when a signal leaves its usual range; they are listed here as they come.',
      })
    : unfiltered
      ? emptyState({
          illustration: 'done',
          compact: true,
          title: 'Nothing to do: no warning waits for anyone',
          body: 'Detectors raise a warning when a signal leaves its usual range. Resolved ones are under All.',
          action: button('Show all warnings', { size: 'sm', attrs: { 'data-show': 'all' } }),
        })
      : emptyState({
          illustration: 'search',
          compact: true,
          title: 'No warnings match these filters',
          body: 'Try other filters, or clear them to see what waits for anyone.',
          action: button('Clear filters', { size: 'sm', attrs: { 'data-clear-filters': true } }),
        });
  const rows = items === null ? skeleton.list() : items.length ? dataTable(listTable(ctx, ui, items, empty)) : empty;
  const more =
    items && listing?.more ? button('Show older warnings', { size: 'sm', attrs: { 'data-more-warnings': true } }) : '';
  // A tour's "Pick a warning" (U4.07) lights the list only when there is one to pick.
  const tour = rows === empty ? '' : ' data-tour="warning-list"';
  return card(`<div data-warning-list${tour}>${rows}</div>${more}`);
}

function chartCard(w: WarningDetail): string {
  const fetched = series?.key === seriesKey(w) ? series : null;
  const s = fetched?.data;
  if (!fetched || s === undefined) return skeleton.chart('Loading the signal…', TIME_CHART.height);
  if (s === null) return '<p class="small muted">The signal’s readings could not be loaded.</p>';
  const { from, to, start, end } = fetched.range; // the range the readings were fetched for
  const points = toPoints(s);
  return `<div class="explorer-chart" data-tour="warning-chart">${timeChart({
    points,
    from,
    to,
    gap: gapFor(s, points),
    yLabel: s.unit ?? '',
    title: `${w.signal_tag} around the warning${s.unit ? ` (${s.unit})` : ''}`,
    width: fitWidth(TIME_CHART.width),
    levels: [
      { v: w.threshold, label: 'threshold' },
      { v: w.baseline, label: 'baseline' },
    ],
    spans: [{ from: start, to: end }],
  })}<p class="small soft mt-1">The ${term('detector', 'detector')} compares each reading with the ${term('baseline', 'baseline')}; a reading past the ${term('threshold', 'threshold')} is out, and enough in a row (its ${term('persistence', 'persistence')}) raise the warning, shaded.</p></div>`;
}

function actionsForm(ctx: Context, w: WarningDetail): string {
  const actions = actionsFor(w, ctx.ontology.role);
  if (!actions.length) return '';
  const people = (members?.site === siteId(ctx) ? members.people : []).filter((m) => m.role !== 'viewer');
  // The current assignee stays chosen even when not listed (members still loading, or since demoted),
  // so Assign never unassigns by accident.
  const current: [string, string][] =
    w.assignee_id && !people.some((m) => m.user_id === w.assignee_id)
      ? [[w.assignee_id, w.assignee ?? 'current assignee']]
      : [];
  const has = (a: string) => actions.includes(a as never);
  const actButton = (label: string, a: string, variant?: 'primary') =>
    button(label, {
      variant,
      busy: busy === a,
      attrs: {
        'data-act': a,
        ...(a === 'acknowledge' ? keyAttrs('a') : a === 'assign-me' ? keyAttrs('s') : {}),
      },
    });
  const assign = has('assign')
    ? `<span class="row gap-1_5">${field(
        'Assign to',
        select(
          'assignee',
          [
            ['', 'nobody'],
            ...current,
            ...people.map((m) => [m.user_id, `${m.name}${m.user_id === ctx.ontology.userId ? ' (me)' : ''}`] as const),
          ],
          w.assignee_id ?? '',
        ),
        { inline: true },
      )}${actButton('Assign', 'assign')}${w.assignee_id !== ctx.ontology.userId && ctx.ontology.userId ? actButton('Assign to me', 'assign-me') : ''}</span>`
    : '';
  const outcomes = (Object.keys(OUTCOMES) as WarningOutcome[]).map((o) => [o, OUTCOMES[o]] as const);
  const resolve = has('resolve')
    ? `<span class="row gap-1_5">${field('Outcome', select('outcome', outcomes, '', { attrs: keyAttrs('r') }), { inline: true })}${actButton('Resolve', 'resolve', 'primary')}</span>`
    : '';
  return `<form class="stack gap-2 mt-2_5" id="warning-form" data-tour="warning-actions">
      <textarea name="note" rows="2" maxlength="2000" placeholder="A note (optional, except for a comment)" aria-label="Note">${draft.key === detailKey(ctx) ? esc(draft.text) : ''}</textarea>
      <fieldset class="row gap-y-2 gap-x-4 border-0 p-0 m-0 wrap" ${busy ? 'disabled' : ''}>
        ${has('acknowledge') ? actButton('Acknowledge', 'acknowledge', 'primary') : ''}
        ${assign}
        ${resolve}
        ${has('reopen') ? actButton('Reopen', 'reopen') : ''}
        ${actButton('Comment', 'comment')}
      </fieldset>
    </form>`;
}

function detailCard(ctx: Context, ui: Ui): string {
  if (ui.selected === null)
    return card(
      emptyState({
        illustration: 'select',
        title: 'Select a warning',
        body: 'Its signal and what was done about it show here.',
      }),
    );
  const w = detail?.key === detailKey(ctx) ? detail.warning : null;
  if (!w && detailFailed === detailKey(ctx))
    return card(errorState({ title: 'This warning could not be loaded', body: 'Refresh to try again.' }), {
      attrs: { 'data-warning-detail': true },
    });
  if (!w) return card(skeleton.card(), { attrs: { 'data-warning-detail': true } });
  const activity = w.activity
    .map(
      (a) => `
      <div class="comment">
        <div class="small muted"><b>${esc(activityText(a))}</b> · ${ago(a.at)}</div>
        ${a.note ? `<div class="comment-body">${esc(a.note)}</div>` : ''}
      </div>`,
    )
    .join('');
  const resolved =
    w.status === 'resolved' && w.outcome
      ? `<p class="small">${OUTCOMES[w.outcome]}, resolved by ${esc(w.resolved_by ?? 'someone')} ${w.resolved_at ? ago(w.resolved_at) : ''}${w.resolution_note ? `: ${esc(w.resolution_note)}` : '.'}</p>`
      : '';
  const readOnly =
    ctx.ontology.role === 'viewer' ? '<p class="small soft">Engineers and admins of the site act on warnings.</p>' : '';
  return card(
    `
      <div class="card-head"><div>
        ${statusBadge(w)} ${w.ended_at ? '' : badge('Signal still out', 'bad')}
        <h2 class="mono mt-1_5">${esc(w.signal_tag)}</h2>
        <div class="small muted">${esc(w.detector)} · started ${ago(w.started_at)} · ${w.readings} reading(s) out · ${w.assignee ? `for ${esc(w.assignee)}` : 'unassigned'}</div>
      </div></div>
      <p class="small" data-how-far>${esc(howFar(w))}</p>
      ${resolved}
      ${chartCard(w)}
      <h3 class="mt-4 mb-1_5 m-0">Activity</h3>
      <div class="thread">${activity}</div>
      ${readOnly}
      ${actionsForm(ctx, w)}
      ${acted?.id === w.id ? `<p class="row gap-2 mt-2_5">${button('Next warning', { variant: 'primary', icon: 'arrow-right', attrs: { 'data-next-warning': true, ...keyAttrs('n') } })}</p>` : ''}
      <details class="mt-3_5"><summary class="small">Payload</summary>
        ${kv(payload(w), { valueClass: 'mono' })}
      </details>`,
    { attrs: { 'data-warning-detail': true } },
  );
}

async function fetchList(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const key = listKey(ctx);
  const seq = ++listSeq;
  listing = { key, items: null, more: false };
  try {
    const items = await ctx.api.warnings.list(site, { ...queryFor(uiState(ctx).filters), limit: PAGE });
    if (seq === listSeq) listing = { key, items, more: items.length === PAGE };
  } catch {
    if (seq === listSeq) listing = { key, items: [], more: false }; // the client showed why
  }
  if (seq === listSeq) ctx.rerender();
}

// The next page of the list, after the ones shown.
async function fetchMore(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  const shown = listing;
  if (!ctx.api || !site || !shown?.items || shown.key !== listKey(ctx)) return;
  const seq = ++listSeq;
  try {
    const query = { ...queryFor(uiState(ctx).filters), limit: PAGE, offset: shown.items.length };
    const page = await ctx.api.warnings.list(site, query);
    if (seq !== listSeq) return;
    const seen = new Set(shown.items.map((w) => w.id)); // one may have moved up meanwhile
    listing = {
      key: shown.key,
      items: [...shown.items, ...page.filter((w) => !seen.has(w.id))],
      more: page.length === PAGE,
    };
  } catch {
    if (seq !== listSeq) return;
    listing = { ...shown, more: true }; // the client showed why; try again
  }
  ctx.rerender();
}

async function fetchSeries(ctx: Context, w: WarningDetail): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const key = seriesKey(w);
  const seq = ++seriesSeq;
  const range = chartRange(w, Date.now());
  series = { key, data: undefined, range };
  const { from, to } = range;
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
  series = { key, data, range };
  ctx.rerender();
}

async function fetchDetail(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  const id = uiState(ctx).selected;
  if (!ctx.api || !site || id === null) return;
  const key = detailKey(ctx);
  const seq = ++detailSeq;
  detailFailed = null;
  try {
    const warning = await ctx.api.warnings.get(site, id);
    if (seq !== detailSeq) return;
    detail = { key, warning };
  } catch (e) {
    if (seq !== detailSeq) return;
    // Gone (or another site's): let it go. Otherwise keep it selected, to try again.
    if (e instanceof ApiError && e.status === 404) uiState(ctx).selected = null;
    else detailFailed = key;
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

// The warning last acted on, and where it was in the list's order: Next warning opens the one after
// it (or, when it left the list, the one that took its place). `wantNext`: asked for while the list
// was being fetched again, or its next page; done when it comes.
let acted: { id: string; at: number } | null = null;
let wantNext = false;

// The list's warnings in the order its table shows them, every one (drawn or not); null while fetched.
function inOrder(ctx: Context): WarningInfo[] | null {
  const items = listing?.key === listKey(ctx) ? listing.items : null;
  return items ? tableOrder(listTable(ctx, uiState(ctx), items, '')) : null;
}

function nextWarning(ctx: Context): void {
  if (!acted) return;
  const list = inOrder(ctx);
  if (!list) {
    wantNext = true; // the list is on its way
    return;
  }
  wantNext = false;
  const here = list.findIndex((w) => w.id === acted?.id);
  const next = here >= 0 ? list[here + 1] : list[Math.min(Math.max(acted.at, 0), list.length - 1)];
  if (!next) {
    if (listing?.more) {
      wantNext = true; // older warnings first
      void fetchMore(ctx);
      return;
    }
    acted = null;
    ctx.rerender();
    ctx.toast('That was the last warning in the list');
    return;
  }
  acted = null;
  Object.assign(uiState(ctx), { selected: next.id });
  ctx.rerender();
  ux('task', 'warning.next');
  // As j and k do: the focus on its row, in view.
  requestAnimationFrame(() => {
    const row = document.querySelector(`[data-warning-list] [data-warning="${CSS.escape(next.id)}"]`);
    rowTarget(row)?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  });
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
    'assign-me': () => api.assign(site, w.id, ctx.ontology.userId, note),
    resolve: () => api.resolve(site, w.id, value('outcome') as WarningOutcome, note),
    reopen: () => api.reopen(site, w.id, note),
    comment: () => api.comment(site, w.id, note),
  };
  const call = calls[action];
  if (!call) return;
  busy = action;
  ++detailSeq; // a fetch of the warning started before this step must not replace its result
  // Acknowledging is shown at once (U2.08), and undone if the API refuses it.
  const before = { detail, item: listing?.items?.find((i) => i.id === w.id) };
  if (action === 'acknowledge' && detail) {
    const now = new Date().toISOString();
    const shown = { status: 'acknowledged' as const, acknowledged_at: now, acknowledged_by: ctx.state.user.name };
    detail = { ...detail, warning: { ...detail.warning, ...shown } };
    if (listing?.items) listing.items = listing.items.map((i) => (i.id === w.id ? { ...i, ...shown } : i));
  }
  ctx.rerender();
  try {
    const warning = await call();
    const key = `${site}|${warning.id}`;
    detail = { key, warning };
    if (draft.key === key) draft = { key: '', text: '' };
    // Assigning it to whom it already was changes nothing (a note is kept as a comment).
    const same = (action === 'assign' || action === 'assign-me') && warning.assignee_id === w.assignee_id;
    const done: Record<string, string> = {
      acknowledge: 'Acknowledged',
      assign: same
        ? `${warning.assignee ? `Already assigned to ${warning.assignee}` : 'Already unassigned'}${note ? '; your note is kept as a comment' : ''}`
        : warning.assignee
          ? `Assigned to ${warning.assignee}`
          : 'Unassigned',
      'assign-me': same
        ? `Already assigned to you${note ? '; your note is kept as a comment' : ''}`
        : 'Assigned to you',
      resolve: `Resolved as ${warning.outcome ? OUTCOMES[warning.outcome].toLowerCase() : 'done'}`,
      reopen: 'Reopened',
      comment: 'Comment added',
    };
    ctx.toast(done[action] ?? 'Done');
    ux('task', `warning.${action === 'assign-me' ? 'assign' : action}`);
    if (action !== 'comment' && !same) listing = null; // it may have left the list's filters
    // Done with this one: Next warning (n) opens the one after it in the list (U5.04).
    if (action !== 'comment') acted = { id: w.id, at: inOrder(ctx)?.findIndex((i) => i.id === w.id) ?? 0 };
  } catch {
    // The client showed why. An acknowledgement shown at once is taken back at once; then, as after
    // any refused step, the warning and the list are fetched again (someone may have changed it).
    if (action === 'acknowledge' && before.detail) {
      detail = before.detail;
      const item = before.item;
      if (listing?.items && item) listing.items = listing.items.map((i) => (i.id === w.id ? item : i));
      void fetchDetail(ctx);
      void fetchList(ctx);
    } else {
      detail = null;
      listing = null;
    }
  } finally {
    busy = false;
    ctx.rerender();
  }
}

// Opens this page on one warning, whatever the filters show (the shopfloor view's Details).
export function openWarning(ctx: Context, id: string): void {
  Object.assign(uiState(ctx), { selected: id, site: siteId(ctx) });
  location.hash = '#/warnings';
}

const view: View = {
  id: 'warnings',
  title: 'Warnings',
  icon: 'triangle-alert',
  // Its filters and the warning open, in the address (U3.05): `#/warnings?show=all&warning=12`.
  query: {
    read(params, ctx) {
      const ui = uiState(ctx);
      // A link naming only a warning (the command palette's) keeps the filters you set.
      if (['show', 'who', 'signal'].some((k) => params.has(k))) ui.filters = filtersFromQuery(params);
      // The warning a link opens: on this site, once the site is known.
      linkedWarning = params.get('warning');
      if (!linkedWarning) Object.assign(ui, { selected: null, site: null });
      openLinked(ctx);
    },
    write(ctx) {
      const ui = uiState(ctx);
      return { ...filtersQuery(ui.filters), warning: linkedWarning ?? (ui.site === siteId(ctx) ? ui.selected : null) };
    },
  },
  // The warning open beside the list (kept in the page's state, so a reload shows it again).
  crumbs(ctx) {
    const w = uiState(ctx).selected !== null && detail?.key === detailKey(ctx) ? detail.warning : null;
    return ctx.api && w ? [{ label: w.signal_tag }] : [];
  },
  render(ctx) {
    openLinked(ctx); // a linked warning waiting for the site
    const head = pageHead({
      eyebrow: 'Operations · Detection',
      title: 'Warnings',
      lead: 'What the detectors raised: see the signal around each warning, then acknowledge it, assign it, and resolve it with what it turned out to be.',
    });
    if (!ctx.api)
      return `${head}${card(needsApi(`Warnings come from detectors running on the Tiles API, and everyone on a site works the same ones.`))}`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}${card(skeleton.card('Loading from the Tiles API…'))}`;
    if (o.status !== 'ready')
      return `${head}${apiUnreachable(o.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })}`;
    const ui = uiState(ctx);
    return `${head}${filterBar(ctx, ui.filters)}${split(listCard(ctx, ui), detailCard(ctx, ui), {
      open: ui.selected !== null,
      back: withQuery('#/warnings', filtersQuery(ui.filters)),
      label: 'warnings',
    })}`;
  },
  bind(root, ctx) {
    if (!ctx.api || ctx.ontology.status !== 'ready') return;
    const ui = uiState(ctx);
    const site = siteId(ctx);
    if (ui.site !== site) {
      Object.assign(ui, { selected: null, site }); // another site's warning
      acted = null;
    }
    if (wantNext && listing?.key === listKey(ctx) && listing.items) nextWarning(ctx); // asked for while it came
    if (listing?.key !== listKey(ctx)) void fetchList(ctx);
    // A failed fetch waits for Refresh, rather than retrying at every render.
    if (ui.selected !== null && detail?.key !== detailKey(ctx) && detailFailed !== detailKey(ctx))
      void fetchDetail(ctx);
    const shown = detail?.key === detailKey(ctx) ? detail.warning : null;
    if (shown && series?.key !== seriesKey(shown)) void fetchSeries(ctx, shown); // once per warning
    if (site && members?.site !== site && actionsFor({ status: 'raised' }, ctx.ontology.role).length)
      void fetchMembers(ctx);

    onAll(root, '[data-show]', 'click', (el) => {
      acted = null; // another list: no next in it
      ui.filters = { ...ui.filters, show: (el.dataset.show as Show | undefined) ?? 'unresolved' };
      ctx.rerender();
    });
    onAll(root, '[data-clear-filters]', 'click', () => {
      ui.filters = { ...DEFAULT_FILTERS };
      ctx.rerender();
    });
    onAll(root, '[data-filter]', 'change', (el) => {
      acted = null;
      const value = (el as HTMLSelectElement).value;
      ui.filters = { ...ui.filters, [el.dataset.filter ?? '']: value } as Filters;
      ctx.rerender();
    });
    // On the list, not each row: the table draws rows again as it sorts and scrolls.
    onAll(root, '[data-warning-list]', 'click', (_el, e) => {
      const t = e.target instanceof Element ? e.target : null;
      const row = t?.closest<HTMLElement>('[data-warning]');
      if (!row || t?.closest('.select-col, .table-tools, .bulk-bar')) return; // a box ticked, not the row opened
      ui.selected = row.dataset.warning ?? null;
      ctx.rerender();
    });
    const items = listing?.key === listKey(ctx) ? listing.items : null;
    if (items?.length) bindTable(root, listTable(ctx, ui, items, ''));
    listKeys(root, '[data-warning-list] [data-warning]', (row) => row.getAttribute('data-warning') === ui.selected);
    // Back to the list (a narrow screen): no warning open, though the address keeps the filters.
    onAll(root, '.split-back', 'click', () => {
      linkedWarning = null;
      Object.assign(ui, { selected: null });
    });
    onAll(root, '[data-refresh-warnings]', 'click', () => {
      if (busy) return; // the step's answer refreshes it
      listing = null;
      detail = null;
      detailFailed = null;
      series = null;
      ctx.rerender();
    });
    onAll(root, '[data-more-warnings]', 'click', () => void fetchMore(ctx));
    root.querySelector<HTMLTextAreaElement>('#warning-form textarea')?.addEventListener(
      'input',
      (e) => {
        draft = { key: detailKey(ctx), text: (e.target as HTMLTextAreaElement).value };
      },
      { signal: bound() },
    );
    onAll(root, '[data-next-warning]', 'click', () => nextWarning(ctx));
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
