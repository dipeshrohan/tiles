import { esc, fmt, onAll, onNavigate, routeOf } from '../lib/dom.ts';
import type { WarningInfo, WarningOutcome } from '../lib/api.ts';
import { howFar, OUTCOMES, when } from '../lib/warnings.ts';
import {
  floorOrder,
  headline,
  machineBoard,
  machineOf,
  pathOf,
  placeWarning,
  type FloorItem,
  type FloorState,
} from '../lib/shopfloor.ts';
import type { Context, View } from './types.ts';
import { openWarning } from './warnings.ts';

// The shopfloor view (T5.16): for a tablet on the line, read at arm's length and used with gloves.
// It shows the open warnings first, worst first, each with big buttons: take it, then resolve it
// with what it was. Then every machine of the site, coloured by its worst warning. It refreshes
// itself every 30 seconds. "Full view" hides the navigation for a tablet mounted on a machine.

interface Ui {
  resolving: string | null; // the warning whose outcome buttons are open
  full: boolean;
}

const uiState = (ctx: Context) => ctx.ui<Ui>('shopfloor', { resolving: null, full: false });

const REFRESH_MS = 30_000;
const PAGE = 100;

// The open warnings and the signal catalogue's links (tag to Signal node), for the site fetched.
let listing: { site: string; items: WarningInfo[] | null; at: number | null; more: boolean } | null = null;
let links: { site: string; map: Map<string, string> } | null = null;
let listSeq = 0;
let busy: string | null = null; // the warning a step is on its way for
let timer: ReturnType<typeof setInterval> | null = null;

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;

function stop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  document.body.classList.remove('floor-full');
}

onNavigate((hash) => {
  if (routeOf(hash) !== 'shopfloor') {
    stop();
    listing = null; // others work the warnings meanwhile: each visit fetches afresh
    links = null;
  }
});

async function fetchList(ctx: Context, quiet = false): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const seq = ++listSeq;
  // A quiet refresh keeps what is shown until the answer comes.
  if (!quiet || listing?.site !== site) listing = { site, items: null, at: null, more: false };
  try {
    const items = await ctx.api.warnings.list(site, { status: 'unresolved', limit: PAGE });
    if (seq === listSeq) listing = { site, items, at: Date.now(), more: items.length === PAGE };
  } catch {
    // The client showed why. A quiet refresh keeps the last list; otherwise nothing to show.
    if (seq === listSeq && !quiet) listing = { site, items: [], at: null, more: false };
  }
  if (seq === listSeq && routeOf(location.hash) === 'shopfloor') ctx.rerender();
}

async function fetchLinks(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  links = { site, map: new Map() };
  try {
    const { signals } = await ctx.api.signals.list(site, { linked: 'yes', limit: 500 });
    const map = new Map(signals.filter((s) => s.node_id).map((s) => [s.tag, s.node_id ?? '']));
    if (links.site === site) links = { site, map };
  } catch {
    return; // the client showed why; warnings are placed by the ontology's own tags
  }
  if (routeOf(location.hash) === 'shopfloor') ctx.rerender();
}

// The warnings as the floor reads them: from the API, or the browser's demo detector in local mode.
function items(ctx: Context): FloorItem[] | null {
  const graph = ctx.graph;
  if (!ctx.api) {
    const model = Object.values(graph.nodes).find((n) => n.type === 'Model' && /friction/i.test(n.label));
    const machineId = model ? machineOf(graph, model.id) : null;
    const machine = machineId ? graph.nodes[machineId] : undefined;
    return ctx.state.detection.alerts.map((a, i) => ({
      id: `demo-${i}`,
      tag: 'Plunger friction',
      machineId,
      machine: machine?.label ?? 'Die-caster',
      path: machineId ? pathOf(graph, machineId) : [],
      state: 'new' as FloorState,
      status: 'raised' as const,
      out: false,
      startedAt: null,
      endedAt: null,
      assignee: null,
      assigneeId: null,
      detail: `Shots ${fmt(a.firstShot)}–${fmt(a.lastShot)}, friction peak ${fmt(a.peak, 2)}`,
    }));
  }
  const site = siteId(ctx);
  if (!site || listing?.site !== site || listing.items === null) return null;
  const map = links?.site === site ? links.map : new Map<string, string>();
  return listing.items.map((w) => placeWarning(graph, w, map, howFar(w))).sort(floorOrder);
}

const STATE_LABEL: Record<FloorState, [cls: string, label: string]> = {
  out: ['bad', 'Signal still out'],
  new: ['bad', 'Nobody has it'],
  taken: ['warn', 'Being handled'],
  ok: ['good', 'OK'],
};

function since(item: FloorItem, now: number): string {
  if (!item.startedAt) return '';
  return item.out
    ? `Out since ${esc(when(item.startedAt, now))}`
    : `Started ${esc(when(item.startedAt, now))}, back ${esc(when(item.endedAt ?? item.startedAt, now))}`;
}

function actions(ctx: Context, item: FloorItem, ui: Ui): string {
  if (!ctx.api) return '<p class="small soft">Connect to the Tiles API in Settings to take and resolve warnings.</p>';
  const role = ctx.ontology.role;
  if (role !== 'engineer' && role !== 'admin') return '<p class="small soft">An engineer of the site acts on it.</p>';
  const wait = busy !== null ? 'disabled' : '';
  const label = (verb: string) => `${verb}: ${item.machine}, ${item.tag}`;
  if (ui.resolving === item.id) {
    const outcome = (o: WarningOutcome, cls: string) =>
      `<button class="btn floor-btn ${cls}" data-outcome="${o}" data-id="${esc(item.id)}" ${wait}>${OUTCOMES[o]}</button>`;
    return `<p class="floor-ask">What was it?</p>
      <div class="floor-actions">
        ${outcome('true_alarm', 'danger')}${outcome('false_alarm', '')}${outcome('unknown', '')}
        <button class="btn floor-btn" data-cancel ${wait}>Back</button>
      </div>`;
  }
  const mine = item.assigneeId !== null && item.assigneeId === ctx.ontology.userId;
  const take =
    item.status === 'raised'
      ? `<button class="btn primary floor-btn" data-take="${esc(item.id)}" aria-label="${esc(label("I'm on it"))}" ${wait}>I'm on it</button>`
      : !mine
        ? `<button class="btn floor-btn" data-take="${esc(item.id)}" aria-label="${esc(label('Take it'))}" ${wait}>Take it</button>`
        : '';
  return `<div class="floor-actions">${take}
      <button class="btn floor-btn" data-resolve="${esc(item.id)}" aria-label="${esc(label('Resolve'))}" ${wait}>Resolve</button>
      <button class="btn floor-btn" data-open="${esc(item.id)}" aria-label="${esc(label('Details'))}">Details</button>
    </div>`;
}

function card(ctx: Context, item: FloorItem, ui: Ui, now: number): string {
  const [cls, label] = STATE_LABEL[item.state];
  const where = item.path.length ? `<div class="floor-where">${esc(item.path.join(' › '))}</div>` : '';
  // Who has it, unless the badge already says nobody does.
  const who = item.assignee
    ? `<p><b>${esc(item.assignee)}</b> has it</p>`
    : item.status === 'acknowledged'
      ? '<p>Acknowledged, nobody assigned</p>'
      : item.state === 'out'
        ? '<p>Nobody has it yet</p>'
        : '';
  return `<article class="floor-card s-${item.state}" aria-label="${esc(`${item.machine}: ${label}`)}">
      ${where}
      <h2>${esc(item.machine)}</h2>
      <div class="mono floor-tag">${esc(item.tag)}</div>
      <p class="floor-state"><span class="badge ${cls}">${label}</span> ${since(item, now)}</p>
      <p class="small">${esc(item.detail)}</p>
      ${who}
      ${busy === item.id ? '<p class="small soft" role="status">Sending…</p>' : ''}
      ${actions(ctx, item, ui)}
    </article>`;
}

function board(ctx: Context, list: FloorItem[]): string {
  const tiles = machineBoard(ctx.graph, list);
  if (!tiles.length)
    return '<p class="small soft">The ontology has no machines yet: add them on the Ontology page to see them here.</p>';
  return `<div class="floor-board">${tiles
    .map((t) => {
      const [cls, label] = STATE_LABEL[t.state];
      const count = t.warnings ? `${t.warnings} warning${t.warnings === 1 ? '' : 's'}` : 'No warnings';
      return `<div class="floor-tile s-${t.state}">
          <div class="floor-where">${esc(t.path.join(' › '))}</div>
          <b>${esc(t.label)}</b>
          <span><span class="badge ${cls}">${t.state === 'ok' ? 'OK' : label}</span> <span class="small">${count}</span></span>
        </div>`;
    })
    .join('')}</div>`;
}

async function take(ctx: Context, id: string): Promise<void> {
  const site = siteId(ctx);
  const w = listing?.items?.find((x) => x.id === id);
  if (!ctx.api || !site || !w || busy) return;
  busy = id;
  ctx.rerender();
  try {
    if (w.status === 'raised') await ctx.api.warnings.acknowledge(site, id);
    const me = ctx.ontology.userId;
    if (me && w.assignee_id !== me) await ctx.api.warnings.assign(site, id, me);
    ctx.toast(`It's yours: ${w.signal_tag}`);
  } catch {
    // The client showed why; the list shows the warning as it is now.
  } finally {
    busy = null;
  }
  await fetchList(ctx, true);
}

async function resolve(ctx: Context, id: string, outcome: WarningOutcome): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site || busy) return;
  busy = id;
  ctx.rerender();
  try {
    await ctx.api.warnings.resolve(site, id, outcome);
    uiState(ctx).resolving = null;
    ctx.toast(`Resolved as ${OUTCOMES[outcome].toLowerCase()}`);
  } catch {
    // The client showed why.
  } finally {
    busy = null;
  }
  await fetchList(ctx, true);
}

const view: View = {
  id: 'shopfloor',
  title: 'Shopfloor',
  icon: '▣',
  render(ctx) {
    const ui = uiState(ctx);
    const site = ctx.ontology.site?.name ?? (ctx.api ? '' : 'Demo plant');
    const fullLabel = ui.full ? 'Show navigation' : 'Full view';
    const head = (status: string) => `<div class="floor-head">
        <div><div class="eyebrow">Operations · ${esc(site)}</div>${status}</div>
        <div class="floor-tools">
          ${ctx.api ? '<button class="btn floor-btn" data-floor-refresh>Refresh</button>' : ''}
          <button class="btn floor-btn" data-floor-full aria-pressed="${ui.full}">${fullLabel}</button>
        </div>
      </div>`;
    if (ctx.api && ctx.ontology.status === 'loading') return `<div class="floor">${head('<h1>Loading…</h1>')}</div>`;
    if (ctx.api && ctx.ontology.status !== 'ready')
      return `<div class="floor">${head('<h1>Shopfloor</h1>')}<div class="card" role="alert">Can't reach the Tiles API: ${esc(ctx.ontology.error)}</div></div>`;
    const list = items(ctx);
    if (list === null)
      return `<div class="floor">${head('<h1>Shopfloor</h1>')}<div class="card">Loading the warnings…</div></div>`;
    const now = Date.now();
    const { tone, text } = headline(list);
    const updated =
      listing?.at && ctx.api
        ? `<div class="small soft">Updated ${new Date(listing.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}; refreshes every 30 seconds</div>`
        : ctx.api
          ? ''
          : '<div class="small soft">Demo data from this browser’s plunger-friction detector</div>';
    const status = `<h1 class="floor-headline ${tone}" role="status">${esc(text)}</h1>${updated}`;
    const open = list.filter((i) => i.state !== 'ok');
    const more = listing?.more
      ? '<p class="small soft">Showing the 100 newest open warnings; the Warnings page has the rest.</p>'
      : '';
    const cards = open.length
      ? `<div class="floor-cards">${open.map((i) => card(ctx, i, ui, now)).join('')}</div>${more}`
      : '';
    return `<div class="floor">${head(status)}${cards}
        <h2 class="floor-section">Machines</h2>${board(ctx, list)}</div>`;
  },
  bind(root, ctx) {
    const ui = uiState(ctx);
    document.body.classList.toggle('floor-full', ui.full);
    onAll(root, '[data-floor-full]', 'click', () => {
      ui.full = !ui.full;
      ctx.rerender();
    });
    if (!ctx.api) return;
    if (ctx.ontology.status !== 'ready') return;
    const site = siteId(ctx);
    if (listing?.site !== site) void fetchList(ctx);
    if (links?.site !== site) void fetchLinks(ctx);
    // Polls while the page is shown and nobody is choosing an outcome (a refresh would close it).
    timer ??= setInterval(() => {
      if (routeOf(location.hash) !== 'shopfloor') return stop();
      if (!busy && !uiState(ctx).resolving && !document.hidden) void fetchList(ctx, true);
    }, REFRESH_MS);

    onAll(root, '[data-floor-refresh]', 'click', () => void fetchList(ctx, true));
    onAll(root, '[data-take]', 'click', (el) => void take(ctx, el.dataset.take ?? ''));
    onAll(root, '[data-resolve]', 'click', (el) => {
      ui.resolving = el.dataset.resolve ?? null;
      ctx.rerender();
    });
    onAll(root, '[data-cancel]', 'click', () => {
      ui.resolving = null;
      ctx.rerender();
    });
    onAll(root, '[data-outcome]', 'click', (el) => {
      const id = el.dataset.id;
      const outcome = el.dataset.outcome as WarningOutcome | undefined;
      if (id && outcome) void resolve(ctx, id, outcome);
    });
    onAll(root, '[data-open]', 'click', (el) => openWarning(ctx, el.dataset.open ?? ''));
  },
};

export default view;
