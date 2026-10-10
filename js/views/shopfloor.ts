import { announce, esc, onAll, onNavigate, routeOf } from '../lib/dom.ts';
import type { WarningOutcome } from '../lib/api.ts';
import { OUTCOMES, when } from '../lib/warnings.ts';
import { headline, machineBoard, type FloorItem } from '../lib/shopfloor.ts';
import type { Graph } from '../lib/types.ts';
import {
  ensureFloor,
  fetchWarnings,
  floorItems,
  listed,
  PAGE,
  refreshFloor,
  STATE_LABEL,
  warningById,
} from './floor-data.ts';
import type { Context, View } from './types.ts';
import { apiUnreachable } from '../lib/ui.ts';
import { openWarning } from './warnings.ts';
import { skeleton } from '../lib/ui.ts';

// The shopfloor view (T5.16): for a tablet on the line, read at arm's length and used with gloves.
// It shows the open warnings first, worst first, each with big buttons: take it, then resolve it
// with what it was. Then every machine of the site, coloured by its worst warning. It refreshes
// itself every 30 seconds. "Full view" hides the navigation for a tablet mounted on a machine.

interface Ui {
  resolving: string | null; // the warning whose outcome buttons are open
  taking: string | null; // the warning, someone else's, whose "take it from them?" is open
  full: boolean;
}

const uiState = (ctx: Context) => ctx.ui<Ui>('shopfloor', { resolving: null, taking: null, full: false });

const REFRESH_MS = 30_000;

let busy: string | null = null; // the warning a step is on its way for
// The headline shown, and the one screen readers were last told of: a change (a refresh) is announced.
let shownHeadline: { site: string | null; text: string } | null = null;
let toldHeadline: { site: string | null; text: string } | null = null;
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
    shownHeadline = null;
    toldHeadline = null; // the next visit opens on its headline, unannounced
  }
});

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
  // Taking a warning from a colleague asks first: a brushed button mustn't take it off them.
  if (ui.taking === item.id && item.assignee) {
    return `<p class="floor-ask">Take it from ${esc(item.assignee)}?</p>
      <div class="floor-actions">
        <button class="btn primary floor-btn" data-take="${esc(item.id)}" ${wait}>Yes, take it</button>
        <button class="btn floor-btn" data-cancel ${wait}>Back</button>
      </div>`;
  }
  const mine = item.assigneeId !== null && item.assigneeId === ctx.ontology.userId;
  const take =
    item.status === 'raised' && !item.assignee
      ? `<button class="btn primary floor-btn" data-take="${esc(item.id)}" aria-label="${esc(label("I'm on it"))}" ${wait}>I'm on it</button>`
      : mine
        ? ''
        : item.assignee
          ? `<button class="btn floor-btn" data-ask-take="${esc(item.id)}" aria-label="${esc(label('Take it'))}" ${wait}>Take it</button>`
          : `<button class="btn floor-btn" data-take="${esc(item.id)}" aria-label="${esc(label('Take it'))}" ${wait}>Take it</button>`;
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

function board(graph: Graph, list: FloorItem[]): string {
  const tiles = machineBoard(graph, list);
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
  const w = warningById(id);
  if (!ctx.api || !site || !w || busy) return;
  busy = id;
  ctx.rerender();
  try {
    if (w.status === 'raised') await ctx.api.warnings.acknowledge(site, id);
    const me = ctx.ontology.userId;
    if (me && w.assignee_id !== me) await ctx.api.warnings.assign(site, id, me);
    uiState(ctx).taking = null;
    // Without your user id (not known yet) it can only be acknowledged: say so.
    ctx.toast(me ? `It's yours: ${w.signal_tag}` : `Acknowledged: ${w.signal_tag}`);
  } catch {
    // The client showed why; the list shows the warning as it is now.
  } finally {
    busy = null;
  }
  await fetchWarnings(ctx, true);
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
  await fetchWarnings(ctx, true);
}

const view: View = {
  id: 'shopfloor',
  title: 'Shopfloor',
  icon: 'hard-hat',
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
      return `<div class="floor">${head('<h1>Shopfloor</h1>')}${apiUnreachable(ctx.ontology.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn), size: 'lg' })}</div>`;
    const graph = ctx.graph; // made afresh at each read: once for the whole page
    const list = floorItems(ctx, graph);
    if (list === null)
      return `<div class="floor">${head('<h1>Shopfloor</h1>')}<div class="card">${skeleton.list(3, 'Loading the warnings…')}</div></div>`;
    const now = Date.now();
    const { tone, text } = headline(list);
    const updated =
      listed().at && ctx.api
        ? `<div class="small soft" data-floor-updated>${
            listed().stale
              ? `As of ${new Date(listed().at ?? 0).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}: the last refresh failed, trying again in 30 seconds`
              : `Updated ${new Date(listed().at ?? 0).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}; refreshes every 30 seconds`
          }</div>`
        : ctx.api
          ? ''
          : '<div class="small soft">Demo data from this browser’s plunger-friction detector</div>';
    shownHeadline = { site: siteId(ctx), text };
    const status = `<h1 class="floor-headline ${tone}">${esc(text)}</h1>${updated}`;
    const open = list.filter((i) => i.state !== 'ok');
    // A question about a warning that has left the floor (someone else resolved it) is dropped.
    if (ui.resolving && !open.some((i) => i.id === ui.resolving)) ui.resolving = null;
    if (ui.taking && !open.some((i) => i.id === ui.taking)) ui.taking = null;
    const more = listed().more
      ? `<p class="small soft">Showing the ${PAGE} newest open warnings; the Warnings page has the rest.</p>`
      : '';
    const cards = open.length
      ? `<div class="floor-cards">${open.map((i) => card(ctx, i, ui, now)).join('')}</div>${more}`
      : '';
    return `<div class="floor">${head(status)}${cards}
        <h2 class="floor-section">Machines</h2>${board(graph, list)}</div>`;
  },
  bind(root, ctx) {
    const ui = uiState(ctx);
    document.body.classList.toggle('floor-full', ui.full);
    // The first headline is the page's heading, read as the page opens; later ones are news.
    if (shownHeadline && shownHeadline.text !== toldHeadline?.text) {
      if (toldHeadline && toldHeadline.site === shownHeadline.site) announce(shownHeadline.text);
      toldHeadline = shownHeadline;
    }
    onAll(root, '[data-floor-full]', 'click', () => {
      ui.full = !ui.full;
      ctx.rerender();
    });
    if (!ctx.api) return;
    if (ctx.ontology.status !== 'ready') return;
    ensureFloor(ctx);
    // Polls while the page is shown. An open question survives the refresh (it is UI state), unless
    // its warning has gone.
    timer ??= setInterval(() => {
      if (routeOf(location.hash) !== 'shopfloor') return stop();
      if (!busy && !document.hidden) void fetchWarnings(ctx, true);
    }, REFRESH_MS);

    onAll(root, '[data-floor-refresh]', 'click', () => refreshFloor(ctx));
    onAll(root, '[data-take]', 'click', (el) => void take(ctx, el.dataset.take ?? ''));
    onAll(root, '[data-ask-take]', 'click', (el) => {
      Object.assign(ui, { taking: el.dataset.askTake ?? null, resolving: null });
      ctx.rerender();
    });
    onAll(root, '[data-resolve]', 'click', (el) => {
      Object.assign(ui, { resolving: el.dataset.resolve ?? null, taking: null });
      ctx.rerender();
    });
    onAll(root, '[data-cancel]', 'click', () => {
      Object.assign(ui, { resolving: null, taking: null });
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
