// Split view for records (U3.08): a list and the record open from it side by side on a wide screen,
// one at a time on a narrow one (the record, with a way back to the list); j and k move through the
// list (keyboard shortcuts, U4.03: not while typing, and not when turned off). Used by Warnings, Change reviews, Insights and Documents.

import { bound, esc, scrollBehavior } from './dom.ts';
import { icon } from './icons.ts';
import { forShortcut } from './shortcuts.ts';

export interface SplitOptions {
  open: boolean; // a record is open (on a narrow screen it takes the list's place)
  back: string; // the list's address, for the way back on a narrow screen
  label?: string; // what the list is ("warnings"), for the way back's words
}

// The list and the record pane. Each is given as built HTML (a card, usually).
export function split(listHtml: string, recordHtml: string, o: SplitOptions): string {
  const back = o.open
    ? `<a class="split-back" href="${esc(o.back)}">${icon('arrow-left', { size: 14 })}Back to the ${esc(o.label ?? 'list')}</a>`
    : '';
  return `<div class="split${o.open ? ' has-record' : ''}"><div class="split-list">${listHtml}</div><div class="split-record">${back}${recordHtml}</div></div>`;
}

// The record an address names after its page: #/reviews/12 → 12; null for the list alone.
export function recordFromHash(page: string, hash: string): number | null {
  const m = new RegExp(`^#/${page}/(\\d+)(?:[?/]|$)`, 'i').exec(hash);
  return m ? Number(m[1]) : null;
}

// What of a row takes a click and the focus: the row, when it is a link or a button, or its first link.
export function rowTarget(row: Element | null | undefined): HTMLElement | null {
  if (!row) return null;
  // A table's row (U5.02) opens its record with the button in its first cell.
  return row.matches('a[href], button')
    ? (row as HTMLElement)
    : row.querySelector<HTMLElement>('a[href], button.row-open');
}

// Whether a row is shown (a narrow screen hides the list while a record is open).
export const shown = (el: Element): boolean =>
  typeof el.checkVisibility === 'function' ? el.checkVisibility() : (el as HTMLElement).offsetParent !== null;

// The row j (+1) or k (-1) moves to, from the one open (-1 when none): the first on j, the last on
// k; null past either end.
export function nextRow(count: number, current: number, step: 1 | -1): number | null {
  if (count === 0) return null;
  if (current < 0) return step === 1 ? 0 : count - 1;
  const next = current + step;
  return next >= 0 && next < count ? next : null;
}

// j and k open the next and previous row of `rows` (in `root`); `isOpen` says which row is open now.
// A row is opened as a click on it would (a row that is a link or button), or on its first link.
// The row moved to takes the focus once the page has drawn it, scrolled into view.
export function listKeys(root: ParentNode, rows: string, isOpen: (row: Element) => boolean): void {
  document.addEventListener(
    'keydown',
    (e) => {
      if ((e.key !== 'j' && e.key !== 'k') || !forShortcut(e)) return;
      const all = [...root.querySelectorAll(rows)];
      const at = nextRow(
        all.length,
        all.findIndex((r) => isOpen(r)),
        e.key === 'j' ? 1 : -1,
      );
      const row = at === null ? null : all[at];
      if (!row) return;
      e.preventDefault();
      const key = row.getAttribute('data-key');
      rowTarget(row)?.click();
      // Drawn again (by the click or the address it set), the row is found again by its key.
      requestAnimationFrame(() => {
        const now = key ? document.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null;
        rowTarget(now)?.focus({ preventScroll: true });
        now?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
      });
    },
    { signal: bound() },
  );
}
