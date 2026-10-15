import { ux } from '../lib/analytics.ts';
import { esc, onAction, onAll, onNavigate, onSubmit, routeOf, bound } from '../lib/dom.ts';
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
import { t, tHtml, type MessageKey } from '../lib/i18n.ts';
import { showErrors } from '../lib/forms.ts';
import { removeNow } from '../lib/undo.ts';
import { emptyState, errorState, needsApi, pageHead, skeleton, apiUnreachable } from '../lib/ui.ts';
import { keyAttr } from '../lib/shortcuts.ts';

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

const retry = (title: MessageKey, attr: string): string =>
  errorState({
    title: t(title),
    body: t('apps.failed.body'),
    retry: attr.replace(/^data-/, ''),
    compact: true,
  });

function listCard(ctx: Context): string {
  const items = listing?.key === listKey(ctx) ? listing.items : null;
  const n = selected();
  const rows =
    listing?.key === listKey(ctx) && listing.failed
      ? retry('apps.failed.apps', 'data-retry-apps')
      : items === null
        ? skeleton.list()
        : items
            .map(
              (
                a,
              ) => `<a class="review-row ${n === a.number ? 'sel' : ''}" href="${appLink(a.number)}" data-app="${a.number}">
              <b>#${a.number} ${esc(a.name)}</b>
              <span class="small muted">${esc(a.template_title)} · ${esc(a.signal_tag ?? t('apps.signalGone'))}</span>
            </a>`,
            )
            .join('') ||
          emptyState({
            illustration: 'inbox',
            compact: true,
            title: t('apps.empty.title'),
            body: t(canEdit(ctx) ? 'apps.empty.engineer' : 'apps.empty.viewer'),
          });
  const make = canEdit(ctx) ? `<a class="btn primary sm" href="#/apps/new" data-new-app>${t('apps.newApp')}</a>` : '';
  return `<div class="card stack gap-2"><div class="row justify-between gap-2"><h2>${t('apps.apps')}</h2>${make}</div><div class="review-list" data-app-list>${rows}</div></div>`;
}

function templateCards(list: AppTemplate[]): string {
  return `<div class="stack gap-2" data-templates>${list
    .map(
      (tpl) => `<button class="card app-template" type="button" data-template="${esc(tpl.id)}">
        <b>${esc(tpl.title)}</b><span class="small soft">${esc(tpl.summary)}</span></button>`,
    )
    .join('')}</div>`;
}

function formCard(ctx: Context, d: Draft, template: AppTemplate, editing: StudioApp | null): string {
  const config = Object.keys(d.values).length ? readConfig(template, d.values).config : null;
  const values = config ?? (editing ? editing.config : defaultConfig(template));
  const list = signals?.list ?? [];
  const fields = template.params.map((p) => paramField(p, values[p.name], list)).join('');
  const title = editing
    ? t('apps.form.changeTitle', { number: editing.number, name: editing.name })
    : t('apps.form.newTitle', { name: template.title });
  return `<form class="card stack gap-2_5" id="app-form">
      <h2>${esc(title)}</h2>
      <p class="small soft">${esc(template.summary)}</p>
      <label class="field" for="app-name">${t('apps.form.name')}<input id="app-name" type="text" name="__name" data-api="name" value="${esc(d.name)}" maxlength="120" required /></label>
      <div class="grid g2 app-fields gap-2_5">${fields}</div>
      <div class="row gap-2"><button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${esc(t(editing ? 'apps.form.save' : 'apps.form.make'))}</button><a class="btn" href="${editing ? appLink(editing.number) : '#/apps'}">${t('apps.form.cancel')}</a></div>
    </form>`;
}

function newCard(ctx: Context): string {
  const list = templates?.list;
  if (templates?.failed) return `<div class="card">${retry('apps.failed.templates', 'data-retry-templates')}</div>`;
  if (!list) return `<div class="card">${skeleton.list(3, t('apps.loadingTemplates'))}</div>`;
  if (!draft || draft.key !== 'new' || !list.some((tpl) => tpl.id === draft?.template))
    return `<div class="card stack gap-2_5"><h2>${t('apps.newApp')}</h2><p class="small soft">${esc(t('apps.chooseTemplate'))}</p>${templateCards(list)}</div>`;
  const template = list.find((tpl) => tpl.id === draft?.template);
  return template ? formCard(ctx, draft, template, null) : '';
}

function detailCard(ctx: Context): string {
  const n = selected();
  const items = listing?.key === listKey(ctx) ? listing.items : null;
  if (n === null)
    return `<div class="card">${emptyState({ illustration: 'select', title: t('apps.choose.title'), body: t('apps.choose.body') })}</div>`;
  // The list beside it says what failed, with Try again: not a second alert here.
  if (listing?.failed)
    return `<div class="card">${emptyState({ illustration: 'error', compact: true, title: t('apps.notLoaded.title', { number: n }), body: t('apps.notLoaded.body') })}</div>`;
  if (items === null) return `<div class="card">${skeleton.card()}</div>`;
  const app = items.find((a) => a.number === n);
  if (!app)
    return `<div class="card">${emptyState({ illustration: 'search', title: t('apps.missing.title', { number: n }), body: t('apps.missing.body'), action: `<a class="btn" href="#/apps">${t('apps.missing.all')}</a>` })}</div>`;
  const template = templates?.list?.find((tpl) => tpl.id === app.template);
  if (editKey()) {
    if (templates?.failed) return `<div class="card">${retry('apps.failed.templates', 'data-retry-templates')}</div>`;
    if (!template) return `<div class="card">${skeleton.card(t('apps.loadingTemplate'))}</div>`;
    if (draft?.key !== `edit|${app.number}`)
      draft = { key: `edit|${app.number}`, template: app.template, name: app.name, values: {} };
    return formCard(ctx, draft, template, app);
  }
  const r = result?.key === resultKey(ctx, app) ? result : null;
  const settings = `<details><summary class="small">${t('apps.settings')}</summary><ul class="small" data-app-settings>${configSummary(
    template,
    app.config,
    app.signal_tag,
  )
    .map((line) => `<li>${esc(line)}</li>`)
    .join('')}</ul></details>`;
  const tools = canEdit(ctx)
    ? `<div class="row gap-2"><a class="btn sm" href="${appLink(app.number)}/edit" data-edit-app${keyAttr('e')}>${t('apps.change')}</a><button class="btn sm danger" type="button" data-archive-app ${busy ? 'disabled' : ''}>${t('apps.archive')}</button></div>`
    : '';
  let body: string;
  if (!r) body = `<p class="small soft">${esc(t('apps.running'))}</p>`;
  else if (!r.result) body = `<p class="small soft">${esc(t('apps.couldNotRun'))}</p>`;
  else {
    const out = r.result;
    const chart = timeChart({ ...resultChart(out), width: fitWidth(TIME_CHART.width, 0.7) });
    const facts = out.facts.length
      ? `<div class="row gap-6 wrap" data-app-facts>${out.facts
          .map((f) => `<div><div class="small soft">${esc(f.label)}</div><strong>${esc(factText(f))}</strong></div>`)
          .join('')}</div>`
      : '';
    const marked = out.spans.length
      ? `<p class="small soft">${esc(t('apps.shaded', { list: [...new Set(out.spans.map((s) => s.label))].join('; ') }))}</p>`
      : '';
    body = `<div class="row gap-2 items-center" data-app-status>${statusBadge(out.status)} <b>${esc(out.headline)}</b></div>
      <p data-app-text>${esc(out.text)}</p>${facts}${chart}${marked}`;
  }
  return `<div class="card stack gap-3" data-app-detail>
      <div class="row justify-between items-start gap-3 wrap">
        <div><h2>#${app.number} ${esc(app.name)}</h2>
        <p class="small soft">${tHtml('apps.madeBy', { template: esc(app.template_title), signal: `<code>${esc(app.signal_tag ?? t('apps.noSignal'))}</code>`, name: esc(app.created_by) })}</p></div>
        <button class="btn sm" type="button" data-rerun>${t('apps.runAgain')}</button>
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
  const template = templates?.list?.find((tpl) => tpl.id === d?.template);
  if (!api || !site || !d || !template || busy) return;
  const { config, problems } = readConfig(template, formValues(form));
  const name = d.name.trim();
  if (!name) problems.unshift({ name: '__name', message: t('apps.noName') });
  if (problems.length) return void showErrors(form, problems);
  busy = true;
  ctx.rerender();
  try {
    const editing = /^edit\|(\d+)$/.exec(d.key);
    const saved = editing
      ? await api.apps.update(site, Number(editing[1]), { name, config })
      : await api.apps.create(site, { name, template: template.id, config });
    ctx.toast(editing ? t('apps.toast.saved') : t('apps.toast.made', { number: saved.number }));
    ux('task', editing ? 'app.changed' : 'app.made');
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
  get title() {
    return t('apps.title');
  },
  icon: 'layout-grid',
  crumbs(ctx) {
    if (!ctx.api || ctx.ontology.status !== 'ready') return [];
    if (isNew()) return canEdit(ctx) ? [{ label: t('apps.newApp') }] : [];
    const n = selected();
    // Not one the list says is gone.
    if (n === null || (listing?.key === listKey(ctx) && listing.items && !listing.items.some((a) => a.number === n)))
      return [];
    return [{ label: `#${n}`, href: appLink(n) }, ...(editKey() && canEdit(ctx) ? [{ label: t('apps.change') }] : [])];
  },
  render(ctx) {
    const head = pageHead({
      eyebrow: t('apps.eyebrow'),
      title: t('apps.title'),
      lead: t('apps.lead'),
    });
    if (!ctx.api) return `${head}<div class="card">${needsApi(esc(t('apps.needsApi')))}</div>`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}<div class="card">${skeleton.card(t('apps.loading'))}</div>`;
    if (o.status !== 'ready')
      return `${head}${apiUnreachable(o.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })}`;
    return `${head}<div class="split">${listCard(ctx)}${isNew() ? newCard(ctx) : detailCard(ctx)}</div>`;
  },
  bind(root, ctx) {
    if (!ctx.api || ctx.ontology.status !== 'ready') return;
    void load(ctx);
    const items = listing?.key === listKey(ctx) ? listing.items : null;
    const app = items?.find((a) => a.number === selected()) ?? null;
    if (isNew() || editKey()) void loadSignals(ctx);
    else if (app && result?.key !== resultKey(ctx, app)) void run(ctx, app);
    onAll(root, '[data-template]', 'click', (el) => {
      const tpl = templates?.list?.find((x) => x.id === el.dataset.template);
      if (tpl) draft = { key: 'new', template: tpl.id, name: tpl.title, values: {} };
      ctx.rerender();
    });
    const form = root.querySelector<HTMLFormElement>('#app-form');
    form?.addEventListener(
      'input',
      () => {
        if (!draft) return;
        const values = formValues(form);
        draft.name = String(values.__name ?? '');
        delete values.__name;
        draft.values = values;
      },
      { signal: bound() },
    );
    onSubmit(root, '#app-form', (f) => save(ctx, f));
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
    // Archived at once, with Undo (U2.03): back to the list, where Undo brings it back.
    onAction(root, '[data-archive-app]', () => {
      const api = ctx.api;
      const site = siteId(ctx);
      if (!api || !site || !app) return;
      const n = app.number;
      return removeNow({
        toast: ctx.toast,
        message: t('apps.toast.archived', { number: n, name: app.name }),
        send: () =>
          api.apps.archive(site, n).then(() => {
            listing = null;
            location.hash = '#/apps';
          }),
        undo: () => api.apps.restore(site, n),
        restored: () => {
          listing = null;
          ctx.rerender();
        },
        restoredMessage: t('apps.toast.restored', { number: n, name: app.name }),
      });
    });
  },
};

export default view;
