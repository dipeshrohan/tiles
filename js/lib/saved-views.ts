// Saved views and the filter bar's logic (U5.06), apart from the page: each page's filters (the
// params of its address, U3.05) with their names and values' words, the chips for those set, the
// part a saved view keeps, and the address that opens one. Pure, so it is unit-tested.

import { SHOW_LABELS } from './warnings.ts';
import type { SavedView, SavedViewTable, ViewPage } from './api.ts';
import type { TablePrefs } from './data-table.ts';

export interface FilterDef {
  param: string; // in the page's address
  label: string; // "Status"
  values: Readonly<Record<string, string>> | null; // each value's words; null: free text (a search)
  fallback: string; // no filter: what the page shows then
}

export const VIEW_PAGES: readonly ViewPage[] = ['warnings', 'signals', 'documents'];

export const FILTERS: Readonly<Record<ViewPage, readonly FilterDef[]>> = {
  warnings: [
    { param: 'show', label: 'Status', values: SHOW_LABELS, fallback: 'unresolved' },
    { param: 'who', label: 'Assigned to', values: { anyone: 'anyone', me: 'me', none: 'nobody' }, fallback: 'anyone' },
    {
      param: 'signal',
      label: 'Signal',
      values: { all: 'out or back', open: 'still out', ended: 'back in' },
      fallback: 'all',
    },
  ],
  signals: [
    { param: 'q', label: 'Search', values: null, fallback: '' },
    {
      param: 'source',
      label: 'Source',
      values: { '': 'Any', edge: 'Edge agents', import: 'Imports', manual: 'Entered by hand' },
      fallback: '',
    },
    { param: 'linked', label: 'Ontology link', values: { '': 'Any', yes: 'Linked', no: 'Not linked' }, fallback: '' },
    {
      param: 'quality',
      label: 'Quality',
      values: {
        '': 'Any',
        bad: 'Problems',
        warn: 'Warnings',
        good: 'Good',
        unknown: 'No data',
        unchecked: 'Not checked',
      },
      fallback: '',
    },
  ],
  documents: [{ param: 'q', label: 'Search', values: null, fallback: '' }],
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
        (!v.table || !table || JSON.stringify(v.table) === JSON.stringify(table)),
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
