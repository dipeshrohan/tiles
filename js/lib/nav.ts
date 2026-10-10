// The menu (U3.06): groups that fold away, pages pinned and the last ones visited, counts beside
// the pages that have something waiting, and an icon rail for wide data pages. What each person
// chose (folded groups, pins, the rail, recent pages) is kept per person in this browser.

import { esc } from './dom.ts';
import { icon, type IconName } from './icons.ts';

export interface NavPage {
  id: string;
  title: string;
  icon: IconName;
}

export interface NavGroup {
  id: string; // a key for folding ('' for the unnamed groups, which don't fold)
  title: string;
  pages: NavPage[];
}

export interface NavPrefs {
  folded: string[]; // groups folded away
  pinned: string[]; // pages pinned, in the order pinned
  recent: string[]; // pages visited, latest first
  rail: boolean; // the menu as a rail of icons
}

export const DEFAULT_PREFS: NavPrefs = { folded: [], pinned: [], recent: [], rail: false };
export const RECENT = 5;
export const MAX_PINNED = 8;

// A count beside a page: how many, and what they are ("3 open warnings").
export interface NavBadge {
  count: number;
  tone: '' | 'bad' | 'warn';
  says: string;
}

// The prefs kept, checked: what isn't a page now is left out.
export function cleanPrefs(raw: unknown, pages: readonly string[]): NavPrefs {
  const o = raw && typeof raw === 'object' ? (raw as Partial<Record<keyof NavPrefs, unknown>>) : {};
  const ids = (v: unknown, max: number) =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === 'string' && pages.includes(x)))].slice(0, max)
      : [];
  const groups = Array.isArray(o.folded) ? o.folded.filter((x): x is string => typeof x === 'string') : [];
  return { folded: groups, pinned: ids(o.pinned, MAX_PINNED), recent: ids(o.recent, RECENT), rail: o.rail === true };
}

// A page visited goes to the top of the recent pages (Home isn't one).
export function visited(prefs: NavPrefs, id: string): NavPrefs {
  if (id === 'home' || prefs.recent[0] === id) return prefs;
  return { ...prefs, recent: [id, ...prefs.recent.filter((r) => r !== id)].slice(0, RECENT) };
}

export function togglePin(prefs: NavPrefs, id: string): NavPrefs {
  const pinned = prefs.pinned.includes(id)
    ? prefs.pinned.filter((p) => p !== id)
    : [...prefs.pinned, id].slice(-MAX_PINNED);
  return { ...prefs, pinned };
}

export function toggleFold(prefs: NavPrefs, group: string): NavPrefs {
  const folded = prefs.folded.includes(group) ? prefs.folded.filter((g) => g !== group) : [...prefs.folded, group];
  return { ...prefs, folded };
}

const href = (id: string) => `#/${id === 'home' ? '' : id}`;

function badgeHtml(b: NavBadge | undefined): string {
  if (!b || b.count <= 0) return '';
  const shown = b.count > 99 ? '99+' : String(b.count);
  return `<span class="badge${b.tone ? ` ${b.tone}` : ''}" aria-hidden="true">${shown}</span><span class="sr-only">, ${esc(b.says)}</span>`;
}

// One page's row: its link (the current page marked), and a pin for it.
function row(p: NavPage, o: NavDraw, where: 'menu' | 'pinned' | 'recent'): string {
  const current = p.id === o.active;
  const pinned = o.prefs.pinned.includes(p.id);
  const marked = current || p.id === o.under;
  // The menu's own link is the one marked current (pinned and recent copies aren't a second "here").
  const aria = current && where === 'menu' ? ' aria-current="page"' : '';
  const tip = o.prefs.rail ? ` data-tooltip="${esc(p.title)}"` : '';
  const pin =
    where === 'recent'
      ? ''
      : `<button class="nav-pin" type="button" data-nav-pin="${esc(p.id)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(p.title)}">${icon(pinned ? 'pin-off' : 'pin', { size: 14 })}</button>`;
  return `<div class="nav-row" data-key="nav-${where}-${esc(p.id)}"><a class="nav-link${marked ? ' active' : ''}" href="${href(p.id)}"${aria}${tip}><span class="ico">${icon(p.icon)}</span><span class="nav-label">${esc(p.title)}</span>${badgeHtml(o.badges[p.id])}</a>${pin}</div>`;
}

export interface NavDraw {
  groups: NavGroup[];
  active: string; // the page shown
  under?: string; // the page it belongs to (the style guide: Settings)
  prefs: NavPrefs;
  badges: Record<string, NavBadge>;
}

// A section of the menu: its heading folds it (a named group), or just names it.
function section(id: string, title: string, rows: string, foldable: boolean, folded: boolean): string {
  if (!title) return `<div class="nav-section">${rows}</div>`;
  const list = `nav-list-${esc(id)}`;
  const head = foldable
    ? `<button class="nav-group" type="button" data-nav-fold="${esc(id)}" aria-expanded="${!folded}" aria-controls="${list}"><span class="nav-label">${esc(title)}</span>${icon('chevron-down', { size: 14 })}</button>`
    : `<div class="nav-group"><span class="nav-label">${esc(title)}</span></div>`;
  return `<div class="nav-section${folded ? ' folded' : ''}">${head}<div class="nav-list" id="${list}"${folded ? ' hidden' : ''}>${rows}</div></div>`;
}

export function navHtml(o: NavDraw): string {
  const all = o.groups.flatMap((g) => g.pages);
  const page = (id: string) => all.find((p) => p.id === id);
  const pinned = o.prefs.pinned.flatMap((id) => page(id) ?? []);
  const recent = o.prefs.recent
    .filter((id) => id !== o.active && !o.prefs.pinned.includes(id))
    .flatMap((id) => page(id) ?? []);
  const folded = (id: string) => o.prefs.folded.includes(id);
  const rail = `<button class="nav-rail-toggle" type="button" data-nav-rail aria-pressed="${o.prefs.rail}" aria-label="${o.prefs.rail ? 'Show the menu’s names' : 'Show the menu as icons'}" data-tooltip="${o.prefs.rail ? 'Show names' : 'Icons only'}">${icon(o.prefs.rail ? 'panel-left-open' : 'panel-left-close', { size: 16 })}</button>`;
  return [
    rail,
    pinned.length
      ? section('pinned', 'Pinned', pinned.map((p) => row(p, o, 'pinned')).join(''), true, folded('pinned'))
      : '',
    recent.length
      ? section('recent', 'Recent', recent.map((p) => row(p, o, 'recent')).join(''), true, folded('recent'))
      : '',
    ...o.groups.map((g) =>
      section(g.id, g.title, g.pages.map((p) => row(p, o, 'menu')).join(''), Boolean(g.title), folded(g.id)),
    ),
  ].join('');
}
