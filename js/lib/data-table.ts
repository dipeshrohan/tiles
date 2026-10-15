// Tables v2 (U5.02): one table behaviour for the app's lists, after shadcn/ui's data table.
// - Sortable headers (a button in each, `aria-sort` on the header cell); a sticky header row and
//   first column in a scrolling frame.
// - Columns chosen and their widths (drag a header's edge, or arrow keys on it) and the density
//   (comfortable or compact), remembered in this browser per table (`table:<id>`).
// - Row selection with a bar of bulk actions; paging (`pageSize`), or virtual rows past
//   VIRTUAL_AFTER, only the rows in view drawn; CSV export of the current view (its columns, in its
//   order, every row); an empty state, and a skeleton while loading.
// A page draws `dataTable(o)` in its HTML and calls `bindTable(root, o)` in bind; changes to the
// table's own state (sort, columns, scrolling) redraw only the table, through the morph, so a form
// in a row keeps what is typed.
import { esc, bound, setBusy } from './dom.ts';
import { attrs, button, skeleton, type Attrs } from './ui.ts';
import { icon } from './icons.ts';
import { load, save } from './store.ts';
import { morph } from './morph.ts';

export const VIRTUAL_AFTER = 200; // rows: beyond, only those in view are drawn (500 drawn at once take over 50 ms)
const OVERSCAN = 12; // rows drawn above and below the view
const MIN_WIDTH = 64; // px
const MAX_WIDTH = 800;
const ROW_HEIGHT = { comfortable: 41, compact: 31 } as const; // px, until a row is measured

export interface Column<T> {
  key: string;
  label: string;
  srOnly?: boolean; // an actions column: its header is for screen readers
  cell(row: T): string; // built markup (escape what it holds)
  // What it sorts by; without one, it doesn't sort.
  value?(row: T): string | number | null;
  csv?(row: T): string; // what it exports as; otherwise the text its cell shows
  fixed?: boolean; // always shown (the first column is, too)
  numeric?: boolean; // right-aligned
  width?: number; // px, before someone sets their own
}

export type Density = 'comfortable' | 'compact';

export interface TablePrefs {
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  hidden: string[];
  widths: Record<string, number>;
  density: Density;
}

export const DEFAULT_PREFS: TablePrefs = { sort: null, hidden: [], widths: {}, density: 'comfortable' };

export interface BulkAction {
  id: string;
  label: string; // a verb: "Check quality"
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'destructive';
}

export interface TableOptions<T> {
  id: string; // unique on the page, and what its preferences are kept under
  label: string; // the table's name, for screen readers
  columns: readonly Column<T>[];
  rows: readonly T[] | null; // null while loading
  key(row: T): string;
  empty: string; // built markup: the empty state
  status?: string; // built markup before the tools: "5,000 signals"
  rowAttrs?(row: T): Attrs; // on its <tr> (data-key is set already)
  after?(row: T): string; // whole rows of built markup after it: a detail, a form
  select?: { actions: readonly BulkAction[]; run(action: string, keys: string[]): unknown };
  pageSize?: number; // pages of this many; otherwise every row, virtual past VIRTUAL_AFTER
  csv?: string; // the file name: shows Export CSV
  drawn?(el: HTMLElement): void; // after the table draws itself again (sorting, scrolling): wire its rows
}

// ---- preferences and state ----

// Preferences as kept (an older app's, or edited): only known columns and sane values.
export function cleanPrefs(value: unknown, keys: readonly string[]): TablePrefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof TablePrefs, unknown>>;
  const known = new Set(keys);
  const sort = v.sort as TablePrefs['sort'] | undefined;
  const widths = typeof v.widths === 'object' && v.widths !== null ? (v.widths as Record<string, unknown>) : {};
  return {
    sort:
      sort && typeof sort === 'object' && known.has(sort.key) && (sort.dir === 'asc' || sort.dir === 'desc')
        ? { key: sort.key, dir: sort.dir }
        : null,
    hidden: Array.isArray(v.hidden) ? v.hidden.filter((k): k is string => typeof k === 'string' && known.has(k)) : [],
    widths: Object.fromEntries(
      Object.entries(widths)
        .filter(([k, w]) => known.has(k) && typeof w === 'number' && Number.isFinite(w))
        .map(([k, w]) => [k, clampWidth(w as number)]),
    ),
    density: v.density === 'compact' ? 'compact' : 'comfortable',
  };
}

export const clampWidth = (w: number): number => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));

interface Live {
  prefs: TablePrefs;
  page: number;
  selected: Set<string>;
  start: number; // the first row drawn, when virtual
  rowHeight: number | null; // measured
  sorted: { rows: readonly unknown[]; sort: string; out: unknown[] } | null; // until the rows or order change
}
const live = new Map<string, Live>();

function stateOf<T>(o: TableOptions<T>): Live {
  let s = live.get(o.id);
  if (!s) {
    s = {
      prefs: cleanPrefs(
        load<unknown>(`table:${o.id}`, null),
        o.columns.map((c) => c.key),
      ),
      page: 0,
      selected: new Set(),
      start: 0,
      rowHeight: null,
      sorted: null,
    };
    live.set(o.id, s);
  }
  return s;
}

const keep = (id: string, s: Live): void => save(`table:${id}`, s.prefs);

// The rows in order, sorted once for each list and order (scrolling and ticking boxes reuse it).
function ordered<T>(o: TableOptions<T>, s: Live): T[] {
  const rows = o.rows ?? [];
  const sort = JSON.stringify(s.prefs.sort);
  if (s.sorted?.rows !== rows || s.sorted.sort !== sort)
    s.sorted = { rows, sort, out: sortRows(rows, o.columns, s.prefs.sort) };
  return s.sorted.out as T[];
}

// Unticks a table's rows (after a bulk action has done its work).
export const clearSelection = (id: string): void => live.get(id)?.selected.clear();

// Forgets every table's state in this tab (tests).
export const resetTables = (): void => live.clear();

// ---- the pure parts ----

export function visibleColumns<T>(columns: readonly Column<T>[], prefs: TablePrefs): Column<T>[] {
  return columns.filter((c, i) => i === 0 || c.fixed || !prefs.hidden.includes(c.key));
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// The rows in the order asked: by the column's value, empty ones last either way; stable.
export function sortRows<T>(rows: readonly T[], columns: readonly Column<T>[], sort: TablePrefs['sort']): T[] {
  const col = sort ? columns.find((c) => c.key === sort.key) : undefined;
  if (!sort || !col?.value) return [...rows];
  const value = col.value;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => {
      const x = a.v;
      const y = b.v;
      if (x === null || x === '') return y === null || y === '' ? a.i - b.i : 1;
      if (y === null || y === '') return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
      return c * dir || a.i - b.i;
    })
    .map((r) => r.row);
}

// The rows to draw, as a window of the sorted ones: [start, end), with how many are above and below.
export function windowOf(
  total: number,
  scrollTop: number,
  viewHeight: number,
  rowHeight: number,
): { start: number; end: number } {
  if (total <= VIRTUAL_AFTER) return { start: 0, end: total };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const shown = Math.ceil(viewHeight / rowHeight);
  const start = Math.max(0, Math.min(total - 1, first - OVERSCAN));
  return { start, end: Math.min(total, first + shown + OVERSCAN) };
}

// A CSV of the view: the columns shown (not action columns), every row in its order. Values with a
// comma, quote or line break are quoted (RFC 4180); a value starting =, +, - or @ gets a ' so a
// spreadsheet doesn't run it as a formula.
export function toCsv<T>(rows: readonly T[], columns: readonly Column<T>[], text: (html: string) => string): string {
  const cols = columns.filter((c) => !c.srOnly);
  const field = (v: string): string => {
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const line = (values: string[]) => values.map(field).join(',');
  return `${[
    line(cols.map((c) => c.label)),
    ...rows.map((r) => line(cols.map((c) => (c.csv ? c.csv(r) : text(c.cell(r)))))),
  ].join('\r\n')}\r\n`;
}

const textOf = (html: string): string => {
  const el = document.createElement('template');
  el.innerHTML = html;
  return (el.content.textContent ?? '').replace(/\s+/g, ' ').trim();
};

// ---- drawing ----

function sortIcon(dir: 'asc' | 'desc' | null): string {
  return icon(dir === 'asc' ? 'arrow-up' : dir === 'desc' ? 'arrow-down' : 'arrow-up-down', { size: 14 });
}

function head<T>(o: TableOptions<T>, s: Live, cols: Column<T>[], rows: readonly T[]): string {
  const all = rows.length > 0 && rows.every((r) => s.selected.has(o.key(r)));
  const some = !all && rows.some((r) => s.selected.has(o.key(r)));
  const check = o.select
    ? `<th scope="col" class="select-col"><input type="checkbox" data-table-all aria-label="Select every row"${all ? ' checked' : ''}${some ? ' data-mixed' : ''}></th>`
    : '';
  return `<thead><tr>${check}${cols
    .map((c) => {
      const dir = s.prefs.sort?.key === c.key ? s.prefs.sort.dir : null;
      const sort = dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
      const label = c.srOnly ? `<span class="sr-only">${esc(c.label)}</span>` : esc(c.label);
      const inner = c.value
        ? `<button class="th-sort" type="button" data-sort="${esc(c.key)}">${label}${sortIcon(dir)}</button>`
        : label;
      const resize = c.srOnly
        ? ''
        : `<span class="col-resize" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Width of ${esc(c.label)}" aria-valuemin="${MIN_WIDTH}" aria-valuemax="${MAX_WIDTH}" aria-valuenow="${s.prefs.widths[c.key] ?? c.width ?? 160}" data-resize="${esc(c.key)}"></span>`;
      return `<th scope="col"${attrs({ 'aria-sort': c.value ? sort : undefined, class: c.numeric ? 'num' : undefined, 'data-col': c.key })}>${inner}${resize}</th>`;
    })
    .join('')}</tr></thead>`;
}

function rowHtml<T>(o: TableOptions<T>, s: Live, cols: Column<T>[], row: T, index: number): string {
  const key = o.key(row);
  const picked = s.selected.has(key);
  const check = o.select
    ? `<td class="select-col"><input type="checkbox" data-table-row="${esc(key)}" aria-label="Select row ${index + 1}"${picked ? ' checked' : ''}></td>`
    : '';
  const extra = o.rowAttrs?.(row) ?? {};
  return `<tr${attrs({ ...extra, 'data-key': `row-${key}`, 'aria-rowindex': index + 2, 'aria-selected': o.select ? picked : undefined })}>${check}${cols
    .map((c) => `<td${attrs({ class: c.numeric ? 'num' : undefined })}>${c.cell(row)}</td>`)
    .join('')}</tr>${o.after?.(row) ?? ''}`;
}

function bodyHtml<T>(o: TableOptions<T>, s: Live, cols: Column<T>[], rows: readonly T[]): string {
  const span = cols.length + (o.select ? 1 : 0);
  if (o.pageSize) {
    const from = s.page * o.pageSize;
    return rows
      .slice(from, from + o.pageSize)
      .map((r, i) => rowHtml(o, s, cols, r, from + i))
      .join('');
  }
  if (rows.length <= VIRTUAL_AFTER) return rows.map((r, i) => rowHtml(o, s, cols, r, i)).join('');
  const h = s.rowHeight ?? ROW_HEIGHT[s.prefs.density];
  const start = Math.min(s.start, Math.max(0, rows.length - 1));
  const end = Math.min(rows.length, start + Math.ceil(800 / h) + 2 * OVERSCAN);
  const pad = (n: number, where: string) =>
    n > 0
      ? `<tr class="spacer" aria-hidden="true" data-key="spacer-${where}"><td colspan="${span}" style="height:${Math.round(n * h)}px"></td></tr>`
      : '';
  return `${pad(start, 'top')}${rows
    .slice(start, end)
    .map((r, i) => rowHtml(o, s, cols, r, start + i))
    .join('')}${pad(rows.length - end, 'bottom')}`;
}

function inner<T>(o: TableOptions<T>): string {
  const s = stateOf(o);
  const cols = visibleColumns(o.columns, s.prefs);
  const choosable = o.columns.filter((c, i) => i > 0 && !c.fixed && !c.srOnly);
  const tools = `<div class="table-tools">
      <div class="table-status">${o.status ?? ''}</div>
      ${
        choosable.length
          ? `<details class="table-columns"><summary class="btn sm ghost">${icon('columns-3', { size: 14 })}Columns</summary>
        <fieldset class="menu-panel"><legend class="sr-only">Columns shown</legend>${choosable
          .map(
            (c) =>
              `<label class="row gap-2"><input type="checkbox" data-table-col="${esc(c.key)}"${s.prefs.hidden.includes(c.key) ? '' : ' checked'}> ${esc(c.label)}</label>`,
          )
          .join('')}</fieldset></details>`
          : ''
      }
      ${button('Compact', { size: 'sm', variant: 'ghost', attrs: { 'data-table-density': true, 'aria-pressed': s.prefs.density === 'compact' } })}
      ${o.csv && o.rows?.length ? button('Export CSV', { size: 'sm', variant: 'ghost', icon: 'download', attrs: { 'data-table-csv': true } }) : ''}
    </div>`;
  if (o.rows === null)
    return `${tools}${skeleton.table(6, Math.min(cols.length, 6), `Loading ${o.label.toLowerCase()}…`)}`;
  if (!o.rows.length) return `${tools}${o.empty}`;
  const rows = ordered(o, s);
  const keys = new Set(rows.map(o.key));
  for (const k of s.selected) if (!keys.has(k)) s.selected.delete(k); // gone from the list
  const bar =
    o.select && s.selected.size
      ? `<div class="bulk-bar" role="region" aria-label="Selected rows"><span><b>${s.selected.size}</b> selected</span>${o.select.actions
          .map((a) =>
            button(a.label, { size: 'sm', variant: a.variant ?? 'secondary', attrs: { 'data-table-action': a.id } }),
          )
          .join(
            '',
          )}${button('Clear selection', { size: 'sm', variant: 'ghost', attrs: { 'data-table-clear': true } })}</div>`
      : '';
  const pages = o.pageSize ? Math.max(1, Math.ceil(rows.length / o.pageSize)) : 1;
  if (s.page >= pages) s.page = pages - 1;
  const paging =
    o.pageSize && pages > 1
      ? `<nav class="table-paging row gap-2" aria-label="Pages of ${esc(o.label.toLowerCase())}"><span class="small soft">${s.page * o.pageSize + 1}–${Math.min(rows.length, (s.page + 1) * o.pageSize)} of ${rows.length}</span>${button('Previous', { size: 'sm', disabled: s.page === 0, attrs: { 'data-table-page': -1 } })}${button('Next', { size: 'sm', disabled: s.page >= pages - 1, attrs: { 'data-table-page': 1 } })}</nav>`
      : '';
  const virtual = !o.pageSize && rows.length > VIRTUAL_AFTER;
  const widths = cols.map((c) => s.prefs.widths[c.key] ?? c.width);
  const sized = cols.some((c) => s.prefs.widths[c.key] !== undefined);
  const colgroup = `<colgroup>${o.select ? '<col class="select-col">' : ''}${widths
    .map((w) => (w ? `<col style="width:${w}px">` : '<col>'))
    .join('')}</colgroup>`;
  return `${tools}${bar}<div class="table-wrap table-frame"${virtual ? ' data-virtual' : ''} tabindex="0" role="region" aria-label="${esc(o.label)}"><table${attrs({ 'aria-rowcount': virtual ? rows.length + 1 : undefined, class: sized ? 'sized' : undefined })}>${colgroup}${head(o, s, cols, rows)}<tbody>${bodyHtml(o, s, cols, rows)}</tbody></table></div>${paging}`;
}

export function dataTable<T>(o: TableOptions<T>): string {
  const s = stateOf(o);
  return `<div class="data-table density-${s.prefs.density}" data-table="${esc(o.id)}">${inner(o)}</div>`;
}

// ---- behaviour ----

export function bindTable<T>(root: ParentNode, o: TableOptions<T>): void {
  const el = root.querySelector<HTMLElement>(`[data-table="${CSS.escape(o.id)}"]`);
  if (!el) return;
  const s = stateOf(o);
  const signal = bound();
  const redraw = (): void => {
    el.className = `data-table density-${s.prefs.density}`;
    morph(el, inner(o));
    mixed();
    o.drawn?.(el);
  };
  // The header's box shows "some" when some rows are picked (a property, not an attribute).
  const mixed = (): void => {
    const all = el.querySelector<HTMLInputElement>('[data-table-all]');
    if (all) all.indeterminate = all.hasAttribute('data-mixed');
  };
  mixed();
  const sorted = (): T[] => ordered(o, s);

  el.addEventListener(
    'click',
    (e) => {
      const t = e.target instanceof Element ? e.target : null;
      const sortBy = t?.closest<HTMLElement>('[data-sort]')?.dataset.sort;
      if (sortBy) {
        const now = s.prefs.sort?.key === sortBy ? s.prefs.sort.dir : null;
        // Ascending, descending, then as the list comes.
        s.prefs.sort = now === null ? { key: sortBy, dir: 'asc' } : now === 'asc' ? { key: sortBy, dir: 'desc' } : null;
        s.page = 0;
        keep(o.id, s);
        redraw();
        el.querySelector<HTMLElement>(`[data-sort="${CSS.escape(sortBy)}"]`)?.focus();
        return;
      }
      if (t?.closest('[data-table-density]')) {
        s.prefs.density = s.prefs.density === 'compact' ? 'comfortable' : 'compact';
        s.rowHeight = null;
        keep(o.id, s);
        redraw();
        el.querySelector<HTMLElement>('[data-table-density]')?.focus();
        return;
      }
      if (t?.closest('[data-table-csv]')) {
        const csv = toCsv(sorted(), visibleColumns(o.columns, s.prefs), textOf);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        a.download = o.csv ?? `${o.id}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return;
      }
      const step = t?.closest<HTMLElement>('[data-table-page]')?.dataset.tablePage;
      if (step) {
        s.page += Number(step);
        redraw();
        el.querySelector('.table-frame')?.scrollTo({ top: 0 });
        // The same button while it can go on; at the end, the other.
        const same = el.querySelector<HTMLButtonElement>(`[data-table-page="${step}"]`);
        (same && !same.disabled ? same : el.querySelector<HTMLElement>('[data-table-page]:not(:disabled)'))?.focus();
        return;
      }
      if (t?.closest('[data-table-clear]')) {
        s.selected.clear();
        redraw();
        el.querySelector<HTMLElement>('[data-table-all]')?.focus();
        return;
      }
      // A bulk action holds its button while its request runs: a second click does nothing.
      const btn = t?.closest<HTMLButtonElement>('[data-table-action]');
      const action = btn?.dataset.tableAction;
      if (btn && action && o.select && !btn.disabled) {
        const running = o.select.run(action, [...s.selected]);
        if (running instanceof Promise) {
          setBusy(btn, true);
          void running.finally(() => btn.isConnected && setBusy(btn, false));
        }
      }
    },
    { signal },
  );

  el.addEventListener(
    'change',
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.dataset.tableCol) {
        const k = t.dataset.tableCol;
        s.prefs.hidden = t.checked ? s.prefs.hidden.filter((h) => h !== k) : [...s.prefs.hidden, k];
        keep(o.id, s);
        redraw();
        el.querySelector<HTMLElement>(`[data-table-col="${CSS.escape(k)}"]`)?.focus();
      } else if (t.dataset.tableRow !== undefined) {
        if (t.checked) s.selected.add(t.dataset.tableRow);
        else s.selected.delete(t.dataset.tableRow);
        redraw();
        el.querySelector<HTMLElement>(`[data-table-row="${CSS.escape(t.dataset.tableRow)}"]`)?.focus();
      } else if (t.hasAttribute('data-table-all')) {
        const rows = sorted();
        if (t.checked) rows.forEach((r) => s.selected.add(o.key(r)));
        else s.selected.clear();
        redraw();
        el.querySelector<HTMLElement>('[data-table-all]')?.focus();
      }
    },
    { signal },
  );

  // Widths: drag a header's edge, or arrow keys on it (16 px a press).
  const setWidth = (key: string, w: number): void => {
    s.prefs.widths[key] = clampWidth(w);
    const cols = visibleColumns(o.columns, s.prefs);
    const at = cols.findIndex((c) => c.key === key) + (o.select ? 1 : 0);
    const col = el.querySelectorAll<HTMLElement>('colgroup col')[at];
    if (col) col.style.width = `${s.prefs.widths[key]}px`;
    el.querySelector(`[data-resize="${CSS.escape(key)}"]`)?.setAttribute('aria-valuenow', String(s.prefs.widths[key]));
  };
  el.addEventListener(
    'pointerdown',
    (e) => {
      const handle = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-resize]') : null;
      const key = handle?.dataset.resize;
      const th = handle?.closest('th');
      if (!handle || !key || !th) return;
      e.preventDefault();
      const from = e.clientX;
      const width = th.getBoundingClientRect().width;
      handle.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent): void => setWidth(key, width + m.clientX - from);
      const up = (): void => {
        handle.removeEventListener('pointermove', move);
        keep(o.id, s);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    },
    { signal },
  );
  el.addEventListener(
    'keydown',
    (e) => {
      const handle = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-resize]') : null;
      const key = handle?.dataset.resize;
      if (!handle || !key || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      const th = handle.closest('th');
      const now = s.prefs.widths[key] ?? th?.getBoundingClientRect().width ?? 160;
      setWidth(key, now + (e.key === 'ArrowRight' ? 16 : -16));
      keep(o.id, s);
    },
    { signal },
  );

  // Virtual rows: drawn again as the frame scrolls, a frame at a time.
  const frame = el.querySelector<HTMLElement>('.table-frame[data-virtual]');
  if (!frame) return;
  const first = frame.querySelector<HTMLElement>('tbody tr:not(.spacer)');
  if (first && s.rowHeight === null) s.rowHeight = first.getBoundingClientRect().height || null;
  const drawWindow = (): void => {
    const rows = sorted();
    const h = s.rowHeight ?? ROW_HEIGHT[s.prefs.density];
    const top = frame.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    const { start } = windowOf(rows.length, frame.scrollTop - top, frame.clientHeight, h);
    if (Math.abs(start - s.start) < OVERSCAN / 2) return;
    s.start = start;
    const tbody = frame.querySelector('tbody');
    if (tbody) morph(tbody, bodyHtml(o, s, visibleColumns(o.columns, s.prefs), rows));
    o.drawn?.(el);
  };
  // A frame drawn new (another visit, another search) at the top shows the top, not the rows last
  // scrolled to.
  drawWindow();
  let ticking = false;
  frame.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        drawWindow();
      });
    },
    { signal, passive: true },
  );
}
