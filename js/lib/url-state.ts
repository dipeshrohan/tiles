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

// One of a query's allowed values, or the fallback (a link's nonsense is left out).
export const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback;

// Shows `hash` in the address without a navigation (no hashchange, no history entry), keeping the
// entry's state. A browser that refuses (too many changes too fast) keeps the address it had.
export function showHash(hash: string): void {
  if (hash === location.hash) return;
  try {
    history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
  } catch {
    // the next change writes it
  }
}

// ---- scroll -------------------------------------------------------------------------------
// Each history entry has a key (in its state, given once); how far each was scrolled is noted as it
// is scrolled, in memory and in the tab's session storage, not in the history (no write per scroll).
// Back or forward to an entry scrolls there again, and keeps trying as the page grows (its data may
// come later) for a few seconds; a new entry starts at the top. Scrolling, a key or a touch first
// leaves the page where it is.

const RESTORE_FOR_MS = 3000;
const SCROLL_KEY = 'tiles:scroll';
let positions = new Map<string, number>();
let current = '';
let pending: { y: number; until: number } | null = null;
let growing: ResizeObserver | null = null;

function entryKey(): string {
  const state: unknown = history.state;
  const key = state && typeof state === 'object' ? (state as { key?: unknown }).key : undefined;
  if (typeof key === 'string') return key;
  const made = Math.random().toString(36).slice(2, 10);
  try {
    history.replaceState({ ...(state && typeof state === 'object' ? state : {}), key: made }, '');
  } catch {
    // no key: this entry starts at the top
  }
  return made;
}

export function watchScroll(): void {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const kept = session();
  try {
    const raw = kept?.getItem(SCROLL_KEY);
    if (raw) positions = new Map(Object.entries(JSON.parse(raw) as Record<string, number>));
  } catch {
    // none kept
  }
  current = entryKey();
  addEventListener(
    'scroll',
    () => {
      // The person's own scroll on the entry showing; not one being put back, nor one while leaving.
      if (!pending && current) positions.set(current, scrollY);
    },
    { passive: true },
  );
  const stop = () => settle();
  for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const)
    addEventListener(type, stop, { passive: true, capture: true });
  addEventListener('pagehide', () => {
    try {
      kept?.setItem(SCROLL_KEY, JSON.stringify(Object.fromEntries([...positions].slice(-50))));
    } catch {
      // not kept
    }
  });
}

// Leaving the entry showing: its place stays as noted (the new page, shorter, may clamp the scroll).
export function leaving(): void {
  settle();
  current = '';
}

// Where the entry now showing was scrolled to (0 for a new one).
export const savedScroll = (): number => positions.get(entryKey()) ?? 0;

// Arriving at an entry (a link, back or forward): the last one's place is already noted; this one
// scrolls to its own, now and as the page grows.
export function scrollToSaved(): void {
  settle();
  current = entryKey();
  const y = positions.get(current) ?? 0;
  scrollTo(0, y);
  if (y > 0 && Math.abs(scrollY - y) >= 2) {
    pending = { y, until: Date.now() + RESTORE_FOR_MS };
    if (typeof ResizeObserver === 'function') {
      growing = new ResizeObserver(() => restoreScroll());
      growing.observe(document.body);
    }
  }
}

// Tries again after a drawing (or the page growing); stops once there, or after a few seconds.
export function restoreScroll(): void {
  if (!pending) return;
  if (Date.now() > pending.until) return settle();
  scrollTo(0, pending.y);
  if (Math.abs(scrollY - pending.y) < 2) settle();
}

// Leaves the page where it is (arrived, given up, or the person took over).
export function settle(): void {
  pending = null;
  growing?.disconnect();
  growing = null;
}

// ---- the rest of a page's state -----------------------------------------------------------
// The pages' own state (ctx.ui: a tab chosen, a record open, a draft's text) is kept in this tab's
// session storage as the page is left, and read again by its next load: a reload keeps it. Never
// shared between tabs, gone when the tab closes, and dropped on signing out. Storage that can't be
// used keeps nothing.

const UI_KEY = 'tiles:ui';

// The tab's session storage, or null where it is blocked (reading it can throw).
export function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveUi(storage: Pick<Storage, 'setItem'> | null, ui: Record<string, object>): void {
  try {
    storage?.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    // full, or blocked: the next load starts afresh
  }
}

export function forgetUi(storage: Pick<Storage, 'removeItem'> | null): void {
  try {
    storage?.removeItem(UI_KEY);
  } catch {
    // nothing kept anyway
  }
}

export function loadUi(storage: Pick<Storage, 'getItem'> | null): Record<string, object> {
  try {
    const raw = storage?.getItem(UI_KEY);
    const ui: unknown = raw ? JSON.parse(raw) : null;
    if (!isPlain(ui)) return {};
    // Only pages' objects: anything else is left behind.
    return Object.fromEntries(Object.entries(ui).filter(([, v]) => isPlain(v))) as Record<string, object>;
  } catch {
    return {};
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// A page's kept state over its defaults: a field of another kind than its default (or one added
// since) comes from the defaults, nested objects field by field; fields the defaults don't name go.
export function mergeKept<T extends object>(defaults: T, kept: unknown): T {
  if (!isPlain(kept)) return { ...defaults };
  const out: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(defaults)) {
    const v = kept[k];
    if (isPlain(d)) out[k] = mergeKept(d, v);
    else if (d === null)
      out[k] = v === undefined ? null : v; // null: any kind (a selection, a range)
    else if (Array.isArray(d)) out[k] = Array.isArray(v) ? v : d;
    else out[k] = typeof v === typeof d ? v : d;
  }
  return out as T;
}
