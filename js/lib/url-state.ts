// State in the address, and the scroll put back (U3.05). A page's filters, search, selected record
// and range are in its query (`#/warnings?show=all&warning=12`), so a link shares the view and a
// reload shows it again; the address is kept in step without a new history entry. Back and forward
// put the page back where it was scrolled to.

// The query of a hash: `#/warnings?show=all` → show=all.
export const queryOf = (hash: string): URLSearchParams => new URLSearchParams(hash.split('?')[1] ?? '');

// The hash with this query (values left out when empty): the path before it kept as it was.
export function withQuery(hash: string, values: Record<string, string | null | undefined>): string {
  const path = hash.split('?')[0] || '#/';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== null && v !== undefined && v !== '') params.set(k, v);
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

// Shows `hash` in the address without a navigation (no hashchange, no history entry), keeping the
// entry's saved scroll.
export function showHash(hash: string): void {
  if (hash === location.hash) return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
}

// ---- scroll -------------------------------------------------------------------------------
// Each history entry keeps how far the page was scrolled (in its state, as it is scrolled). Back or
// forward to it scrolls there again, once the page is tall enough (its data may come later); a new
// entry starts at the top. Scrolling, a key or a touch first leaves the page where it is.

const SAVE_MS = 150;
const RESTORE_FOR_MS = 3000;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pending: { y: number; until: number } | null = null;

export function watchScroll(): void {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  addEventListener(
    'scroll',
    () => {
      if (pending) return; // the page being put back, not the person scrolling
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const state: unknown = history.state;
        history.replaceState({ ...(state && typeof state === 'object' ? state : {}), scrollY: scrollY }, '');
      }, SAVE_MS);
    },
    { passive: true },
  );
  const stop = () => (pending = null);
  for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const)
    addEventListener(type, stop, { passive: true, capture: true });
}

// Where this history entry was scrolled to (0 for a new one).
export function savedScroll(): number {
  const state: unknown = history.state;
  const y = state && typeof state === 'object' ? (state as { scrollY?: unknown }).scrollY : undefined;
  return typeof y === 'number' && Number.isFinite(y) ? y : 0;
}

// Scrolls to this entry's place, and keeps trying as the page grows (restoreScroll after each drawing).
export function scrollToSaved(): void {
  const y = savedScroll();
  pending = y > 0 ? { y, until: Date.now() + RESTORE_FOR_MS } : null;
  scrollTo(0, y);
  restoreScroll();
}

export function restoreScroll(): void {
  if (!pending) return;
  if (Date.now() > pending.until) {
    pending = null;
    return;
  }
  scrollTo(0, pending.y);
  if (Math.abs(scrollY - pending.y) < 2) pending = null; // there
}

// ---- the rest of a page's state -----------------------------------------------------------
// The pages' own state (ctx.ui: a tab chosen, a record open, a draft's text) is kept in this tab's
// session storage as the page is left, and read again by its next load: a reload keeps it. Never
// shared between tabs, and gone when the tab closes. Storage that can't be used keeps nothing.

const UI_KEY = 'tiles.ui';

export function saveUi(storage: Pick<Storage, 'setItem'>, ui: Record<string, object>): void {
  try {
    storage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    // full, or blocked: the next load starts afresh
  }
}

export function loadUi(storage: Pick<Storage, 'getItem'>): Record<string, object> {
  try {
    const raw = storage.getItem(UI_KEY);
    const ui: unknown = raw ? JSON.parse(raw) : null;
    if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return {};
    // Only pages' objects: anything else is left behind.
    return Object.fromEntries(
      Object.entries(ui).filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v)),
    ) as Record<string, object>;
  } catch {
    return {};
  }
}
