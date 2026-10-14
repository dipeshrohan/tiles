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
  reviews: { list: ReviewSummary[]; waiting: number | null }; // the menu's exact count, when it answers
  insights: InsightSummary[];
  signals: SignalInfo[];
  links: SignalInfo[]; // every linked signal: they place warnings on machines
  agents: EdgeAgent[];
  quality: SignalInfo[];
}

// Lists are fetched a page at a time; a full page means there may be more (the cards say so).
export const WARNINGS_PAGE = 200;
export const SIGNALS_PAGE = 500;
const REVIEWS_PAGE = 200;
const MAX_LINKS = 10_000;

type Slot<N extends Need> = { value: NeedData[N] | null; failed: boolean };

let data: { site: string; slots: { [N in Need]?: Slot<N> }; asked: Set<Need> } | null = null;
// `cards`: null for the role's; `loaded`: answered (or failed: the role's are shown).
let layout: { site: string; cards: CardId[] | null; loaded: boolean } | null = null;
let confirmed: CardId[] | null = null; // the cards the API last kept (or gave)
let edits = 0; // changes made here: an answer from before one is stale
let saving: Promise<unknown> = Promise.resolve(); // changes are sent one after another, in order
let fresh = true; // a new visit: fetch again
let seq = 0;

onNavigate((hash) => {
  if (routeOf(hash) !== 'home') fresh = true;
});

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;

async function allLinks(ctx: Context, site: string): Promise<SignalInfo[]> {
  const out: SignalInfo[] = [];
  for (let offset = 0; offset < MAX_LINKS; offset += SIGNALS_PAGE) {
    const page = await ctx.api!.signals.list(site, { linked: 'yes', limit: SIGNALS_PAGE, offset });
    out.push(...page.signals);
    if (page.signals.length < SIGNALS_PAGE || offset + SIGNALS_PAGE >= page.total) break;
  }
  return out;
}

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
      return Promise.all([
        api.reviews.list(site, 'open', { limit: REVIEWS_PAGE }),
        api.menu.counts(site).then(
          (c) => c.reviews_waiting,
          () => null,
        ),
      ]).then(([list, waiting]) => ({ list, waiting }));
    case 'insights':
      // The newest by number, then the card sorts by last change: twenty to choose five from.
      return api.insights.list(site, { limit: 20 }).then((r) => r.insights);
    case 'signals':
      return api.signals.list(site, { limit: SIGNALS_PAGE }).then((r) => r.signals);
    case 'links':
      return allLinks(ctx, site);
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

// Asks for the cards kept (once a visit); the page waits for them before fetching what cards need.
export function ensureLayout(ctx: Context): void {
  const site = siteId(ctx);
  if (!ctx.api || !site || ctx.ontology.status !== 'ready') return;
  if (!fresh && data?.site === site) return;
  fresh = false;
  ++seq;
  data = { site, slots: data?.site === site ? data.slots : {}, asked: new Set() };
  if (layout?.site !== site) layout = { site, cards: null, loaded: false };
  const mine = seq;
  const before = edits;
  ctx.api.home.get(site).then(
    (r) => {
      // A change made here since it was asked for wins (its PUT is on its way, or done).
      if (mine !== seq || before !== edits) return;
      confirmed = cleanCards(r.cards);
      layout = { site, cards: confirmed, loaded: true };
      if (shown()) ctx.rerender();
    },
    () => {
      if (mine !== seq || before !== edits) return;
      layout = { site, cards: layout?.site === site ? layout.cards : null, loaded: true };
      if (shown()) ctx.rerender();
    },
  );
}

// Fetches what Home's cards need and haven't this visit.
export function ensureNeeds(ctx: Context, needs: readonly Need[]): void {
  const site = siteId(ctx);
  const current = data;
  if (!ctx.api || !site || !current || current.site !== site) return;
  for (const need of needs) {
    if (current.asked.has(need)) continue;
    current.asked.add(need);
    const mine = seq;
    fetcher(ctx, site, need).then(
      (value) => {
        if (mine !== seq || data !== current) return;
        (current.slots as Record<Need, Slot<Need>>)[need] = { value, failed: false };
        if (shown()) ctx.rerender();
      },
      () => {
        if (mine !== seq || data !== current) return;
        const before = current.slots[need];
        // Shown before (an earlier visit): keep it; else say it failed.
        (current.slots as Record<Need, Slot<Need>>)[need] = before?.value ? before : { value: null, failed: true };
        if (shown()) ctx.rerender();
      },
    );
  }
}

// Keeps the cards chosen: shown at once, sent after any change still on its way. A refusal puts
// back the cards the API last kept, unless a later change has been made since.
export function keepCards(ctx: Context, cards: CardId[] | null): Promise<boolean> {
  const site = siteId(ctx);
  const api = ctx.api;
  if (!api || !site) return Promise.resolve(false);
  const mine = ++edits;
  layout = { site, cards, loaded: true };
  ctx.rerender();
  const sent = saving.then<unknown>(() => (cards === null ? api.home.reset(site) : api.home.set(site, cards)));
  saving = sent.catch(() => undefined);
  return sent.then(
    () => {
      confirmed = cards;
      return true;
    },
    () => {
      if (mine === edits && layout?.site === site) {
        layout = { site, cards: confirmed, loaded: true };
        ctx.rerender();
      }
      return false;
    },
  );
}
