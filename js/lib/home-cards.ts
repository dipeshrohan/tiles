// Home by role (U5.01): with the Tiles API, Home is a set of cards, each answering "what needs me
// now?" for part of someone's work. Each role starts with its own (the welcome's role, U4.06, or
// else the site role); people add, remove and order them, kept with them by the API
// (`/sites/{id}/me/home`). This is the cards' logic, apart from the page: which there are, each
// role's, and what each makes of the site's data. Words follow docs/ui/writing.md.
import type { EdgeAgent, InsightSummary, ReviewSummary, SignalInfo, WarningInfo } from './api.ts';
import type { MachineTile } from './shopfloor.ts';
import { t, type MessageKey } from './i18n.ts';
import { zonedParts, zonedTime } from './format.ts';

export type CardId =
  'my-warnings' | 'machines-out' | 'shift' | 'reviews' | 'insights' | 'freshness' | 'agents' | 'quality';

// What a card reads from the API: Home fetches what its cards need, nothing more.
export type Need =
  | 'my-warnings'
  | 'open-warnings'
  | 'recent-warnings'
  | 'reviews'
  | 'insights'
  | 'signals'
  | 'links'
  | 'agents'
  | 'quality';

export interface CardDef {
  id: CardId;
  title: string;
  summary: string; // in the list of cards to add
  needs: readonly Need[];
}

// A card's words are read when shown (the language can change after load).
const card = (id: CardId, title: MessageKey, summary: MessageKey, needs: readonly Need[]): CardDef => ({
  id,
  get title() {
    return t(title);
  },
  get summary() {
    return t(summary);
  },
  needs,
});

export const CARDS: readonly CardDef[] = [
  card('my-warnings', 'homeCards.myWarnings.title', 'homeCards.myWarnings.summary', ['my-warnings']),
  card('machines-out', 'homeCards.machinesOut.title', 'homeCards.machinesOut.summary', ['open-warnings', 'links']),
  card('shift', 'homeCards.shift.title', 'homeCards.shift.summary', ['recent-warnings']),
  card('reviews', 'homeCards.reviews.title', 'homeCards.reviews.summary', ['reviews']),
  card('insights', 'homeCards.insights.title', 'homeCards.insights.summary', ['insights']),
  card('freshness', 'homeCards.freshness.title', 'homeCards.freshness.summary', ['signals']),
  card('agents', 'homeCards.agents.title', 'homeCards.agents.summary', ['agents']),
  card('quality', 'homeCards.quality.title', 'homeCards.quality.summary', ['quality']),
];

export const cardOf = (id: string): CardDef | undefined => CARDS.find((c) => c.id === id);

export type HomeRole = 'maintenance' | 'engineer' | 'shift-lead' | 'admin';

export const ROLE_CARDS: Readonly<Record<HomeRole, readonly CardId[]>> = {
  maintenance: ['my-warnings', 'machines-out'],
  engineer: ['reviews', 'insights', 'freshness'],
  'shift-lead': ['shift', 'machines-out', 'my-warnings'],
  admin: ['agents', 'quality', 'reviews'],
};

export const ROLE_LABELS: Readonly<Record<HomeRole, string>> = {
  get maintenance() {
    return t('homeCards.role.maintenance');
  },
  get engineer() {
    return t('homeCards.role.engineer');
  },
  get 'shift-lead'() {
    return t('homeCards.role.shiftLead');
  },
  get admin() {
    return t('homeCards.role.admin');
  },
};

// The role Home is set for: the one chosen in the welcome, else the site role's nearest.
export function homeRole(workRole: string | null, siteRole: 'viewer' | 'engineer' | 'admin' | null): HomeRole {
  if (workRole && Object.hasOwn(ROLE_CARDS, workRole)) return workRole as HomeRole;
  return siteRole === 'admin' ? 'admin' : siteRole === 'engineer' ? 'engineer' : 'maintenance';
}

// Cards as kept (by the API, or an older app): known ones only, each once, in their order.
export function cleanCards(value: unknown): CardId[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((id): id is CardId => typeof id === 'string' && cardOf(id) !== undefined))];
}

export function moveCard(cards: readonly CardId[], id: CardId, by: -1 | 1): CardId[] {
  const at = cards.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= cards.length) return [...cards];
  const out = [...cards];
  [out[at], out[to]] = [out[to]!, out[at]!];
  return out;
}

export const needsOf = (cards: readonly CardId[]): Need[] => [
  ...new Set(cards.flatMap((id) => cardOf(id)?.needs ?? [])),
];

// ---- what each card makes of the data ----

const unresolved = (w: WarningInfo): boolean => w.status !== 'resolved';

// Assigned to me and not resolved: still out first, then the newest.
export function myWarnings(warnings: readonly WarningInfo[], userId: string | null): WarningInfo[] {
  if (!userId) return [];
  return warnings
    .filter((w) => w.assignee_id === userId && unresolved(w))
    .sort(
      (a, b) => Number(a.ended_at !== null) - Number(b.ended_at !== null) || b.started_at.localeCompare(a.started_at),
    );
}

export const machinesOut = (tiles: readonly MachineTile[]): MachineTile[] => tiles.filter((t) => t.state === 'out');

// Shifts start at 06:00, 14:00 and 22:00 on the site's clock (format.ts, U6.02): the start of the
// one under way.
export function shiftStart(now: Date): Date {
  const p = zonedParts(now);
  const hour = p.hour >= 22 ? 22 : p.hour >= 14 ? 14 : p.hour >= 6 ? 6 : -2; // -2: 22:00 the day before
  return new Date(zonedTime(p.year, p.month, p.day, hour));
}

export interface ShiftSummary {
  raised: WarningInfo[]; // since the shift began, newest first
  acknowledged: number; // of those, acknowledged (or further)
  waiting: WarningInfo[]; // of those, nobody has acknowledged yet
}

export function shiftSummary(warnings: readonly WarningInfo[], start: Date): ShiftSummary {
  const since = start.getTime();
  const raised = warnings
    .filter((w) => Date.parse(w.started_at) >= since)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
  const waiting = raised.filter((w) => w.status === 'raised');
  return { raised, acknowledged: raised.length - waiting.length, waiting };
}

// Open change requests I may decide: not mine, and asked of me or of anyone.
export function reviewsForMe(reviews: readonly ReviewSummary[], userId: string | null): ReviewSummary[] {
  return reviews
    .filter(
      (r) => r.status === 'open' && r.author_id !== userId && (r.reviewer_id === null || r.reviewer_id === userId),
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at)); // waiting longest first
}

export const recentInsights = (insights: readonly InsightSummary[]): InsightSummary[] =>
  [...insights].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

// A signal is stale when nothing has arrived for 15 minutes, or for ten of its sample periods if
// that is longer (a slow signal isn't stale between readings). Event streams (downtime, scrap) are
// left out: they are quiet when all is well. Stalest first; never-heard ones last.
export const STALE_MS = 15 * 60_000;
export function staleSignals(signals: readonly SignalInfo[], now: number): SignalInfo[] {
  const ageOf = (s: SignalInfo) => (s.last_at ? now - Date.parse(s.last_at) : Infinity);
  return signals
    .filter((s) => !s.event_kind)
    .filter((s) => ageOf(s) > Math.max(STALE_MS, s.sample_rate_hz ? (10 / s.sample_rate_hz) * 1000 : 0))
    .sort((a, b) => {
      const x = ageOf(a);
      const y = ageOf(b);
      return x === y ? a.tag.localeCompare(b.tag) : x === Infinity ? 1 : y === Infinity ? -1 : y - x;
    });
}

// Agents that need someone: offline ones first, then those never seen.
export function agentProblems(agents: readonly EdgeAgent[]): EdgeAgent[] {
  const rank = { offline: 0, 'never seen': 1, online: 2 } as const;
  return agents
    .filter((a) => a.status !== 'online')
    .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}

// Signals whose last check found problems: bad ones first.
export type QualityProblem = SignalInfo & { quality: NonNullable<SignalInfo['quality']> & { badge: 'bad' | 'warn' } };
export function qualityProblems(signals: readonly SignalInfo[]): QualityProblem[] {
  const rank = { bad: 0, warn: 1 } as const;
  return signals
    .filter((s): s is QualityProblem => s.quality?.badge === 'bad' || s.quality?.badge === 'warn')
    .sort((a, b) => rank[a.quality.badge] - rank[b.quality.badge] || a.tag.localeCompare(b.tag));
}
