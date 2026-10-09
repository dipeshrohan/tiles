import { fmt, onNavigate, routeOf } from '../lib/dom.ts';
import type { SignalInfo, WarningInfo } from '../lib/api.ts';
import { floorOrder, machineOf, pathOf, placeWarning, type FloorItem, type FloorState } from '../lib/shopfloor.ts';
import { howFar } from '../lib/warnings.ts';
import type { Graph } from '../lib/types.ts';
import type { Context } from './types.ts';

// What the Shopfloor (T5.16) and Plant (T5.17) pages share: the site's open warnings and its
// signal catalogue's linked tags (which place warnings on machines, and give a machine's signals
// their latest readings). Fetched when one of the two pages shows; dropped when you leave them,
// so each visit fetches afresh (others work the warnings meanwhile).

export const PAGE = 100; // the newest open warnings shown
const LINKS_PAGE = 500;
const MAX_LINKS = 10_000; // a site's linked tags fetched; beyond, warnings are placed by their tags

const ROUTES = new Set(['shopfloor', 'plant']);

let listing: { site: string; items: WarningInfo[] | null; at: number | null; more: boolean } | null = null;
let catalogue: { site: string; signals: SignalInfo[] | null } | null = null;
let listSeq = 0;
let catalogueSeq = 0;

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;
const shown = (): boolean => ROUTES.has(routeOf(location.hash));

onNavigate((hash) => {
  if (ROUTES.has(routeOf(hash))) return;
  listing = null;
  catalogue = null;
  ++listSeq; // an answer still on its way is for the visit that has ended
  ++catalogueSeq;
});

// When the open warnings were last fetched, and whether more than a page of them are open.
export const listed = (): { at: number | null; more: boolean } => ({
  at: listing?.at ?? null,
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
    if (seq === listSeq && !quiet) listing = { site, items: [], at: null, more: false };
  }
  if (seq === listSeq && shown()) ctx.rerender();
}

// Every linked signal of the site, a page at a time.
export async function fetchCatalogue(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const seq = ++catalogueSeq;
  if (catalogue?.site !== site) catalogue = { site, signals: null };
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
  catalogue = { site, signals };
  if (shown()) ctx.rerender();
}

// Starts the fetches this site hasn't had yet (bind calls it on every render).
export function ensureFloor(ctx: Context): void {
  if (!ctx.api || ctx.ontology.status !== 'ready') return;
  const site = siteId(ctx);
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
  return new Map(linkedSignals(ctx).flatMap((s) => (s.node_id ? [[s.tag, s.node_id] as const] : [])));
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
  const map = links(ctx);
  return listing.items.map((w) => placeWarning(graph, w, map, howFar(w))).sort(floorOrder);
}

export const STATE_LABEL: Record<FloorState, [cls: string, label: string]> = {
  out: ['bad', 'Signal still out'],
  new: ['bad', 'Nobody has it'],
  taken: ['warn', 'Being handled'],
  ok: ['good', 'OK'],
};
