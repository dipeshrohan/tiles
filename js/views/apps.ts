import { esc, onAll, onNavigate, onSubmit, routeOf } from '../lib/dom.ts';
import type { AppResult, AppTemplate, StudioApp } from '../lib/api.ts';
import {
  appLink,
  appNumberFromHash,
  configSummary,
  defaultConfig,
  factText,
  formValues,
  paramField,
  readConfig,
  resultChart,
  statusBadge,
  type SignalOption,
} from '../lib/apps.ts';
import { fitWidth, TIME_CHART, timeChart } from '../lib/svg.ts';
import type { Context, View } from './types.ts';
import { confirmDialog } from '../lib/overlay.ts';
import { emptyState, loadingState, needsApi } from '../lib/ui.ts';
import { icon } from '../lib/icons.ts';

// App Studio (T6.10): use cases configured from templates, without code. A template (a wear check,
// SPC limits) says what it needs; its form is made from that; an app is the template configured on
// one of the site's signals, run on its readings when opened. `#/apps/<number>` links to one,
// `#/apps/new` makes one.

interface Draft {
  key: string; // the page it belongs to: new, or the app being edited
  template: string;
  name: string;
  values: Record<string, string | string[]>; // as typed
}

// `failed`: the last fetch failed; the page offers to try again rather than look empty.
let templates: { api: string; list: AppTemplate[] | null; failed?: boolean } | null = null;
let listing: { key: string; items: StudioApp[] | null; failed?: boolean } | null = null;
let signals: { key: string; list: SignalOption[] } | null = null;
let result: { key: string; result: AppResult | null } | null = null; // null result: couldn't run
let draft: Draft | null = null;
let busy = false;

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;
const hash = (): string => (typeof location === 'undefined' ? '' : location.hash);
const NEW = /^#\/apps\/new(?:[?/]|$)/;
const EDIT = /^#\/apps\/\d+\/edit(?:[?/]|$)/;
const isNew = (): boolean => NEW.test(hash());
const editKey = (): boolean => EDIT.test(hash());
const selected = (): number | null => appNumberFromHash(hash());
const listKey = (ctx: Context): string => `${siteId(ctx)}`;
const resultKey = (ctx: Context, app: StudioApp): string => `${siteId(ctx)}|${app.number}|${app.updated_at}`;
const canEdit = (ctx: Context): boolean => ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';

// Each visit fetches afresh: others change apps, and the readings move on.
onNavigate((h) => {
  if (routeOf(h) !== 'apps') {
    listing = null;
    result = null;
  } else if (appNumberFromHash(h) === null) result = null;
  // Leaving a form (Cancel, or anywhere else) drops what was typed in it, and the signals it
  // listed: the next form starts from the app's settings and today's catalogue.
  if (!NEW.test(h) && !EDIT.test(h)) {
    draft = null;
    signals = null;
  }
});

async function load(ctx: Context): Promise<void> {
  const api = ctx.api;
  const site = siteId(ctx);
  if (!api || !site) return;
  if (templates?.api !== api.baseUrl) {
    templates = { api: api.baseUrl, list: null };
    api.appTemplates().then(
      (list) => {
        if (templates?.api === api.baseUrl) templates.list = list;
        ctx.rerender();
      },
      () => {
        if (templates?.api === api.baseUrl) templates.failed = true;
        ctx.rerender();
      },
    );
  }
  if (listing?.key !== listKey(ctx)) {
    const key = listKey(ctx);
    listing = { key, items: null };
    try {
      const items = await api.apps.list(site);
      if (listing?.key === key) listing.items = items;
    } catch {
      if (listing?.key === key) listing.failed = true;
    }
    ctx.rerender();
  }
}

async function loadSignals(ctx: Context): Promise<void> {
  const api = ctx.api;
  const site = siteId(ctx);
  if (!api || !site || signals?.key === site) return;
  signals = { key: site, list: [] };
  try {
    const got = await api.signals.list(site, { limit: 500 });
    if (signals?.key === site) signals.list = got.signals.map((s) => ({ id: s.id, tag: s.tag, unit: s.unit }));
  } catch {
    // the client showed why
  }
  ctx.rerender();
}

async function run(ctx: Context, app: StudioApp): Promise<void> {
  const api = ctx.api;
  const site = siteId(ctx);
  if (!api || !site) return;
  const key = resultKey(ctx, app);
  result = { key, result: null };
  let got: AppResult | null = null;
  try {
    got = await api.apps.result(site, app.number);
  } catch {
    // the client showed why
  }
  if (result?.key === key) result = { key, result: got };
  ctx.rerender();
}

const retry = (what: string, attr: string): string =>
  emptyState({
    illustration: 'error',
    compact: true,
    alert: true,
    title: `${what} could not be loaded`,
    action: `<button class="btn sm" type="button" ${attr}>${icon('refresh-cw')} Try again</button>`,
  });

function listCard(ctx: Context): string {
  const items = listing?.key === listKey(ctx) ? listing.items : null;
  const n = selected();
  const rows =
    listing?.key === listKey(ctx) && listing.failed
      ? retry('The apps', 'data-retry-apps')
      : items === null
        ? loadingState()
        : items
            .map(
              (
                a,
              ) => `<a class="review-row ${n === a.number ? 'sel' : ''}" href="${appLink(a.number)}" data-app="${a.number}">
              <b>#${a.number} ${esc(a.name)}</b>
              <span class="small muted">${esc(a.template_title)} · ${esc(a.signal_tag ?? 'signal gone')}</span>
            </a>`,
            )
            .join('') ||
          emptyState({
            illustration: 'inbox',
            compact: true,
            title: 'No apps yet',
            body: canEdit(ctx) ? 'Make one from a template.' : 'Engineers make them from templates.',
          });
  const make = canEdit(ctx) ? `<a class="btn primary sm" href="#/apps/new" data-new-app>New app</a>` : '';
  return `<div class="card stack" style="gap:8px"><div class="row" style="justify-content:space-between;gap:8px"><h2>Apps</h2>${make}</div><div class="review-list" data-app-list>${rows}</div></div>`;
}

function templateCards(list: AppTemplate[]): string {
  return `<div class="stack" style="gap:8px" data-templates>${list
    .map(
      (t) => `<button class="card app-template" type="button" data-template="${esc(t.id)}">
        <b>${esc(t.title)}</b><span class="small soft">${esc(t.summary)}</span></button>`,
    )
    .join('')}</div>`;
}

function formCard(ctx: Context, d: Draft, template: AppTemplate, editing: StudioApp | null): string {
  const config = Object.keys(d.values).length ? readConfig(template, d.values).config : null;
  const values = config ?? (editing ? editing.config : defaultConfig(template));
  const list = signals?.list ?? [];
  const fields = template.params.map((p) => paramField(p, values[p.name], list)).join('');
  const title = editing ? `Change #${editing.number} ${editing.name}` : `New app: ${template.title}`;
  return `<form class="card stack" id="app-form" style="gap:10px">
      <h2>${esc(title)}</h2>
      <p class="small soft">${esc(template.summary)}</p>
      <label class="field" for="app-name">Name<input id="app-name" type="text" name="__name" value="${esc(d.name)}" maxlength="120" required /></label>
      <div class="grid g2 app-fields" style="gap:10px">${fields}</div>
      <div class="row" style="gap:8px"><button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${editing ? 'Save' : 'Make the app'}</button><a class="btn" href="${editing ? appLink(editing.number) : '#/apps'}">Cancel</a></div>
    </form>`;
}

function newCard(ctx: Context): string {
  const list = templates?.list;
  if (templates?.failed) return `<div class="card">${retry('The templates', 'data-retry-templates')}</div>`;
  if (!list) return `<div class="card">${loadingState('Loading the templates…')}</div>`;
  if (!draft || draft.key !== 'new' || !list.some((t) => t.id === draft?.template))
    return `<div class="card stack" style="gap:10px"><h2>New app</h2><p class="small soft">Choose what it does. You set it up for one of the site's signals next.</p>${templateCards(list)}</div>`;
  const template = list.find((t) => t.id === draft?.template);
  return template ? formCard(ctx, draft, template, null) : '';
}

function detailCard(ctx: Context): string {
  const n = selected();
  const items = listing?.key === listKey(ctx) ? listing.items : null;
  if (n === null)
    return `<div class="card">${emptyState({ illustration: 'select', title: 'Choose an app', body: 'Or make one from a template.' })}</div>`;
  if (listing?.failed)
    return `<div class="card">${emptyState({ illustration: 'error', alert: true, title: 'The apps could not be loaded' })}</div>`;
  if (items === null) return `<div class="card">${loadingState()}</div>`;
  const app = items.find((a) => a.number === n);
  if (!app)
    return `<div class="card">${emptyState({ illustration: 'search', title: `There is no app #${n} on this site`, action: '<a class="btn" href="#/apps">All apps</a>' })}</div>`;
  const template = templates?.list?.find((t) => t.id === app.template);
  if (editKey()) {
    if (templates?.failed) return `<div class="card">${retry('The templates', 'data-retry-templates')}</div>`;
    if (!template) return `<div class="card">${loadingState('Loading the template…')}</div>`;
    if (draft?.key !== `edit|${app.number}`)
      draft = { key: `edit|${app.number}`, template: app.template, name: app.name, values: {} };
    return formCard(ctx, draft, template, app);
  }
  const r = result?.key === resultKey(ctx, app) ? result : null;
  const settings = `<details><summary class="small">Settings</summary><ul class="small" data-app-settings>${configSummary(
    template,
    app.config,
    app.signal_tag,
  )
    .map((line) => `<li>${esc(line)}</li>`)
    .join('')}</ul></details>`;
  const tools = canEdit(ctx)
    ? `<div class="row" style="gap:8px"><a class="btn sm" href="${appLink(app.number)}/edit" data-edit-app>Change</a><button class="btn sm danger" type="button" data-archive-app ${busy ? 'disabled' : ''}>Archive</button></div>`
    : '';
  let body: string;
  if (!r) body = '<p class="small soft">Running it on the latest readings…</p>';
  else if (!r.result) body = '<p class="small soft">It could not run. Check its settings.</p>';
  else {
    const out = r.result;
    const chart = timeChart({ ...resultChart(out), width: fitWidth(TIME_CHART.width, 0.7) });
    const facts = out.facts.length
      ? `<div class="row" style="gap:24px;flex-wrap:wrap" data-app-facts>${out.facts
          .map((f) => `<div><div class="small soft">${esc(f.label)}</div><strong>${esc(factText(f))}</strong></div>`)
          .join('')}</div>`
      : '';
    const marked = out.spans.length
      ? `<p class="small soft">Shaded: ${esc([...new Set(out.spans.map((s) => s.label))].join('; '))}.</p>`
      : '';
    body = `<div class="row" style="gap:8px;align-items:center" data-app-status>${statusBadge(out.status)} <b>${esc(out.headline)}</b></div>
      <p data-app-text>${esc(out.text)}</p>${facts}${chart}${marked}`;
  }
  return `<div class="card stack" style="gap:12px" data-app-detail>
      <div class="row" style="justify-content:space-between;align-items:start;gap:12px;flex-wrap:wrap">
        <div><h2>#${app.number} ${esc(app.name)}</h2>
        <p class="small soft">${esc(app.template_title)} on <code>${esc(app.signal_tag ?? 'a signal no longer on this site')}</code> · made by ${esc(app.created_by)}</p></div>
        <button class="btn sm" type="button" data-rerun>Run again</button>
      </div>
      ${body}
      ${settings}
      ${tools}
    </div>`;
}

async function save(ctx: Context, form: HTMLFormElement): Promise<void> {
  const api = ctx.api;
  const site = siteId(ctx);
  const d = draft;
  const template = templates?.list?.find((t) => t.id === d?.template);
  if (!api || !site || !d || !template || busy) return;
  const { config, problems } = readConfig(template, formValues(form));
  const name = d.name.trim();
  if (!name) problems.unshift('Give the app a name');
  if (problems.length) return void ctx.toast(problems.join('. '));
  busy = true;
  ctx.rerender();
  try {
    const editing = /^edit\|(\d+)$/.exec(d.key);
    const saved = editing
      ? await api.apps.update(site, Number(editing[1]), { name, config })
      : await api.apps.create(site, { name, template: template.id, config });
    ctx.toast(editing ? 'App saved' : `App #${saved.number} made`);
    draft = null;
    listing = null;
    result = null;
    location.hash = appLink(saved.number);
  } catch {
    // the client showed why
  } finally {
    busy = false;
    ctx.rerender();
  }
}

const view: View = {
  id: 'apps',
  title: 'App Studio',
  icon: 'layout-grid',
  render(ctx) {
    const head = `<div class="page-head"><div><div class="eyebrow">Data · Apps</div><h1>App Studio</h1>
        <p class="soft">Checks set up from templates, without code: a tool's wear, a process's control limits. Each one runs on a signal's latest readings when you open it.</p></div></div>`;
    if (!ctx.api) return `${head}<div class="card">${needsApi(`Apps are kept by the Tiles API.`)}</div>`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}<div class="card">Loading from the Tiles API…</div>`;
    if (o.status !== 'ready')
      return `${head}<div class="card" role="alert">Can't reach the Tiles API: ${esc(o.error)}</div>`;
    return `${head}<div class="reviews">${listCard(ctx)}${isNew() ? newCard(ctx) : detailCard(ctx)}</div>`;
  },
  bind(root, ctx) {
    if (!ctx.api || ctx.ontology.status !== 'ready') return;
    void load(ctx);
    const items = listing?.key === listKey(ctx) ? listing.items : null;
    const app = items?.find((a) => a.number === selected()) ?? null;
    if (isNew() || editKey()) void loadSignals(ctx);
    else if (app && result?.key !== resultKey(ctx, app)) void run(ctx, app);
    onAll(root, '[data-template]', 'click', (el) => {
      const t = templates?.list?.find((x) => x.id === el.dataset.template);
      if (t) draft = { key: 'new', template: t.id, name: t.title, values: {} };
      ctx.rerender();
    });
    const form = root.querySelector<HTMLFormElement>('#app-form');
    form?.addEventListener('input', () => {
      if (!draft) return;
      const values = formValues(form);
      draft.name = String(values.__name ?? '');
      delete values.__name;
      draft.values = values;
    });
    onSubmit(root, '#app-form', (f) => void save(ctx, f));
    onAll(root, '[data-retry-templates]', 'click', () => {
      templates = null;
      ctx.rerender();
    });
    onAll(root, '[data-retry-apps]', 'click', () => {
      listing = null;
      ctx.rerender();
    });
    onAll(root, '[data-rerun]', 'click', () => {
      if (app) void run(ctx, app);
    });
    onAll(root, '[data-archive-app]', 'click', async () => {
      const api = ctx.api;
      const site = siteId(ctx);
      if (!api || !site || !app) return;
      const yes = await confirmDialog({
        title: `Archive app #${app.number}?`,
        body: `${app.name} leaves the list; its runs and history are kept.`,
        confirm: 'Archive',
      });
      if (!yes) return;
      api.apps.archive(site, app.number).then(
        () => {
          ctx.toast(`Archived #${app.number}`);
          listing = null;
          location.hash = '#/apps';
        },
        () => undefined,
      );
    });
  },
};

export default view;
