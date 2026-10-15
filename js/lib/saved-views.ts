// Saved views and the filter bar's logic (U5.06), apart from the page: each page's filters (the
// params of its address, U3.05) with their names and values' words, the chips for those set, the
// part a saved view keeps, and the address that opens one. Pure, so it is unit-tested.

import { SHOW_LABELS } from './warnings.ts';
import { t, type MessageKey } from './i18n.ts';
import type { SavedView, SavedViewTable, ViewPage } from './api.ts';
import type { TablePrefs } from './data-table.ts';

export interface FilterDef {
  param: string; // in the page's address
  label: string; // "Status"
  values: Readonly<Record<string, string>> | null; // each value's words; null: free text (a search)
  fallback: string; // no filter: what the page shows then
}

export const VIEW_PAGES: readonly ViewPage[] = ['warnings', 'signals', 'documents'];

// Words read when shown (the language can change after load): a value's words, and a filter's.
function words<K extends string>(keys: Readonly<Record<K, MessageKey>>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const [value, key] of Object.entries(keys) as [K, MessageKey][])
    Object.defineProperty(out, value, { get: () => t(key), enumerable: true });
  return out;
}
const filter = (
  param: string,
  label: MessageKey,
  values: Readonly<Record<string, string>> | null,
  fallback: string,
): FilterDef => ({
  param,
  get label() {
    return t(label);
  },
  values,
  fallback,
});

export const FILTERS: Readonly<Record<ViewPage, readonly FilterDef[]>> = {
  warnings: [
    filter('show', 'warnings.filter.status', SHOW_LABELS, 'unresolved'),
    filter(
      'who',
      'warnings.filter.assignedTo',
      words({ anyone: 'warnings.filter.anyone', me: 'warnings.filter.me', none: 'warnings.filter.nobody' }),
      'anyone',
    ),
    filter(
      'signal',
      'warnings.filter.signal',
      words({ all: 'warnings.filter.outOrBack', open: 'warnings.stillOut', ended: 'warnings.filter.backIn' }),
      'all',
    ),
  ],
  signals: [
    filter('q', 'signals.filter.search', null, ''),
    filter(
      'source',
      'signals.filter.source',
      words({
        '': 'signals.filter.any',
        edge: 'signals.filter.edge',
        import: 'signals.filter.imports',
        manual: 'signals.source.manual',
      }),
      '',
    ),
    filter(
      'linked',
      'signals.filter.link',
      words({ '': 'signals.filter.any', yes: 'signals.filter.linked', no: 'signals.filter.notLinked' }),
      '',
    ),
    filter(
      'quality',
      'signals.filter.quality',
      words({
        '': 'signals.filter.any',
        bad: 'signals.quality.bad',
        warn: 'signals.quality.warn',
        good: 'signals.quality.good',
        unknown: 'signals.quality.unknown',
        unchecked: 'signals.quality.unchecked',
      }),
      '',
    ),
  ],
  documents: [filter('q', 'documents.search', null, '')],
};

export type Filters = Record<string, string>;

// The page's filters from a query (its address's, or a saved view's): every one, unknown values
// and params dropped, the missing ones at their fallback.
export function filtersOf(page: ViewPage, query: Readonly<Record<string, string | null | undefined>>): Filters {
  const out: Filters = {};
  for (const f of FILTERS[page]) {
    const v = query[f.param];
    out[f.param] =
      typeof v === 'string' && (f.values ? Object.hasOwn(f.values, v) : true) ? v.slice(0, 200) : f.fallback;
  }
  return out;
}

// What a saved view keeps: only the filters set (a fallback is left out).
export function viewQuery(page: ViewPage, filters: Filters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FILTERS[page]) {
    const v = filters[f.param] ?? f.fallback;
    if (v !== f.fallback) out[f.param] = v;
  }
  return out;
}

export interface Chip {
  param: string;
  text: string; // "Status: New"
}

// A chip for each filter set, in the page's order.
export function chips(page: ViewPage, filters: Filters): Chip[] {
  return FILTERS[page].flatMap((f) => {
    const v = filters[f.param] ?? f.fallback;
    if (v === f.fallback) return [];
    return [{ param: f.param, text: `${f.label}: ${f.values ? (f.values[v] ?? v) : `“${v}”`}` }];
  });
}

// The filters not set: what "Add filter" offers.
export const unset = (page: ViewPage, filters: Filters): FilterDef[] =>
  FILTERS[page].filter((f) => (filters[f.param] ?? f.fallback) === f.fallback);

// The address that opens a view: every filter of its page written out, so the page sets each one
// (one left out would keep what the page showed before).
export function viewHref(view: Pick<SavedView, 'page' | 'query'>): string {
  const filters = filtersOf(view.page, view.query);
  const params = new URLSearchParams(FILTERS[view.page].map((f) => [f.param, filters[f.param] ?? f.fallback]));
  return `#/${view.page}?${params}`;
}

export function sameFilters(page: ViewPage, a: Filters, b: Filters): boolean {
  return FILTERS[page].every((f) => (a[f.param] ?? f.fallback) === (b[f.param] ?? f.fallback));
}

// Compared by content: the API gives JSON back with its keys in another order.
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// The view shown now: the first whose filters (and table settings, when it keeps them) are the page's.
export function currentView(
  views: readonly SavedView[],
  page: ViewPage,
  filters: Filters,
  table: SavedViewTable | null,
): SavedView | null {
  return (
    views.find(
      (v) =>
        v.page === page &&
        sameFilters(page, filtersOf(page, v.query), filters) &&
        (!v.table || !table || sameJson(v.table, table)),
    ) ?? null
  );
}

// A table's settings as a view keeps them (its column widths are the browser's own).
export const viewTable = (prefs: TablePrefs): SavedViewTable => ({
  sort: prefs.sort,
  hidden: [...prefs.hidden],
  density: prefs.density,
});

// The menu's saved views (U5.06): yours, then those shared with you, by page; at most `max`.
export function menuViews(views: readonly SavedView[], max = 8): SavedView[] {
  const order = (v: SavedView) => VIEW_PAGES.indexOf(v.page);
  return [...views]
    .sort((a, b) => Number(b.mine) - Number(a.mine) || order(a) - order(b) || a.name.localeCompare(b.name))
    .slice(0, max);
}
