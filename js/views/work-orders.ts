// Work orders (T9.02): drafted from a warning or a component's remaining life (or by hand), approved
// by someone other than their drafter, exported as CSV for the plant's CMMS, and closed with their
// outcome. Tiles only sends them out. `#/work-orders?from=warning&id=…&title=…` opens a draft.
import type { WorkOrder, WorkOrderIn } from '../lib/api.ts';
import { download, esc, onAction, onAll, onNavigate, onSubmit, routeOf } from '../lib/dom.ts';
import { dateTime, fromInput } from '../lib/format.ts';
import { t } from '../lib/i18n.ts';
import { confirmDialog } from '../lib/overlay.ts';
import {
  apiUnreachable,
  badge,
  button,
  card,
  emptyState,
  field,
  input,
  loadFailed,
  needsApi,
  pageHead,
  select,
  skeleton,
  table,
  tabs,
} from '../lib/ui.ts';
import {
  ACTION_NAMED,
  actionsFor,
  priorityLabel,
  sourceText,
  statusLabel,
  SHOWS,
  type Action,
  type Show,
} from '../lib/work-orders.ts';
import type { Context, View } from './types.ts';

interface Ui {
  show: Show;
}
const uiState = (ctx: Context) => ctx.ui<Ui>('work-orders', { show: 'open' });

interface Draft {
  site: string | null; // the site it is drafted on (set when the page first shows it)
  from: 'warning' | 'component' | 'manual';
  id: string; // the warning's or the component's signal's
  title: string;
  description: string;
  priority: WorkOrder['priority'];
  due: string; // a datetime-local value
  asset: string;
}

let listing: { key: string; items: WorkOrder[] | null | 'failed' } | null = null;
let asked = 0; // only the latest request's answer is shown
let draft: Draft | null = null;
// Whether Tiles drafts work orders for components nearing their wear limit (per site).
let policy: { site: string; leadDays: number | null | undefined } | null = null;

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;
const listKey = (ctx: Context): string => `${siteId(ctx) ?? ''}|${uiState(ctx).show}`;
const canEdit = (ctx: Context): boolean => ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';

// Others approve and close them meanwhile: each visit asks afresh. A draft left unsent goes.
onNavigate((hash) => {
  if (routeOf(hash) !== 'work-orders') {
    listing = null;
    policy = null;
    draft = null;
  }
});

// The draft, if it is this site's: one from a link belongs to the site shown when it opened.
function draftHere(ctx: Context): Draft | null {
  if (!draft) return null;
  const site = siteId(ctx);
  if (draft.site === null && site) draft.site = site;
  return draft.site === site ? draft : null;
}

async function load(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const key = listKey(ctx);
  const mine = ++asked;
  listing = { key, items: null };
  let items: WorkOrder[] | 'failed';
  try {
    items = await ctx.api.workOrders.list(site, uiState(ctx).show);
  } catch {
    items = 'failed'; // the client showed why
  }
  if (mine !== asked) return;
  listing = { key, items };
  ctx.rerender();
}

function reload(ctx: Context): void {
  listing = null;
  ctx.rerender();
}

const PRIORITIES = (): [WorkOrder['priority'], string][] =>
  (['high', 'medium', 'low'] as const).map((p) => [p, priorityLabel(p)]);

function draftCard(ctx: Context): string {
  const d = draftHere(ctx);
  if (!d) return '';
  if (!canEdit(ctx))
    return card(`<p class="small soft">${esc(t('workOrders.draft.readOnly'))}</p>`, { attrs: { 'data-draft': '' } });
  const from =
    d.from === 'warning'
      ? t('workOrders.draft.fromWarning')
      : d.from === 'component'
        ? t('workOrders.draft.fromComponent')
        : t('workOrders.draft.byHand');
  return card(
    `<div class="card-head"><h2>${esc(t('workOrders.draft.title'))}</h2></div>
    <p class="small soft">${esc(from)}</p>
    <form id="work-order-form" class="stack gap-3">
      ${field(t('workOrders.field.title'), input({ name: 'title', value: d.title, attrs: { required: true, maxlength: '200' } }))}
      ${field(t('workOrders.field.description'), `<textarea name="description" rows="3" maxlength="4000">${esc(d.description)}</textarea>`)}
      ${d.from === 'manual' ? field(t('workOrders.field.asset'), input({ name: 'asset', value: d.asset, attrs: { maxlength: '100' } }), { hint: t('workOrders.field.assetHint') }) : ''}
      <div class="row gap-3 wrap">
        ${field(t('workOrders.field.priority'), select('priority', PRIORITIES(), d.priority))}
        ${field(t('workOrders.field.due'), input({ name: 'due', type: 'datetime-local', value: d.due }))}
      </div>
      <div class="row gap-2">
        ${button(t('workOrders.draft.submit'), { type: 'submit', variant: 'primary' })}
        ${button(t('workOrders.draft.discard'), { variant: 'ghost', attrs: { 'data-draft-discard': '' } })}
      </div>
    </form>`,
    { attrs: { 'data-draft': '' } },
  );
}

const ACTION_LABEL: Record<Action, () => string> = {
  approve: () => t('workOrders.action.approve'),
  done: () => t('workOrders.action.done'),
  not_needed: () => t('workOrders.action.notNeeded'),
  cancel: () => t('workOrders.action.cancel'),
};

function statusCell(o: WorkOrder, canEditNow: boolean): string {
  const who =
    o.status === 'draft'
      ? t('workOrders.by.drafted', { name: o.drafted_by, when: dateTime(o.drafted_at) })
      : o.status === 'approved'
        ? t('workOrders.by.approved', { name: o.approved_by ?? '', when: dateTime(o.approved_at ?? o.drafted_at) })
        : o.status === 'exported'
          ? t('workOrders.by.exported', { file: o.export_ref ?? '' })
          : o.outcome === 'not_needed'
            ? t('workOrders.by.notNeeded')
            : '';
  const tone = o.status === 'draft' ? 'warn' : o.status === 'cancelled' ? '' : 'good';
  const note = o.outcome_note ? ` <span class="small soft">${esc(o.outcome_note)}</span>` : '';
  const again =
    o.export_ref && o.status !== 'cancelled' && canEditNow
      ? `<div class="no-print">${button(t('workOrders.again'), { size: 'sm', variant: 'ghost', attrs: { 'data-work-orders-again': o.export_ref, 'aria-label': t('workOrders.againNamed', { file: o.export_ref }) } })}</div>`
      : '';
  return `${badge(statusLabel(o.status), tone)}${who ? `<div class="small soft">${esc(who)}</div>` : ''}${note}${again}`;
}

async function loadPolicy(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  policy = { site, leadDays: undefined };
  let leadDays: number | null | undefined;
  try {
    leadDays = (await ctx.api.workOrders.policy(site)).lead_days;
  } catch {
    leadDays = undefined; // the client showed why; the card says nothing
  }
  if (policy?.site !== site) return;
  policy = { site, leadDays };
  ctx.rerender();
}

// Drafting by Tiles: admins set how many days before a component's predicted wear limit.
function policyCard(ctx: Context): string {
  const shown = policy?.site === siteId(ctx) ? policy.leadDays : undefined;
  if (shown === undefined) return '';
  const now = shown === null ? t('workOrders.auto.off') : t('workOrders.auto.on', { count: shown });
  if (ctx.ontology.role !== 'admin')
    return card(`<p class="small soft m-0">${esc(now)}</p>`, { attrs: { 'data-auto-drafts': '' } });
  return card(
    `<form id="auto-drafts" class="row gap-3 wrap items-end">
      ${field(t('workOrders.auto.label'), input({ name: 'leadDays', type: 'number', value: shown === null ? '' : String(shown), attrs: { min: '1', max: '365', step: '1' } }), { hint: t('workOrders.auto.hint') })}
      ${button(t('workOrders.auto.save'), { type: 'submit', size: 'sm' })}
      <p class="small soft m-0 grow">${esc(now)}</p>
    </form>`,
    { attrs: { 'data-auto-drafts': '' } },
  );
}

function listCard(ctx: Context): string {
  const ui = uiState(ctx);
  const filter = tabs({
    label: t('workOrders.show'),
    items: SHOWS.map(
      (s) =>
        [
          s,
          s === 'open' ? t('workOrders.show.open') : s === 'all' ? t('workOrders.show.all') : statusLabel(s),
        ] as const,
    ),
    current: ui.show,
    data: 'work-orders-show',
  });
  const tools = canEdit(ctx)
    ? `<div class="row gap-2 wrap no-print">
        ${button(t('workOrders.byHand'), { size: 'sm', icon: 'plus', attrs: { 'data-draft-manual': '' } })}
        ${button(t('workOrders.export'), { size: 'sm', variant: 'primary', icon: 'download', attrs: { 'data-work-orders-export': '' } })}
      </div>`
    : '';
  const head = `<div class="card-head wrap gap-2"><h2>${esc(t('workOrders.list'))}</h2>${tools}</div>${filter}`;
  const shown = listing?.key === listKey(ctx) ? listing.items : null;
  if (shown === 'failed')
    return card(`${head}${loadFailed(t('workOrders.list'), 3)}`, { attrs: { 'data-work-orders': '' } });
  if (!shown)
    return card(`${head}${skeleton.table(3, 5, t('workOrders.loading'))}`, { attrs: { 'data-work-orders': '' } });
  if (!shown.length)
    return card(
      `${head}${emptyState({ illustration: 'inbox', title: t('workOrders.empty.title'), body: t('workOrders.empty.body'), compact: true })}`,
      { attrs: { 'data-work-orders': '' } },
    );
  const role = ctx.ontology.role;
  const rows = shown
    .map((o) => {
      const actions = actionsFor(o, role)
        .map((a) =>
          button(ACTION_LABEL[a](), {
            size: 'sm',
            variant: a === 'approve' ? 'primary' : a === 'cancel' ? 'ghost' : undefined,
            attrs: {
              'data-work-order-act': a,
              'data-number': String(o.number),
              'aria-label': t(ACTION_NAMED[a], { number: o.number }),
            },
          }),
        )
        .join('');
      const own =
        o.status === 'draft' && o.mine && role === 'engineer'
          ? `<div class="small soft">${esc(t('workOrders.ownDraft'))}</div>`
          : '';
      return `<tr data-key="${o.number}">
        <td class="mono">${o.number}</td>
        <td><b>${esc(o.title)}</b><div class="small soft">${esc([o.asset, sourceText(o)].filter(Boolean).join(' · '))}</div>${o.description ? `<div class="small">${esc(o.description)}</div>` : ''}</td>
        <td>${esc(priorityLabel(o.priority))}</td>
        <td class="nowrap">${o.due_at ? esc(dateTime(o.due_at)) : '–'}</td>
        <td>${statusCell(o, canEdit(ctx))}</td>
        <td class="no-print"><div class="row gap-1 wrap">${actions}</div>${own}</td>
      </tr>`;
    })
    .join('');
  return card(
    `${head}${table({
      headers: [
        t('workOrders.col.number'),
        t('workOrders.col.title'),
        t('workOrders.col.priority'),
        t('workOrders.col.due'),
        t('workOrders.col.status'),
        { label: t('workOrders.col.actions'), srOnly: true },
      ],
      rowsHtml: rows,
    })}`,
    { attrs: { 'data-work-orders': '' } },
  );
}

function readDraft(form: HTMLFormElement, d: Draft): Draft {
  const data = new FormData(form);
  const text = (name: string): string => String(data.get(name) ?? '');
  return {
    ...d,
    title: text('title'),
    description: text('description'),
    priority: (text('priority') as WorkOrder['priority']) || 'medium',
    due: text('due'),
    asset: text('asset'),
  };
}

const view: View = {
  id: 'work-orders',
  get title() {
    return t('workOrders.title');
  },
  icon: 'clipboard-list',
  query: {
    read(params, ctx) {
      const show = params.get('show');
      uiState(ctx).show = (SHOWS as readonly string[]).includes(show ?? '') ? (show as Show) : 'open';
      const from = params.get('from');
      const id = params.get('id') ?? '';
      if ((from === 'warning' || from === 'component') && id)
        draft = {
          site: null,
          from,
          id,
          title: (params.get('title') ?? '').slice(0, 200),
          description: '',
          priority: 'medium',
          due: '',
          asset: '',
        };
    },
    write(ctx) {
      const here = draftHere(ctx);
      const d = here && here.from !== 'manual' ? here : null;
      return {
        show: uiState(ctx).show === 'open' ? null : uiState(ctx).show,
        from: d?.from,
        id: d?.id,
        title: d?.title,
      };
    },
  },
  render(ctx) {
    const head = pageHead({ title: t('workOrders.title'), lead: t('workOrders.lead') });
    if (!ctx.api) return `${head}${card(needsApi(esc(t('workOrders.needsApi'))))}`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}${card(skeleton.table(3, 5))}`;
    if (o.status !== 'ready')
      return `${head}${apiUnreachable(o.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })}`;
    return `${head}<div class="stack gap-4">${draftCard(ctx)}${policyCard(ctx)}${listCard(ctx)}</div>`;
  },
  bind(root, ctx) {
    if (!ctx.api || ctx.ontology.status !== 'ready') return;
    if (listing?.key !== listKey(ctx)) void load(ctx);
    if (policy?.site !== siteId(ctx)) void loadPolicy(ctx);
    onSubmit(root, '#auto-drafts', (form) => {
      const site = siteId(ctx);
      if (!site || !ctx.api) return;
      const raw = String(new FormData(form).get('leadDays') ?? '').trim();
      const leadDays = raw === '' ? null : Number(raw);
      return ctx.api.workOrders.setPolicy(site, leadDays).then(
        (saved) => {
          policy = { site, leadDays: saved.lead_days };
          ctx.toast(t('workOrders.auto.saved'));
          ctx.rerender();
        },
        () => undefined, // the client showed why
      );
    });
    onAll(root, '[data-work-orders-show]', 'click', (el) => {
      uiState(ctx).show = (el.dataset.workOrdersShow as Show | undefined) ?? 'open';
      ctx.rerender();
    });
    onAll(root, '[data-draft-manual]', 'click', () => {
      draft = {
        site: siteId(ctx),
        from: 'manual',
        id: '',
        title: '',
        description: '',
        priority: 'medium',
        due: '',
        asset: '',
      };
      ctx.rerender();
    });
    onAll(root, '[data-draft-discard]', 'click', () => {
      draft = null;
      ctx.rerender();
    });
    onSubmit(root, '#work-order-form', (form) => {
      const site = siteId(ctx);
      const here = draftHere(ctx);
      if (!site || !ctx.api || !here) return;
      const d = (draft = readDraft(form, here));
      const body: WorkOrderIn = {
        source: d.from === 'warning' ? 'warning' : d.from === 'component' ? 'remaining_life' : 'manual',
        warning_id: d.from === 'warning' ? d.id : null,
        signal_id: d.from === 'component' ? d.id : null,
        asset: d.from === 'manual' ? d.asset.trim() || null : null,
        title: d.title.trim(),
        description: d.description.trim(),
        priority: d.priority,
        due_at: d.due ? new Date(fromInput(d.due)).toISOString() : null,
      };
      return ctx.api.workOrders.draft(site, body).then(
        (made) => {
          draft = null;
          ctx.toast(t('workOrders.drafted', { number: made.number }));
          uiState(ctx).show = 'open';
          reload(ctx);
        },
        () => undefined, // the client showed why
      );
    });
    onAction(root, '[data-work-order-act]', async (el) => {
      const site = siteId(ctx);
      const api = ctx.api;
      const n = Number(el.dataset.number);
      const act = el.dataset.workOrderAct as Action | undefined;
      if (!site || !api || !n || !act) return;
      if (act === 'cancel') {
        const sure = await confirmDialog({
          title: t('workOrders.cancel.title', { number: n }),
          body: t('workOrders.cancel.body'),
          confirm: t('workOrders.action.cancel'),
          cancel: t('workOrders.cancel.keep'),
          tone: 'danger',
        });
        if (!sure) return;
      }
      const done =
        act === 'approve'
          ? api.workOrders.approve(site, n)
          : act === 'cancel'
            ? api.workOrders.cancel(site, n)
            : api.workOrders.outcome(site, n, act);
      return done.then(
        (o) => {
          ctx.toast(t('workOrders.changed', { number: o.number, status: statusLabel(o.status) }));
          reload(ctx);
        },
        () => undefined, // the client showed why
      );
    });
    onAction(root, '[data-work-orders-again]', (el) => {
      const site = siteId(ctx);
      const file = el.dataset.workOrdersAgain;
      if (!site || !ctx.api || !file) return;
      return ctx.api.workOrders.export(site, file).then(
        (out) => download(out.name, out.csv, 'text/csv'),
        () => undefined, // the client showed why
      );
    });
    onAction(root, '[data-work-orders-export]', (_el) => {
      const site = siteId(ctx);
      if (!site || !ctx.api) return;
      return ctx.api.workOrders.export(site).then(
        (out) => {
          download(out.name, out.csv, 'text/csv');
          ctx.toast(t('workOrders.exported', { count: out.numbers.length, file: out.name }));
          reload(ctx);
        },
        () => undefined, // the client showed why
      );
    });
  },
};

export default view;
