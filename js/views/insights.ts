import { esc, onAll, onSubmit, onNavigate, routeOf, bound } from '../lib/dom.ts';
import { forestPlot } from '../lib/datasets.ts';
import type { Insight, InsightStatus, InsightSummary } from '../lib/api.ts';
import {
  bindDraft,
  draftForm,
  draftText,
  insightLink,
  mayDo,
  numberFromHash,
  readDraft,
  sourceLink,
  sourceText,
  statusBadge,
  when,
  type DraftText,
} from '../lib/insights.ts';
import { fitWidth, gapFor, TIME_CHART, timeChart, toPoints } from '../lib/svg.ts';
import type { Context, View } from './types.ts';
import { t, tHtml } from '../lib/i18n.ts';
import { listKeys, rowClicks, split } from '../lib/split.ts';
import { confirmDialog } from '../lib/overlay.ts';
import { emptyState, needsApi, pageHead, skeleton, apiUnreachable } from '../lib/ui.ts';
import { keyAttr } from '../lib/shortcuts.ts';
import { bindTable, dataTable, type TableOptions } from '../lib/data-table.ts';

// Saved insights (T3.12): findings saved from the correlation finder or the Data explorer, with the
// question asked, the evidence it gave then and the actions proposed; another engineer accepts or
// rejects each. `#/insights/<number>` links to one.

interface Ui {
  status: InsightStatus | ''; // '' for all
}

const uiState = (ctx: Context) => ctx.ui<Ui>('insights', { status: 'proposed' });

let listing: { key: string; items: InsightSummary[] | null; total: number } | null = null;
let detail: { key: string; insight: Insight | null } | null = null; // null insight: not found
let busy = false;
let editing: { key: string; text: DraftText } | null = null; // the edit form, kept across re-renders
let note = { key: '', text: '' }; // the review note being written

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;
const listKey = (ctx: Context): string => `${siteId(ctx)}|${uiState(ctx).status}`;
const selected = (): number | null => (typeof location === 'undefined' ? null : numberFromHash(location.hash));
const detailKey = (ctx: Context): string => `${siteId(ctx)}|${selected()}`;

// Others save and review while you are elsewhere: each visit to the page fetches afresh.
onNavigate((hash) => {
  // Back to the list (or away): what others did meanwhile shows when you come back.
  if (routeOf(hash) !== 'insights' || numberFromHash(hash) === null) {
    listing = null;
    detail = null;
    editing = null;
  }
});

async function loadList(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const key = listKey(ctx);
  listing = { key, items: null, total: 0 };
  const status = uiState(ctx).status || undefined;
  try {
    const got = await ctx.api.insights.list(site, { status });
    if (listing?.key === key) listing = { key, items: got.insights, total: got.total };
  } catch {
    if (listing?.key === key) listing = { key, items: [], total: 0 };
  }
  ctx.rerender();
}

async function loadDetail(ctx: Context, n: number): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const key = detailKey(ctx);
  detail = { key, insight: null };
  let insight: Insight | null = null;
  try {
    insight = await ctx.api.insights.get(site, n);
  } catch {
    // the client showed why
  }
  if (detail?.key === key) detail = { key, insight };
  ctx.rerender();
}

const INSIGHT_RANK: Record<string, number> = { proposed: 0, accepted: 1, rejected: 2 };

// The insights as a table (U5.02): each one's link opens it beside the list.
function listTable(ctx: Context, n: number | null, items: InsightSummary[]): TableOptions<InsightSummary> {
  return {
    id: 'insights',
    label: t('insights.title'),
    columns: [
      {
        key: 'insight',
        label: t('insights.table.insight'),
        value: (i) => i.number,
        csv: (i) => `#${i.number} ${i.title}`,
        cell: (i) =>
          `<a class="row-open" href="${insightLink(i.number)}"${n === i.number ? ' aria-current="true"' : ''}>#${i.number} ${esc(i.title)}</a>`,
      },
      {
        key: 'status',
        label: t('insights.table.status'),
        value: (i) => INSIGHT_RANK[i.status] ?? 9,
        csv: (i) => i.status,
        cell: (i) => statusBadge(i.status),
      },
      {
        key: 'kind',
        label: t('insights.table.from'),
        value: (i) => i.kind,
        cell: (i) => esc(t(i.kind === 'correlation' ? 'insights.kind.correlation' : 'insights.kind.signals')),
      },
      { key: 'author', label: t('insights.table.author'), value: (i) => i.author, cell: (i) => esc(i.author) },
      {
        key: 'created',
        label: t('insights.table.saved'),
        value: (i) => i.created_at,
        csv: (i) => i.created_at,
        cell: (i) => esc(when(i.created_at)),
      },
      {
        key: 'reviewer',
        label: t('insights.table.reviewedBy'),
        value: (i) => i.reviewer,
        cell: (i) => esc(i.reviewer ?? '—'),
      },
    ],
    rows: items,
    key: (i) => String(i.number),
    empty: '',
    rowAttrs: (i) => ({ 'data-insight': i.number, class: n === i.number ? 'sel' : undefined }),
    csv: 'insights.csv',
  };
}

function listCard(ctx: Context, ui: Ui): string {
  const tabs = (['proposed', 'accepted', 'rejected', ''] as const)
    .map(
      (s) =>
        `<button class="tab ${ui.status === s ? 'active' : ''}" data-status="${s}" role="tab">${esc(t(s === 'proposed' ? 'insights.tab.proposed' : s === '' ? 'insights.tab.all' : s === 'accepted' ? 'insights.tab.accepted' : 'insights.tab.rejected'))}</button>`,
    )
    .join('');
  const items = listing?.key === listKey(ctx) ? listing.items : null;
  const n = selected();
  const empty = emptyState({
    illustration: ui.status === 'proposed' ? 'done' : 'inbox',
    compact: true,
    title: t(ui.status === 'proposed' ? 'insights.empty.proposed' : 'insights.empty.other'),
    bodyHtml: tHtml('insights.empty.body', {
      correlate: `<a href="#/correlate">${esc(t('insights.empty.correlate'))}</a>`,
      explorer: `<a href="#/explorer">${esc(t('insights.empty.explorer'))}</a>`,
    }),
  });
  const rows = items === null ? skeleton.list() : items.length ? dataTable(listTable(ctx, n, items)) : empty;
  const more =
    items && listing && listing.total > items.length
      ? `<p class="small soft">${esc(t('insights.newest', { shown: items.length, total: listing.total }))}</p>`
      : '';
  return `<div class="card"><div class="tabs" role="tablist">${tabs}</div><div data-insight-list>${rows}</div>${more}</div>`;
}

function evidence(i: Insight): string {
  const e = i.evidence;
  if (i.query.kind === 'correlation' && e.result) {
    const r = e.result;
    const split = Boolean(i.query.split);
    const said = r.explanations.length
      ? `<ul class="stack gap-1">${r.explanations.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>`
      : `<p class="small soft">${esc(t('insights.noEffect'))}</p>`;
    const shown =
      e.findings_total !== undefined && e.findings_total > r.findings.length
        ? `<p class="small soft">${esc(t('insights.kept', { shown: r.findings.length, total: e.findings_total }))}</p>`
        : '';
    return `<p class="small soft">${esc(t('insights.counts', { count: r.rows, ng: r.ng, ok: r.ok }))}</p>${said}${forestPlot(r.findings, split)}${shown}`;
  }
  return (e.series ?? [])
    .map((s) => {
      const points = toPoints(s);
      const chart = timeChart({
        points,
        from: Date.parse(s.start),
        to: Date.parse(s.end),
        gap: gapFor(s, points),
        yLabel: s.unit ?? '',
        title: s.unit ? `${s.tag} (${s.unit})` : s.tag,
        width: fitWidth(TIME_CHART.width, 0.7),
      });
      return `<div class="stack gap-1" data-evidence-series><strong><code>${esc(s.tag)}</code></strong>${chart}</div>`;
    })
    .join('');
}

function detailCard(ctx: Context): string {
  const n = selected();
  if (n === null)
    return `<div class="card">${emptyState({ illustration: 'select', title: t('insights.choose.title'), body: t('insights.choose.body') })}</div>`;
  if (detail?.key !== detailKey(ctx)) return `<div class="card">${skeleton.card()}</div>`;
  const i = detail.insight;
  if (!i)
    return `<div class="card">${emptyState({ illustration: 'error', alert: true, title: t('insights.failed.title', { number: n }), body: t('insights.failed.body') })}</div>`;
  const may = mayDo(i, ctx.ontology.userId, ctx.ontology.role);
  const key = `${detailKey(ctx)}|${i.updated_at}`;
  const link = sourceLink(i);
  const head = `<div class="row justify-between items-start gap-3 wrap">
      <div><h2>#${i.number} ${esc(i.title)}</h2>
      <p class="small soft">${esc(t('insights.savedBy', { name: i.author, when: when(i.created_at) }))}${i.updated_at !== i.created_at ? ` · ${esc(t('insights.changed', { when: when(i.updated_at) }))}` : ''}</p></div>
      <div class="row gap-1_5">${statusBadge(i.status)}</div>
    </div>`;
  const body =
    editing?.key === key
      ? draftForm('insight-edit', editing.text, busy, t('insights.saveChanges'))
      : `${i.summary ? `<p class="pre-wrap" data-summary>${esc(i.summary)}</p>` : ''}
        <div><h3>${esc(t('insights.actions'))}</h3>${
          i.actions.length
            ? `<ol data-actions>${i.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>`
            : `<p class="small soft">${esc(t('insights.noActions'))}</p>`
        }</div>`;
  const reviewed =
    i.status !== 'proposed' && i.reviewer ? `<p class="small" data-review>${esc(reviewLine(i, i.reviewer))}</p>` : '';
  if (note.key !== key) note = { key, text: '' };
  const review = may.review
    ? `<form class="stack gap-2 no-print" id="insight-review">
        <label class="field">${esc(t('insights.review.label'))} <span class="small soft">${esc(t('insights.review.needed'))}</span><textarea name="note" rows="2" maxlength="2000">${esc(note.text)}</textarea></label>
        <div class="row gap-2"><button class="btn primary" type="submit" data-decision="accepted" ${busy ? 'disabled' : ''}>${esc(t('insights.review.accept'))}</button><button class="btn" type="submit" data-decision="rejected" ${busy ? 'disabled' : ''}>${esc(t('insights.review.reject'))}</button></div>
      </form>`
    : '';
  const tools = [
    may.edit && editing?.key !== key
      ? `<button class="btn sm" type="button" data-edit${keyAttr('e')}>${esc(t('insights.edit'))}</button>`
      : '',
    may.reopen
      ? `<button class="btn sm" type="button" data-reopen ${busy ? 'disabled' : ''}>${esc(t('insights.reopen'))}</button>`
      : '',
    may.remove
      ? `<button class="btn sm" type="button" data-remove ${busy ? 'disabled' : ''}>${esc(t('insights.delete'))}</button>`
      : '',
  ].join('');
  return `<div class="card stack gap-3" data-insight-detail>
      ${head}
      ${body}
      <div class="stack gap-1_5"><h3>${esc(t('insights.evidence'))}</h3>
        <p class="small soft" data-source>${tHtml('insights.source', { source: esc(sourceText(i)), when: esc(when(i.created_at)), link: `<a href="${esc(link.href)}">${esc(link.text)}</a>` })}</p>
        ${evidence(i)}
      </div>
      ${reviewed}
      ${review}
      ${tools ? `<div class="row gap-2">${tools}</div>` : ''}
      <p class="small soft break-anywhere">${tHtml('insights.link', { link: `<a href="${insightLink(i.number)}" data-link>${esc(location.href.split('#')[0] ?? '')}${insightLink(i.number)}</a>` })}</p>
    </div>`;
}

// Who reviewed it, when, and their note.
function reviewLine(i: Insight, reviewer: string): string {
  const decision = i.status === 'accepted' ? 'accepted' : 'rejected';
  const line = i.reviewed_at
    ? t('insights.review.byOn', { decision, name: reviewer, when: when(i.reviewed_at) })
    : t('insights.review.by', { decision, name: reviewer });
  return i.review_note ? t('insights.review.note', { line, note: i.review_note }) : line;
}

async function act(
  ctx: Context,
  run: (site: string, n: number) => Promise<Insight | void>,
  done: string,
): Promise<void> {
  const site = siteId(ctx);
  const n = selected();
  if (!ctx.api || !site || n === null || busy) return;
  busy = true;
  ctx.rerender();
  try {
    const got = await run(site, n);
    ctx.toast(done);
    detail = got ? { key: detailKey(ctx), insight: got } : null;
    editing = null;
    listing = null;
    if (!got) location.hash = '#/insights';
  } catch {
    // the client showed why
  } finally {
    busy = false;
    ctx.rerender();
  }
}

const view: View = {
  id: 'insights',
  get title() {
    return t('insights.title');
  },
  icon: 'lightbulb',
  crumbs(ctx) {
    const n = selected();
    return ctx.api && ctx.ontology.status === 'ready' && n !== null ? [{ label: `#${n}`, href: insightLink(n) }] : [];
  },
  render(ctx) {
    const head = pageHead({
      eyebrow: t('insights.eyebrow'),
      title: t('insights.title'),
      lead: t('insights.lead'),
    });
    if (!ctx.api) return `${head}<div class="card">${needsApi(esc(t('insights.needsApi')))}</div>`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}<div class="card">${skeleton.card(t('insights.loading'))}</div>`;
    if (o.status !== 'ready')
      return `${head}${apiUnreachable(o.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })}`;
    return `${head}${split(listCard(ctx, uiState(ctx)), detailCard(ctx), {
      open: selected() !== null,
      back: '#/insights',
      label: t('insights.splitLabel'),
    })}`;
  },
  bind(root, ctx) {
    const api = ctx.api;
    if (!api || ctx.ontology.status !== 'ready') return;
    const ui = uiState(ctx);
    if (listing?.key !== listKey(ctx)) void loadList(ctx);
    const n = selected();
    if (n !== null && detail?.key !== detailKey(ctx)) void loadDetail(ctx, n);
    onAll(root, '[data-status]', 'click', (el) => {
      ui.status = (el.dataset.status ?? '') as Ui['status'];
      ctx.rerender();
    });
    const items = listing?.key === listKey(ctx) ? listing.items : null;
    if (items?.length) bindTable(root, listTable(ctx, n, items));
    rowClicks(root, '[data-insight-list]', '[data-insight]');
    listKeys(
      root,
      '[data-insight-list] [data-insight]',
      (row) => row.getAttribute('data-insight') === String(selected()),
    );
    const i = detail?.key === detailKey(ctx) ? detail.insight : null;
    if (!i) return;
    const key = `${detailKey(ctx)}|${i.updated_at}`;
    onAll(root, '[data-edit]', 'click', () => {
      editing = { key, text: draftText(i) };
      ctx.rerender();
    });
    const editForm = root.querySelector<HTMLFormElement>('#insight-edit');
    if (editForm && editing) {
      bindDraft(editForm, editing.text);
      onAll(editForm, '[data-cancel]', 'click', () => {
        editing = null;
        ctx.rerender();
      });
      onSubmit(root, '#insight-edit', () => {
        const draft = editing && readDraft(editing.text);
        if (typeof draft === 'string') return void ctx.toast(draft);
        if (draft) return act(ctx, (site, num) => api.insights.edit(site, num, draft), t('insights.toast.saved'));
      });
    }
    root.querySelector<HTMLTextAreaElement>('#insight-review [name=note]')?.addEventListener(
      'input',
      (e) => {
        note.text = (e.target as HTMLTextAreaElement).value;
      },
      { signal: bound() },
    );
    onSubmit(root, '#insight-review', (_form, submitter) => {
      const decision = submitter?.dataset.decision;
      if (decision !== 'accepted' && decision !== 'rejected') return;
      if (decision === 'rejected' && !note.text.trim()) return void ctx.toast(t('insights.toast.why'));
      const text = note.text.trim();
      return act(
        ctx,
        (site, num) => api.insights.review(site, num, decision, text),
        t(decision === 'accepted' ? 'insights.toast.accepted' : 'insights.toast.rejected'),
      );
    });
    onAll(
      root,
      '[data-reopen]',
      'click',
      () => void act(ctx, (site, num) => api.insights.reopen(site, num), t('insights.toast.reopened')),
    );
    onAll(root, '[data-remove]', 'click', async () => {
      const yes = await confirmDialog({
        title: t('insights.confirm.title', { number: i.number }),
        body: t('insights.confirm.body', { title: i.title }),
        confirm: t('insights.delete'),
        tone: 'danger',
      });
      // The dialog doesn't block the page: if another insight opened meanwhile, delete nothing.
      if (yes && selected() === i.number)
        void act(ctx, (site, num) => api.insights.remove(site, num), t('insights.toast.deleted'));
    });
  },
};

export default view;
