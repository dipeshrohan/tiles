// Home's data with the Tiles API (U5.01): the cards you keep, and what they read (open warnings,
// reviews, signals, agents…), fetched when Home shows and only for the cards on it; afresh on each
// visit, the last shown meanwhile.
import { onNavigate, routeOf } from '../lib/dom.ts';
import type { EdgeAgent, InsightSummary, ReviewSummary, SignalInfo, WarningInfo } from '../lib/api.ts';
import { cleanCards, type CardId, type Need } from '../lib/home-cards.ts';
import type { Context } from './types.ts';

export interface NeedData {
  'my-warnings': WarningInfo[];
  'open-warnings': WarningInfo[];
  'recent-warnings': WarningInfo[];
  reviews: ReviewSummary[];
  insights: InsightSummary[];
  signals: SignalInfo[];
  agents: EdgeAgent[];
  quality: SignalInfo[];
}

export const WARNINGS_PAGE = 100;
export const SIGNALS_PAGE = 500;

type Slot<N extends Need> = { value: NeedData[N] | null; failed: boolean; at: number | null };

let data: { site: string; slots: { [N in Need]?: Slot<N> }; asked: Set<Need> } | null = null;
// `cards`: null for the role's; `loaded`: answered (or failed: the role's are shown).
let layout: { site: string; cards: CardId[] | null; loaded: boolean } | null = null;
let fresh = true; // a new visit: fetch again
let seq = 0;

onNavigate((hash) => {
  if (routeOf(hash) !== 'home') fresh = true;
});

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;

function fetcher(ctx: Context, site: string, need: Need): Promise<NeedData[Need]> {
  const api = ctx.api!;
  switch (need) {
    case 'my-warnings':
      return api.warnings.list(site, { status: 'unresolved', assignee: 'me', limit: WARNINGS_PAGE });
    case 'open-warnings':
      return api.warnings.list(site, { status: 'unresolved', limit: WARNINGS_PAGE });
    case 'recent-warnings':
      return api.warnings.list(site, { status: 'all', limit: WARNINGS_PAGE });
    case 'reviews':
      return api.reviews.list(site, 'open');
    case 'insights':
      return api.insights.list(site, { limit: 5 }).then((r) => r.insights);
    case 'signals':
      return api.signals.list(site, { limit: SIGNALS_PAGE }).then((r) => r.signals);
    case 'agents':
      return api.agents.list(site);
    case 'quality':
      return Promise.all([
        api.signals.list(site, { quality: 'bad', limit: 50 }),
        api.signals.list(site, { quality: 'warn', limit: 50 }),
      ]).then(([bad, warn]) => [...bad.signals, ...warn.signals]);
  }
}

// What a card's need holds: its value, or null while it loads; `failed` when it couldn't be had.
export function slot<N extends Need>(ctx: Context, need: N): { value: NeedData[N] | null; failed: boolean } {
  const s = data?.site === siteId(ctx) ? (data.slots[need] as Slot<N> | undefined) : undefined;
  return { value: s?.value ?? null, failed: s?.failed ?? false };
}

export function homeLayout(ctx: Context): { cards: CardId[] | null; loaded: boolean } {
  const site = siteId(ctx);
  return layout?.site === site ? layout : { cards: null, loaded: false };
}

const shown = (): boolean => routeOf(location.hash) === 'home';

// Fetches what Home's cards need and haven't this visit (and the layout, once a visit).
export function ensureHome(ctx: Context, needs: readonly Need[]): void {
  const site = siteId(ctx);
  if (!ctx.api || !site || ctx.ontology.status !== 'ready') return;
  if (fresh || data?.site !== site) {
    fresh = false;
    ++seq;
    data = { site, slots: data?.site === site ? data.slots : {}, asked: new Set() };
    if (layout?.site !== site) layout = { site, cards: null, loaded: false };
    const mine = seq;
    ctx.api.home.get(site).then(
      (r) => {
        if (mine !== seq) return;
        layout = { site, cards: cleanCards(r.cards), loaded: true };
        if (shown()) ctx.rerender();
      },
      () => {
        if (mine !== seq) return;
        layout = { site, cards: layout?.site === site ? layout.cards : null, loaded: true };
        if (shown()) ctx.rerender();
      },
    );
  }
  const current = data;
  if (!current) return;
  for (const need of needs) {
    if (current.asked.has(need)) continue;
    current.asked.add(need);
    const mine = seq;
    fetcher(ctx, site, need).then(
      (value) => {
        if (mine !== seq || data !== current) return;
        (current.slots as Record<Need, Slot<Need>>)[need] = { value, failed: false, at: Date.now() };
        if (shown()) ctx.rerender();
      },
      () => {
        if (mine !== seq || data !== current) return;
        const before = current.slots[need];
        // Shown before (an earlier visit): keep it; else say it failed.
        (current.slots as Record<Need, Slot<Need>>)[need] = before?.value
          ? before
          : { value: null, failed: true, at: null };
        if (shown()) ctx.rerender();
      },
    );
  }
}

// Keeps the cards chosen (the page shows them at once; the API keeps them). Resolves to whether
// the API took them; on a refusal they are put back.
export async function keepCards(ctx: Context, cards: CardId[] | null): Promise<boolean> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return false;
  const before = homeLayout(ctx).cards;
  layout = { site, cards, loaded: true };
  ctx.rerender();
  try {
    if (cards === null) await ctx.api.home.reset(site);
    else await ctx.api.home.set(site, cards);
    return true;
  } catch {
    if (layout?.site === site) layout = { site, cards: before, loaded: true };
    ctx.rerender();
    return false;
  }
}
