import { fmt, onNavigate, routeOf } from '../lib/dom.ts';
import type { SignalInfo, WarningInfo } from '../lib/api.ts';
import { floorOrder, machineOf, pathOf, placeWarning, type FloorItem, type FloorState } from '../lib/shopfloor.ts';
import { howFar } from '../lib/warnings.ts';
import type { Graph } from '../lib/types.ts';
import type { Context } from './types.ts';
import { t } from '../lib/i18n.ts';

// What the Shopfloor (T5.16) and Plant (T5.17) pages share: the site's open warnings and its
// signal catalogue's linked tags (which place warnings on machines, and give a machine's signals
// their latest readings). Fetched when one of the two pages shows, and afresh when you go from one
// to the other (others work the warnings meanwhile); dropped when you leave them.

export const PAGE = 100; // the newest open warnings shown
const LINKS_PAGE = 500;
const MAX_LINKS = 10_000; // a site's linked tags fetched; beyond, warnings are placed by their tags

const ROUTES = new Set(['shopfloor', 'plant']);

// `stale`: the last refresh failed, so the list is as of `at` (kept, rather than emptied).
let listing: { site: string; items: WarningInfo[] | null; at: number | null; more: boolean; stale?: boolean } | null =
  null;
// `links`: tag → Signal node, made once per fetch.
let catalogue: { site: string; signals: SignalInfo[] | null; links: Map<string, string> } | null = null;
let stale = false; // moved between the two pages: fetch again, showing the last meanwhile
let lastRoute = typeof location === 'undefined' ? '' : routeOf(location.hash);
let listSeq = 0;
let catalogueSeq = 0;

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;
const shown = (): boolean => ROUTES.has(routeOf(location.hash));

onNavigate((hash) => {
  const route = routeOf(hash);
  const from = lastRoute;
  lastRoute = route;
  if (ROUTES.has(route)) {
    if (from !== route) stale = true; // within a page (from place to place), what is shown stands
    return;
  }
  listing = null;
  catalogue = null;
  ++listSeq; // an answer still on its way is for the visit that has ended
  ++catalogueSeq;
});

// When the open warnings were last fetched, and whether more than a page of them are open.
export const listed = (): { at: number | null; more: boolean; stale: boolean } => ({
  at: listing?.at ?? null,
  stale: listing?.stale ?? false,
  more: listing?.more ?? false,
});

// The open warnings, newest first. A quiet refresh keeps what is shown until the answer comes.
export async function fetchWarnings(ctx: Context, quiet = false): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const seq = ++listSeq;
  if (!quiet || listing?.site !== site) listing = { site, items: null, at: null, more: false };
  try {
    const items = await ctx.api.warnings.list(site, { status: 'unresolved', limit: PAGE });
    if (seq === listSeq) listing = { site, items, at: Date.now(), more: items.length === PAGE };
  } catch {
    // The client showed why. A quiet refresh keeps the last list; otherwise nothing to show.
    // Nothing shown yet (a first load, or a quiet one for another site): show none, as a loud failure
    // does, rather than load for ever; otherwise keep the list, marked as stale.
    if (seq === listSeq && (!quiet || !listing?.items))
      listing = { site, items: [], at: null, more: false, stale: true };
    else if (seq === listSeq && listing) listing.stale = true;
  }
  if (seq === listSeq && shown()) ctx.rerender();
}

// Every linked signal of the site, a page at a time.
export async function fetchCatalogue(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const seq = ++catalogueSeq;
  if (catalogue?.site !== site) catalogue = { site, signals: null, links: new Map() };
  const signals: SignalInfo[] = [];
  try {
    for (let offset = 0; offset < MAX_LINKS; offset += LINKS_PAGE) {
      const page = await ctx.api.signals.list(site, { linked: 'yes', limit: LINKS_PAGE, offset });
      if (seq !== catalogueSeq) return;
      signals.push(...page.signals);
      if (page.signals.length < LINKS_PAGE || offset + LINKS_PAGE >= page.total) break;
    }
  } catch {
    if (seq !== catalogueSeq) return; // the client showed why; the pages fetched still serve
  }
  const links = new Map(signals.flatMap((s) => (s.node_id ? [[s.tag, s.node_id] as const] : [])));
  catalogue = { site, signals, links };
  if (shown()) ctx.rerender();
}

// Starts the fetches this site hasn't had yet (bind calls it on every render).
// Seen offline (U5.08): drawn again once the network is back (app.ts does), both are fetched afresh.
let offlineSeen = false;
export function ensureFloor(ctx: Context): void {
  if (!ctx.api || ctx.ontology.status !== 'ready') return;
  const site = siteId(ctx);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) offlineSeen = true;
  else if (offlineSeen) {
    offlineSeen = false;
    stale = true;
  }
  if (stale) {
    stale = false;
    if (listing?.site === site) void fetchWarnings(ctx, true);
    if (catalogue?.site === site) void fetchCatalogue(ctx);
  }
  if (listing?.site !== site) void fetchWarnings(ctx);
  if (catalogue?.site !== site) void fetchCatalogue(ctx);
}

// Fetches both again, keeping what is shown meanwhile.
export function refreshFloor(ctx: Context): void {
  void fetchWarnings(ctx, true);
  void fetchCatalogue(ctx);
}

// The catalogue's linked signals of this site (none until fetched, or in local mode).
export function linkedSignals(ctx: Context): SignalInfo[] {
  const site = siteId(ctx);
  return (catalogue?.site === site && catalogue.signals) || [];
}

// The tag-to-node links that place warnings.
function links(ctx: Context): Map<string, string> {
  return (catalogue?.site === siteId(ctx) && catalogue.links) || new Map();
}

// A warning by id, as the API last gave it.
export const warningById = (id: string): WarningInfo | undefined => listing?.items?.find((w) => w.id === id);

// The open warnings as the floor reads them, worst first: from the API, or the browser's demo
// detector in local mode. Null while loading.
export function floorItems(ctx: Context, graph: Graph): FloorItem[] | null {
  if (!ctx.api) {
    const model = Object.values(graph.nodes).find((n) => n.type === 'Model' && /friction/i.test(n.label));
    const machineId = model ? machineOf(graph, model.id) : null;
    const machine = machineId ? graph.nodes[machineId] : undefined;
    return ctx.state.detection.alerts.map((a, i) => ({
      id: `demo-${i}`,
      tag: t('floor.demoTag'),
      machineId,
      machine: machine?.label ?? t('floor.demoMachine'),
      path: machineId ? pathOf(graph, machineId) : [],
      state: 'new' as FloorState,
      status: 'raised' as const,
      out: false,
      startedAt: null,
      endedAt: null,
      assignee: null,
      assigneeId: null,
      detail: t('floor.demoDetail', { first: fmt(a.firstShot), last: fmt(a.lastShot), peak: fmt(a.peak, 2) }),
    }));
  }
  const site = siteId(ctx);
  if (!site || listing?.site !== site || listing.items === null) return null;
  const map = links(ctx);
  return listing.items.map((w) => placeWarning(graph, w, map, howFar(w))).sort(floorOrder);
}

// Getters, so a label is read in the current language.
export const STATE_LABEL: Readonly<Record<FloorState, [cls: string, label: string]>> = {
  get out(): [string, string] {
    return ['bad', t('floor.state.out')];
  },
  get new(): [string, string] {
    return ['bad', t('floor.state.new')];
  },
  get taken(): [string, string] {
    return ['warn', t('floor.state.taken')];
  },
  get ok(): [string, string] {
    return ['good', t('floor.state.ok')];
  },
};
