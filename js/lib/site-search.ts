// Site search (U4.01) in the command palette (U4.02): each record found, as an item that opens it
// on its page.

import type { SearchKind, SearchResult, SiteSearch } from './api.ts';
import type { IconName } from './icons.ts';
import type { PaletteItem } from './palette.ts';

const ICONS: Record<SearchKind, IconName> = {
  signal: 'activity',
  node: 'network',
  warning: 'triangle-alert',
  insight: 'lightbulb',
  document: 'file-text',
  app: 'layout-grid',
};

// Where a record opens: its page, with the record named in the address.
export function recordHref(r: Pick<SearchResult, 'kind' | 'id'>): string {
  const id = encodeURIComponent(r.id);
  switch (r.kind) {
    case 'signal':
      return `#/explorer?signal=${id}`;
    case 'node':
      return `#/ontology?node=${id}`;
    case 'warning':
      return `#/warnings?warning=${id}`; // opened whatever the filters show
    case 'insight':
      return `#/insights/${id}`;
    case 'document':
      return `#/documents/${id}`;
    case 'app':
      return `#/apps/${id}`;
  }
}

// What a result says beside its title: its detail, and the page a document's words are on.
export function resultHint(r: Pick<SearchResult, 'detail' | 'page'>): string | undefined {
  return [r.detail, r.page ? `page ${r.page}` : ''].filter(Boolean).join(' · ') || undefined;
}

// The groups found, as palette items under their group's name, in the order found.
export function searchItems(found: SiteSearch, open: (href: string) => void): PaletteItem[] {
  return found.groups.flatMap((g) =>
    g.results.map((r) => {
      const href = recordHref(r);
      return {
        id: `${r.kind}:${r.id}`,
        label: r.title,
        group: g.label,
        icon: ICONS[r.kind],
        hint: resultHint(r),
        href,
        run: () => open(href),
      };
    }),
  );
}
