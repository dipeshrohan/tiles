// The command palette (U4.02), after shadcn/ui's Command (cmdk): Ctrl/⌘ K, or "/" on a page without
// its own search (js/lib/shortcuts.ts), opens a search over pages and actions, and the site's records when there is an API (site search,
// U4.01). Arrow keys move, Enter runs, Escape closes; the last picks come first, records among them.
// An accessible combobox in a <dialog>.
import { ux, uxName } from './analytics.ts';
import { esc } from './dom.ts';
import { icon, isIconName, type IconName } from './icons.ts';
import { load, save } from './store.ts';

export interface PaletteItem {
  id: string;
  label: string;
  group: string;
  icon: IconName;
  hint?: string;
  keywords?: string;
  href?: string; // a record's address: kept among the recent picks, and opened from there
  late?: boolean; // reading (the guide's headings): after everything else matched, the best few only
  run(): void;
}

// How many of the late items a query shows.
export const LATE_SHOWN = 5;

export interface PaletteSource {
  items(): PaletteItem[];
  // More results for a query (the site's signals), when canSearch() says there is something to ask.
  search?(q: string): Promise<PaletteItem[]>;
  canSearch?(): boolean;
  // Items made of what is typed ("Ask the copilot …"), after the matches.
  typed?(q: string): PaletteItem[];
  // Where records come from (the API and site): a record picked comes back among the recent picks
  // there only.
  scope?(): string;
}

// How well an item matches: the label starting with the query, then a word of it, then anywhere,
// then the letters in order (fuzzy, in the label only); keywords count a little less. 0: no match.
export function score(item: Pick<PaletteItem, 'label' | 'keywords'>, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const test = (text: string, weight: number, fuzzy: boolean): number => {
    const t = text.toLowerCase();
    if (t.startsWith(q)) return 100 * weight;
    if (t.split(/[\s·/,.-]+/).some((w) => w.startsWith(q))) return 80 * weight;
    if (t.includes(q)) return 60 * weight;
    if (!fuzzy) return 0;
    let i = 0;
    for (const c of t) if (c === q[i]) i++;
    return i === q.length ? 20 * weight : 0;
  };
  // Letters in order only count in the label: across a list of keywords they match almost anything.
  return Math.max(test(item.label, 1, true), item.keywords ? test(item.keywords, 0.9, false) : 0);
}

export function rank<T extends Pick<PaletteItem, 'label' | 'keywords'>>(items: T[], query: string): T[] {
  return items
    .map((item, i) => ({ item, i, s: score(item, query) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.item);
}

// Keeps each group together, the groups in the order of their best match.
export function grouped<T extends Pick<PaletteItem, 'group'>>(items: T[]): T[] {
  const order: string[] = [];
  for (const i of items) if (!order.includes(i.group)) order.push(i.group);
  return order.flatMap((g) => items.filter((i) => i.group === g));
}

// The last picks: pages and actions by id, records (a signal, a warning…) with what to show of them
// and their address. Eight at most.
type Recent =
  string | { id: string; label: string; group: string; icon: IconName; hint?: string; href: string; scope: string };
const recentId = (r: Recent): string => (typeof r === 'string' ? r : r.id);
export function readRecent(v: unknown): Recent[] {
  if (!Array.isArray(v)) return [];
  const ok = (x: Record<string, unknown>): boolean =>
    ['id', 'label', 'group', 'icon', 'href', 'scope'].every((k) => typeof x[k] === 'string') &&
    isIconName(String(x.icon)) &&
    (x.hint === undefined || typeof x.hint === 'string') &&
    String(x.href).startsWith('#/');
  return v.filter(
    (x): x is Recent => typeof x === 'string' || (!!x && typeof x === 'object' && ok(x as Record<string, unknown>)),
  );
}
const recent = (): Recent[] => readRecent(load<unknown>('palette-recent', []));
const remember = (r: Recent): void =>
  save('palette-recent', [r, ...recent().filter((x) => recentId(x) !== recentId(r))].slice(0, 8));

export function installPalette(source: PaletteSource): { open(): void } {
  let dialog: HTMLDialogElement | null = null;

  const open = (): void => {
    if (dialog) return;
    ux('palette', 'open');
    const d = document.createElement('dialog');
    dialog = d;
    d.className = 'dialog palette';
    d.dataset.state = 'open';
    d.setAttribute('aria-label', 'Search pages and actions');
    const site = Boolean(source.search && source.canSearch?.() !== false);
    const what = site ? 'pages, actions and the site' : 'pages and actions';
    d.innerHTML = `
      <div class="palette-input">${icon('search', { size: 18 })}<input type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-label="Search ${what}" placeholder="Search ${what}…" autocomplete="off" spellcheck="false" /><kbd>Esc</kbd></div>
      <div class="palette-list" id="palette-list" role="listbox" aria-label="Results"></div>
      <div class="palette-status" role="status"></div>
      <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span></div>`;
    const input = d.querySelector('input') as HTMLInputElement;
    const list = d.querySelector('#palette-list') as HTMLElement;
    const status = d.querySelector('.palette-status') as HTMLElement;
    let shown: PaletteItem[] = [];
    let active = 0;
    let extra: PaletteItem[] = [];
    let searching = false;
    let seq = 0;
    let waiting: ReturnType<typeof setInterval> | undefined;

    const draw = (): void => {
      const q = input.value;
      const all = source.items();
      let items: PaletteItem[];
      let matched = 0; // matches, not counting what is made of the query itself
      if (q.trim()) {
        const found = [
          ...grouped([
            ...rank(
              all.filter((i) => !i.late),
              q,
            ),
            ...extra,
          ]),
          ...grouped(
            rank(
              all.filter((i) => i.late),
              q,
            ).slice(0, LATE_SHOWN),
          ),
        ];
        matched = found.length;
        items = [...found, ...(source.typed?.(q.trim()) ?? [])];
      } else {
        const byId = new Map(all.map((i) => [i.id, i]));
        const here = source.scope?.() ?? '';
        const recents = recent()
          .filter((r) => typeof r === 'string' || r.scope === here) // records of this site only
          .map((r): PaletteItem | undefined =>
            typeof r === 'string'
              ? byId.get(r)
              : {
                  ...r,
                  run: () => {
                    location.hash = r.href;
                  },
                },
          )
          .filter((i): i is PaletteItem => i !== undefined)
          .map((i) => ({ ...i, group: 'Recent' }));
        items = [...recents, ...all.filter((i) => !recents.some((r) => r.id === i.id))];
      }
      shown = items;
      active = Math.min(active, Math.max(0, items.length - 1));
      // Options sit in labelled groups (role=group), so a screen reader hears "Pages", "Signals"…
      const groups: { name: string; html: string[] }[] = [];
      items.forEach((item, n) => {
        if (groups.at(-1)?.name !== item.group) groups.push({ name: item.group, html: [] });
        groups
          .at(-1)
          ?.html.push(
            `<div class="palette-item" role="option" id="palette-${n}" data-n="${n}" aria-selected="${n === active}">${icon(item.icon)}<span class="palette-label">${esc(item.label)}</span>${item.hint ? `<span class="palette-hint">${esc(item.hint)}</span>` : ''}</div>`,
          );
      });
      list.innerHTML = groups
        .map(
          (g, k) =>
            `<div role="group" aria-labelledby="palette-g${k}"><div class="palette-group" id="palette-g${k}">${esc(g.name)}</div>${g.html.join('')}</div>`,
        )
        .join('');
      list.hidden = !items.length; // a listbox holds options, or isn't there
      // What isn't an option goes beside the list, in a status line.
      status.innerHTML = searching
        ? `${icon('loader-circle', { size: 14 })} Searching the site…`
        : q.trim() && !matched
          ? `Nothing matches “${esc(q.trim())}”.`
          : '';
      if (items.length) input.setAttribute('aria-activedescendant', `palette-${active}`);
      else input.removeAttribute('aria-activedescendant');
      list.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
    };

    const close = (): void => {
      if (!dialog) return;
      dialog = null;
      clearInterval(waiting);
      d.dataset.state = 'closed';
      const done = (): void => {
        d.close();
        d.remove();
      };
      const running = d.getAnimations({ subtree: true });
      if (running.length) void Promise.all(running.map((a) => a.finished.catch(() => {}))).then(done);
      else done();
      setTimeout(done, 400);
    };
    const choose = (n: number): void => {
      const item = shown[n];
      if (!item) return;
      ux('palette', `chose.${uxName(item.group)}`); // the kind of thing chosen, not which (U1.09)
      if (item.href)
        remember({
          id: item.id,
          label: item.label,
          group: item.group,
          icon: item.icon,
          hint: item.hint,
          href: item.href,
          scope: source.scope?.() ?? '',
        });
      else if (source.items().some((i) => i.id === item.id)) remember(item.id);
      close();
      item.run();
    };

    input.addEventListener('input', () => {
      active = 0;
      extra = [];
      const q = input.value.trim();
      const mine = ++seq;
      // Asked as each query is typed: the site may have loaded since the palette opened.
      searching = Boolean(source.search) && source.canSearch?.() !== false && q.length >= 2;
      clearInterval(waiting);
      // Typed before there was anything to ask (the site still loading): ask once there is.
      if (source.search && !searching && q.length >= 2)
        waiting = setInterval(() => {
          if (source.canSearch?.() === false) return;
          clearInterval(waiting);
          if (mine === seq && dialog) input.dispatchEvent(new Event('input'));
        }, 250);
      draw();
      if (!searching || !source.search) return;
      const ask = source.search;
      setTimeout(() => {
        if (mine !== seq) return; // typed on: only the last query is asked
        ask(q).then(
          (found) => {
            if (mine !== seq || !dialog) return;
            extra = found;
            searching = false;
            draw();
          },
          () => {
            if (mine !== seq || !dialog) return;
            searching = false;
            draw();
          },
        );
      }, 200);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!shown.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        draw();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        active = e.key === 'Home' ? 0 : Math.max(0, shown.length - 1);
        draw();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        choose(active);
      }
    });
    list.addEventListener('pointermove', (e) => {
      const n = Number((e.target as Element).closest<HTMLElement>('[data-n]')?.dataset.n ?? NaN);
      if (!Number.isNaN(n) && n !== active) {
        active = n;
        for (const li of list.querySelectorAll('[role=option]'))
          li.setAttribute('aria-selected', String(li.getAttribute('data-n') === String(n)));
        input.setAttribute('aria-activedescendant', `palette-${n}`);
      }
    });
    list.addEventListener('click', (e) => {
      const n = Number((e.target as Element).closest<HTMLElement>('[data-n]')?.dataset.n ?? NaN);
      if (!Number.isNaN(n)) choose(n);
    });
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      close();
    });
    let pressedOutside = false;
    const outside = (e: MouseEvent): boolean => {
      const r = d.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    d.addEventListener('pointerdown', (e) => (pressedOutside = outside(e)));
    d.addEventListener('click', (e) => {
      if (pressedOutside && outside(e)) close();
    });
    document.body.append(d);
    d.showModal();
    draw();
    input.focus();
  };

  document.addEventListener('keydown', (e) => {
    const combo = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k';
    if (!combo) return;
    if (dialog) return void e.preventDefault();
    if (document.querySelector('dialog[open]')) return; // another dialog has the page
    e.preventDefault();
    open();
  });
  return { open };
}
