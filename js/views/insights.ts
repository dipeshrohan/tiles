import { esc, onAll, onSubmit, onNavigate, routeOf } from '../lib/dom.ts';
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
import { confirmDialog } from '../lib/overlay.ts';
import { emptyState, loadingState, needsApi, pageHead, apiUnreachable } from '../lib/ui.ts';

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

function listCard(ctx: Context, ui: Ui): string {
  const tabs = (['proposed', 'accepted', 'rejected', ''] as const)
    .map(
      (s) =>
        `<button class="tab ${ui.status === s ? 'active' : ''}" data-status="${s}" role="tab">${s === 'proposed' ? 'To review' : s === '' ? 'All' : s === 'accepted' ? 'Accepted' : 'Rejected'}</button>`,
    )
    .join('');
  const items = listing?.key === listKey(ctx) ? listing.items : null;
  const n = selected();
  const rows =
    items === null
      ? loadingState()
      : items
          .map(
            (
              i,
            ) => `<a class="review-row ${n === i.number ? 'sel' : ''}" href="${insightLink(i.number)}" data-insight="${i.number}">
              <span class="row gap-1_5 justify-between"><b>#${i.number} ${esc(i.title)}</b>${statusBadge(i.status)}</span>
              <span class="small muted">${i.kind === 'correlation' ? 'Correlation' : 'Signals'} · ${esc(i.author)} · ${esc(when(i.created_at))}</span>
            </a>`,
          )
          .join('') ||
        emptyState({
          illustration: ui.status === 'proposed' ? 'done' : 'inbox',
          compact: true,
          title: ui.status === 'proposed' ? 'Nothing waits for review' : 'No insights here yet',
          bodyHtml: `Save one from the <a href="#/correlate">correlation finder</a> or the <a href="#/explorer">Data explorer</a>.`,
        });
  const more =
    items && listing && listing.total > items.length
      ? `<p class="small soft">The newest ${items.length} of ${listing.total}.</p>`
      : '';
  return `<div class="card"><div class="tabs" role="tablist">${tabs}</div><div class="review-list" data-insight-list>${rows}</div>${more}</div>`;
}

function evidence(i: Insight): string {
  const e = i.evidence;
  if (i.query.kind === 'correlation' && e.result) {
    const r = e.result;
    const split = Boolean(i.query.split);
    const said = r.explanations.length
      ? `<ul class="stack gap-1">${r.explanations.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>`
      : '<p class="small soft">No large, clear effect.</p>';
    const shown =
      e.findings_total !== undefined && e.findings_total > r.findings.length
        ? `<p class="small soft">The ${r.findings.length} largest of ${e.findings_total} effects were kept.</p>`
        : '';
    return `<p class="small soft">${r.rows} batch(es) with an outcome: ${r.ng} failed, ${r.ok} good.</p>${said}${forestPlot(r.findings, split)}${shown}`;
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
    return `<div class="card">${emptyState({ illustration: 'select', title: 'Choose an insight' })}</div>`;
  if (detail?.key !== detailKey(ctx)) return `<div class="card">${loadingState()}</div>`;
  const i = detail.insight;
  if (!i)
    return `<div class="card">${emptyState({ illustration: 'error', alert: true, title: `Insight #${n} could not be loaded` })}</div>`;
  const may = mayDo(i, ctx.ontology.userId, ctx.ontology.role);
  const key = `${detailKey(ctx)}|${i.updated_at}`;
  const link = sourceLink(i);
  const head = `<div class="row justify-between items-start gap-3 wrap">
      <div><h2>#${i.number} ${esc(i.title)}</h2>
      <p class="small soft">Saved by ${esc(i.author)} on ${esc(when(i.created_at))}${i.updated_at !== i.created_at ? ` · changed ${esc(when(i.updated_at))}` : ''}</p></div>
      <div class="row gap-1_5">${statusBadge(i.status)}</div>
    </div>`;
  const body =
    editing?.key === key
      ? draftForm('insight-edit', editing.text, busy, 'Save changes')
      : `${i.summary ? `<p class="pre-wrap" data-summary>${esc(i.summary)}</p>` : ''}
        <div><h3>Proposed actions</h3>${
          i.actions.length
            ? `<ol data-actions>${i.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>`
            : '<p class="small soft">None proposed.</p>'
        }</div>`;
  const reviewed =
    i.status !== 'proposed' && i.reviewer
      ? `<p class="small" data-review>${i.status === 'accepted' ? 'Accepted' : 'Rejected'} by ${esc(i.reviewer)}${i.reviewed_at ? ` on ${esc(when(i.reviewed_at))}` : ''}${i.review_note ? `: “${esc(i.review_note)}”` : ''}</p>`
      : '';
  if (note.key !== key) note = { key, text: '' };
  const review = may.review
    ? `<form class="stack gap-2" id="insight-review">
        <label class="field">Review note <span class="small soft">(needed to reject)</span><textarea name="note" rows="2" maxlength="2000">${esc(note.text)}</textarea></label>
        <div class="row gap-2"><button class="btn primary" type="submit" data-decision="accepted" ${busy ? 'disabled' : ''}>Accept</button><button class="btn" type="submit" data-decision="rejected" ${busy ? 'disabled' : ''}>Reject</button></div>
      </form>`
    : '';
  const tools = [
    may.edit && editing?.key !== key ? `<button class="btn sm" type="button" data-edit>Edit</button>` : '',
    may.reopen ? `<button class="btn sm" type="button" data-reopen ${busy ? 'disabled' : ''}>Reopen</button>` : '',
    may.remove ? `<button class="btn sm" type="button" data-remove ${busy ? 'disabled' : ''}>Delete</button>` : '',
  ].join('');
  return `<div class="card stack gap-3" data-insight-detail>
      ${head}
      ${body}
      <div class="stack gap-1_5"><h3>Evidence</h3>
        <p class="small soft" data-source>${esc(sourceText(i))}, as it was on ${esc(when(i.created_at))}. <a href="${esc(link.href)}">${esc(link.text)}</a> to see it on today’s data.</p>
        ${evidence(i)}
      </div>
      ${reviewed}
      ${review}
      ${tools ? `<div class="row gap-2">${tools}</div>` : ''}
      <p class="small soft break-anywhere">Link: <a href="${insightLink(i.number)}" data-link>${esc(location.href.split('#')[0] ?? '')}${insightLink(i.number)}</a></p>
    </div>`;
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
  title: 'Insights',
  icon: 'lightbulb',
  crumbs(ctx) {
    const n = selected();
    return ctx.api && ctx.ontology.status === 'ready' && n !== null ? [{ label: `#${n}`, href: insightLink(n) }] : [];
  },
  render(ctx) {
    const head = pageHead({
      eyebrow: 'Data · Analysis',
      title: 'Insights',
      lead: 'Findings worth keeping: what was asked, the evidence it gave and what to do about it, reviewed by another engineer.',
    });
    if (!ctx.api) return `${head}<div class="card">${needsApi(`Insights are kept by the Tiles API.`)}</div>`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}<div class="card">Loading from the Tiles API…</div>`;
    if (o.status !== 'ready')
      return `${head}${apiUnreachable(o.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })}`;
    return `${head}<div class="reviews">${listCard(ctx, uiState(ctx))}${detailCard(ctx)}</div>`;
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
        if (draft) void act(ctx, (site, num) => api.insights.edit(site, num, draft), 'Insight saved');
      });
    }
    root.querySelector<HTMLTextAreaElement>('#insight-review [name=note]')?.addEventListener('input', (e) => {
      note.text = (e.target as HTMLTextAreaElement).value;
    });
    onSubmit(root, '#insight-review', (_form, submitter) => {
      const decision = submitter?.dataset.decision;
      if (decision !== 'accepted' && decision !== 'rejected') return;
      if (decision === 'rejected' && !note.text.trim()) return void ctx.toast('Say why the insight is rejected');
      const text = note.text.trim();
      void act(
        ctx,
        (site, num) => api.insights.review(site, num, decision, text),
        decision === 'accepted' ? 'Insight accepted' : 'Insight rejected',
      );
    });
    onAll(
      root,
      '[data-reopen]',
      'click',
      () => void act(ctx, (site, num) => api.insights.reopen(site, num), 'Insight reopened'),
    );
    onAll(root, '[data-remove]', 'click', async () => {
      const yes = await confirmDialog({
        title: `Delete insight #${i.number}?`,
        body: `${i.title}, its evidence and its review are deleted for good.`,
        confirm: 'Delete',
        tone: 'danger',
      });
      // The dialog doesn't block the page: if another insight opened meanwhile, delete nothing.
      if (yes && selected() === i.number)
        void act(ctx, (site, num) => api.insights.remove(site, num), 'Insight deleted');
    });
  },
};

export default view;
