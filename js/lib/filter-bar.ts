// The filter bar (U5.06): above a list, a chip for each filter set (× takes it off), "Add filter"
// (goes to that filter's control on the page), Clear all, how many results, and the saved views:
// open one, save the page's filters and table settings under a name, share it with the site
// (engineers), or delete it (with Undo). Warnings, Signals and Documents draw it. The views are
// read once a minute at most and kept here for the bar and the menu (`viewsFor`).

import { esc, bound, setBusy } from './dom.ts';
import { checkOnSubmit } from './forms.ts';
import { icon } from './icons.ts';
import { morph } from './morph.ts';
import { panelDialog } from './overlay.ts';
import { badge, button, iconButton } from './ui.ts';
import { removeLater, isRemoving } from './undo.ts';
import { setTablePrefs, tablePrefs } from './data-table.ts';
import { ux } from './analytics.ts';
import { chips, currentView, filtersOf, unset, viewHref, viewQuery, viewTable, type Filters } from './saved-views.ts';
import type { SavedView, ViewPage } from './api.ts';
import type { Context } from '../views/types.ts';

// ---- the views, shared by the bar and the menu ----------------------------------------------

let cache: { key: string; views: SavedView[] | null; at: number; failed?: boolean } = { key: '', views: null, at: 0 };
let loading = '';
const REFRESH_MS = 60_000;

// Whose views on which site of which API: another person signed in reads theirs.
const keyOf = (ctx: Pick<Context, 'api' | 'ontology'>): string =>
  ctx.api && ctx.ontology.site && ctx.ontology.userId
    ? `${ctx.api.baseUrl}|${ctx.ontology.site.id}|${ctx.ontology.userId}`
    : '';

const removing = (ctx: Pick<Context, 'api' | 'ontology'>, v: SavedView): boolean =>
  Boolean(ctx.api && ctx.ontology.site) &&
  isRemoving({ kind: 'view', api: ctx.api?.baseUrl ?? '', site: ctx.ontology.site?.id ?? '', id: v.id });

// The site's views (yours and those shared), or null until read; reads them when stale.
export function viewsFor(ctx: Pick<Context, 'api' | 'ontology'>): SavedView[] | null {
  const key = keyOf(ctx);
  if (!key) return null;
  if (cache.key !== key || Date.now() - cache.at > REFRESH_MS) void loadViews(ctx);
  return cache.key === key && cache.views ? cache.views.filter((v) => !removing(ctx, v)) : null;
}

// Reads the views again (after a change, or when stale) and says so: the bar and the menu redraw.
export async function loadViews(ctx: Pick<Context, 'api' | 'ontology'>, force = false): Promise<void> {
  const key = keyOf(ctx);
  const site = ctx.ontology.site;
  if (!key || !ctx.api || !site || (loading === key && !force)) return;
  loading = key;
  if (cache.key !== key) cache = { key, views: null, at: 0 };
  try {
    const views = await ctx.api.views.list(site.id, { silent: true });
    if (keyOf(ctx) === key) cache = { key, views, at: Date.now() };
  } catch {
    // Tried: again in a minute (or on Try again), the list as it was; never read, the bar says so.
    if (cache.key === key) Object.assign(cache, { at: Date.now(), failed: cache.views === null });
  } finally {
    if (loading === key) loading = '';
  }
  document.dispatchEvent(new CustomEvent('tiles:views'));
}

// ---- the bar ------------------------------------------------------------------------------

export interface BarOptions {
  page: ViewPage;
  filters(): Filters; // the page's filters now
  count(): string; // "12 warnings"; '' while loading
  apply(filters: Filters): void; // set the page's filters (and draw it again)
}

const canShare = (ctx: Context): boolean => ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';

function viewsMenu(ctx: Context, o: BarOptions): string {
  const all = viewsFor(ctx);
  const views = all?.filter((v) => v.page === o.page) ?? null;
  const prefs = tablePrefs(o.page);
  const now = views ? currentView(views, o.page, o.filters(), prefs ? viewTable(prefs) : null) : null;
  const admin = ctx.ontology.role === 'admin';
  const failed = views === null && cache.key === keyOf(ctx) && cache.failed;
  const list =
    views === null
      ? failed
        ? `<p class="small" role="alert">The saved views could not be loaded. ${button('Try again', { size: 'sm', attrs: { 'data-views-retry': true } })}</p>`
        : '<p class="small soft">Loading the saved views…</p>'
      : views.length
        ? `<ul class="views-list">${views
            .map(
              (v) => `<li data-key="view-${esc(v.id)}">
              <a href="${esc(viewHref(v))}" data-view-open="${esc(v.id)}"${now?.id === v.id ? ' aria-current="true"' : ''}>${esc(v.name)}</a>
              ${v.shared ? badge(v.mine ? 'Shared' : `By ${v.owner}`, v.mine ? 'good' : '') : ''}
              <span class="grow"></span>
              ${v.mine && canShare(ctx) ? button(v.shared ? 'Stop sharing' : 'Share', { size: 'sm', variant: 'ghost', attrs: { 'data-view-share': v.id } }) : ''}
              ${v.mine || (v.shared && admin) ? iconButton('trash-2', `Delete the view ${v.name}`, { size: 'sm', variant: 'ghost', attrs: { 'data-view-delete': v.id } }) : ''}
            </li>`,
            )
            .join('')}</ul>`
        : '<p class="small soft">No saved views yet: set the filters, sort and columns you want, then save them here.</p>';
  return `<details class="menu-wrap views-menu" data-views-menu>
      <summary class="btn sm">${icon('bookmark', { size: 14 })}<span>${now ? esc(now.name) : 'Saved views'}</span></summary>
      <div class="menu-panel views-panel">${list}
        ${button('Save this view', { size: 'sm', variant: 'primary', icon: 'plus', attrs: { 'data-view-save': true } })}
      </div>
    </details>`;
}

function barInner(ctx: Context, o: BarOptions): string {
  const f = o.filters();
  const set = chips(o.page, f);
  const add = unset(o.page, f);
  return `<div class="filter-chips" role="group" aria-label="Filters">${
    set
      .map(
        (c) =>
          `<span class="chip filter-chip" data-key="chip-${esc(c.param)}">${esc(c.text)}<button type="button" class="chip-x" data-filter-remove="${esc(c.param)}" aria-label="Remove the filter ${esc(c.text)}">${icon('x', { size: 12 })}</button></span>`,
      )
      .join('') || '<span class="small soft">No filters</span>'
  }</div>
    ${
      add.length
        ? `<details class="menu-wrap" data-add-filter><summary class="btn sm ghost">${icon('filter', { size: 14 })}<span>Add filter</span></summary><div class="menu-panel" role="group" aria-label="Add a filter">${add
            .map(
              (d) =>
                `<button type="button" class="menu-item" data-filter-add="${esc(d.param)}">${esc(d.label)}</button>`,
            )
            .join('')}</div></details>`
        : ''
    }
    ${set.length ? button('Clear all', { size: 'sm', variant: 'ghost', attrs: { 'data-filter-clear': true } }) : ''}
    <span class="small soft filter-count" aria-live="polite" data-filter-count>${esc(o.count())}</span>
    <span class="grow"></span>
    ${ctx.api && ctx.ontology.site ? viewsMenu(ctx, o) : ''}`;
}

export function filterBar(ctx: Context, o: BarOptions): string {
  return `<div class="filter-bar" data-filter-bar="${esc(o.page)}">${barInner(ctx, o)}</div>`;
}

// Wires the bar drawn by `filterBar`; `redraw` draws it again in place (after the page's filters
// or its count change without the page being drawn again).
export function bindFilterBar(root: ParentNode, ctx: Context, o: BarOptions): { redraw(): void } {
  const bar = root.querySelector<HTMLElement>(`[data-filter-bar="${CSS.escape(o.page)}"]`);
  const redraw = (): void => {
    if (bar?.isConnected) morph(bar, barInner(ctx, o));
  };
  if (!bar) return { redraw };
  const signal = bound();
  document.addEventListener('tiles:views', redraw, { signal });
  const set = (change: (f: Filters) => void): void => {
    const f = { ...o.filters() };
    change(f);
    o.apply(f);
  };
  bar.addEventListener(
    'click',
    (e) => {
      const t = e.target instanceof Element ? e.target : null;
      const remove = t?.closest<HTMLElement>('[data-filter-remove]')?.dataset.filterRemove;
      if (remove !== undefined) {
        set((f) => delete f[remove]);
        return;
      }
      if (t?.closest('[data-filter-clear]')) {
        o.apply(filtersOf(o.page, {}));
        return;
      }
      const add = t?.closest<HTMLElement>('[data-filter-add]')?.dataset.filterAdd;
      if (add) {
        t?.closest('details')?.removeAttribute('open');
        // The page's own control for it (a select, a search box, a group of toggles).
        const page = bar.closest('#view') ?? document;
        const control = page.querySelector<HTMLElement>(
          [
            `[data-filter="${CSS.escape(add)}"]`,
            `[name="${CSS.escape(add)}"]:not([data-filter-bar] *)`,
            `[data-${add}][aria-pressed="true"]`, // a group of toggles: the one pressed
          ].join(', '),
        );
        control?.scrollIntoView({ block: 'nearest' });
        control?.focus();
        return;
      }
      const open = t?.closest<HTMLAnchorElement>('[data-view-open]');
      if (open) {
        e.preventDefault();
        const view = viewsFor(ctx)?.find((v) => v.id === open.dataset.viewOpen);
        if (view) openView(ctx, view, o);
        return;
      }
      if (t?.closest('[data-views-retry]')) return void loadViews(ctx, true);
      const share = t?.closest<HTMLElement>('[data-view-share]')?.dataset.viewShare;
      if (share) return void shareView(ctx, share);
      const del = t?.closest<HTMLElement>('[data-view-delete]')?.dataset.viewDelete;
      if (del) return void deleteView(ctx, del);
      if (t?.closest('[data-view-save]')) {
        t.closest('details')?.removeAttribute('open');
        void saveView(ctx, o);
      }
    },
    { signal },
  );
  return { redraw };
}

// Opens a saved view: its table settings, then its filters (on this page, or by its address).
export function openView(ctx: Context, view: SavedView, o?: BarOptions): void {
  if (view.table) setTablePrefs(view.page, view.table);
  ux('task', 'view.opened');
  if (o && o.page === view.page) {
    document.querySelector('[data-views-menu]')?.removeAttribute('open');
    o.apply(filtersOf(view.page, view.query));
  } else if (location.hash === viewHref(view))
    ctx.rerender(); // the address already: no hashchange to draw it
  else location.hash = viewHref(view);
}

async function shareView(ctx: Context, id: string): Promise<void> {
  const view = viewsFor(ctx)?.find((v) => v.id === id);
  const site = ctx.ontology.site;
  if (!view || !ctx.api || !site) return;
  try {
    await ctx.api.views.update(site.id, id, { shared: !view.shared });
    ctx.toast(
      view.shared ? `${view.name} is yours alone again` : `${view.name} is shared with everyone on ${site.name}`,
    );
    if (!view.shared) ux('task', 'view.shared');
  } catch {
    // the client showed why
  }
  await loadViews(ctx, true);
}

function deleteView(ctx: Context, id: string): void {
  const view = viewsFor(ctx)?.find((v) => v.id === id);
  const site = ctx.ontology.site;
  const api = ctx.api;
  if (!view || !api || !site) return;
  const redraw = () => document.dispatchEvent(new CustomEvent('tiles:views'));
  removeLater({
    toast: ctx.toast,
    message: `${view.name} deleted`,
    removal: { kind: 'view', api: api.baseUrl, site: site.id, id },
    hide: redraw,
    restore: redraw,
    send: () => api.views.remove(site.id, id),
    sent: () => loadViews(ctx, true),
  });
}

// Asks for a name (and whether to share it), then saves the page's filters and table settings.
async function saveView(ctx: Context, o: BarOptions): Promise<void> {
  const site = ctx.ontology.site;
  const api = ctx.api;
  if (!site || !api) return;
  const share = canShare(ctx);
  await panelDialog(
    {
      title: 'Save this view',
      body: 'Its filters, and the table’s sort, columns and row size, under a name.',
      contentHtml: `<form class="stack gap-3" data-save-view>
        <label class="field">Name<input type="text" name="name" required maxlength="80" autocomplete="off" placeholder="e.g. New on my machines" /></label>
        ${
          share
            ? `<label class="row gap-2 small"><input type="checkbox" name="shared" /> Share it with everyone on ${esc(site.name)}</label>`
            : '<p class="small soft">Only engineers and admins share views with the site.</p>'
        }
        <div class="row gap-2 justify-end">${button('Cancel', { attrs: { 'data-cancel': true } })}${button('Save', { type: 'submit', variant: 'primary' })}</div>
      </form>`,
    },
    (dialog, close) => {
      const form = dialog.querySelector<HTMLFormElement>('[data-save-view]');
      if (!form) return;
      dialog.querySelector('[data-cancel]')?.addEventListener('click', close);
      form.querySelector<HTMLInputElement>('[name=name]')?.focus();
      form.noValidate = true; // checked here, with the error under the field (U2.07)
      // Not onSubmit: that is the page's binding, and the page may be drawn again under the dialog.
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const submit = form.querySelector<HTMLButtonElement>('[type=submit]');
        if (submit?.getAttribute('aria-busy') === 'true' || !checkOnSubmit(form)) return;
        const name = (new FormData(form).get('name') ?? '').toString().trim();
        const shared = share && Boolean(new FormData(form).get('shared'));
        const prefs = tablePrefs(o.page);
        if (submit) setBusy(submit, true);
        api.views
          .create(site.id, {
            page: o.page,
            name,
            query: viewQuery(o.page, o.filters()),
            table: prefs ? viewTable(prefs) : null,
            shared,
          })
          .then(
            async () => {
              close();
              ctx.toast(shared ? `${name} saved and shared with ${site.name}` : `${name} saved`);
              ux('task', 'view.saved');
              await loadViews(ctx, true);
            },
            () => {
              if (submit) setBusy(submit, false); // the client showed why (a name used already)
            },
          );
      });
    },
  );
}
