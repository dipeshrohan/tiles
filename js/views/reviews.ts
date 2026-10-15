import { esc, need, onAll, timeAgo, onNavigate, routeOf, bound } from '../lib/dom.ts';
import { describeChanges } from '../lib/review.ts';
import type { Review, ReviewStatus, ReviewSummary } from '../lib/api.ts';
import type { DiffStats } from '../lib/types.ts';
import { showHistory } from './ontology.ts';
import type { Context, View } from './types.ts';
import { listKeys, recordFromHash, rowClicks, split } from '../lib/split.ts';
import { showHash } from '../lib/url-state.ts';
import { ApiError } from '../lib/api.ts';
import { emptyState, errorState, needsApi, pageHead, skeleton, apiUnreachable } from '../lib/ui.ts';
import { bindTable, dataTable, type TableOptions } from '../lib/data-table.ts';

// Change reviews (T2.12): ontology changes another engineer approves (which
// commits them) or rejects, with the diff and a comment thread. Requests are
// made from the Ontology page's staged changes; this page is where they are read
// and decided. Shared through the Tiles API, so it needs API mode.

interface Ui {
  state: 'open' | 'closed';
  selected: number | null;
  site: string | null; // the site `selected` is a request of
}

const uiState = (ctx: Context) => ctx.ui<Ui>('reviews', { state: 'open', selected: null, site: null });

// Fetched lists and the selected request, for the site and tab they were fetched for.
let listing: { key: string; items: ReviewSummary[] | null } | null = null;
let detail: { key: string; review: Review } | null = null;
let listSeq = 0;
let detailSeq = 0;
let detailFailed: string | null = null; // the request (site|number) whose load failed: Try again
let busy = false; // an action is on its way; the buttons wait
let draft = { key: '', text: '' }; // the comment being written, kept across re-renders

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;

// Others request, approve and reject while you are elsewhere: each visit to the page fetches afresh.
// The change request open is the one the address names, #/reviews/<number> (U3.08: a link, Back
// and a reload show it; the copilot links its proposals so); #/reviews is the list alone.
const linked = (hash: string): number | null => recordFromHash('reviews', hash);
const reviewLink = (n: number | null): string => (n === null ? '#/reviews' : `#/reviews/${n}`);
// The page's state follows the address (and a number is another site's after a switch).
function sync(ctx: Context): void {
  const ui = uiState(ctx);
  const site = siteId(ctx);
  // Another site: the number open was the last site's, so back to the list (not its namesake here).
  if (ui.site !== null && ui.site !== site && linked(location.hash) !== null) showHash(reviewLink(null));
  ui.site = site;
  ui.selected = linked(location.hash);
}

const COPILOT_BADGE =
  '<span class="badge accent" title="The copilot wrote these changes for its author; another engineer must approve them">✦ Proposed by the copilot</span>';

onNavigate((hash) => {
  if (routeOf(hash) !== 'reviews') {
    listing = null;
    detail = null;
    detailFailed = null;
  }
});
const listKey = (ctx: Context): string => `${siteId(ctx)}|${uiState(ctx).state}`;
const detailKey = (ctx: Context): string => `${siteId(ctx)}|${uiState(ctx).selected}`;

const STATUS: Record<ReviewStatus, [string, string]> = {
  open: ['warn', 'Waiting for review'],
  approved: ['good', 'Approved'],
  rejected: ['bad', 'Rejected'],
  withdrawn: ['', 'Withdrawn'],
};

function statusBadge(status: ReviewStatus): string {
  const [cls, text] = STATUS[status];
  return `<span class="badge ${cls}">${text}</span>`;
}

function stats(s: DiffStats): string {
  const part = (n: number, what: string) =>
    n ? `<span class="${n > 0 ? 'plus' : 'minus'}">${n > 0 ? '+' : '−'}${Math.abs(n)}</span> ${what}` : '';
  return [part(s.nodes, 'node'), part(s.edges, 'edge'), part(s.props, 'prop')].filter(Boolean).join(' · ');
}

// Whether you may approve or reject it (the API checks the same).
export function mayDecide(
  r: Pick<ReviewSummary, 'status' | 'author_id' | 'reviewer_id'>,
  me: string | null,
  role: string | null,
): boolean {
  if (r.status !== 'open' || role === null || role === 'viewer' || r.author_id === me) return false;
  return r.reviewer_id === null || r.reviewer_id === me || role === 'admin';
}

const REVIEW_RANK: Record<string, number> = { open: 0, approved: 1, rejected: 2, withdrawn: 3 };

// The change requests as a table (U5.02): each one's link opens it beside the list.
function listTable(ctx: Context, ui: Ui, items: ReviewSummary[]): TableOptions<ReviewSummary> {
  return {
    id: 'reviews',
    label: 'Change requests',
    columns: [
      {
        key: 'request',
        label: 'Change request',
        value: (r) => r.number,
        csv: (r) => `#${r.number} ${r.message}`,
        cell: (r) =>
          `<a class="row-open" href="${reviewLink(r.number)}"${ui.selected === r.number ? ' aria-current="true"' : ''}>#${r.number} ${esc(r.message)}</a>`,
      },
      {
        key: 'status',
        label: 'Status',
        value: (r) => REVIEW_RANK[r.status] ?? 9,
        csv: (r) => r.status,
        cell: (r) => statusBadge(r.status),
      },
      {
        key: 'author',
        label: 'Author',
        value: (r) => r.author,
        csv: (r) => r.author,
        cell: (r) => `${r.source === 'copilot' ? `${COPILOT_BADGE} ` : ''}${esc(r.author)}`,
      },
      {
        key: 'created',
        label: 'Sent',
        value: (r) => r.created_at,
        csv: (r) => r.created_at,
        cell: (r) => esc(timeAgo(r.created_at)),
      },
      { key: 'reviewer', label: 'Reviewer', value: (r) => r.reviewer, cell: (r) => esc(r.reviewer ?? 'Anyone') },
      { key: 'comments', label: 'Comments', numeric: true, value: (r) => r.comments, cell: (r) => String(r.comments) },
      { key: 'changes', label: 'Changes', cell: (r) => stats(r.stats) },
    ],
    rows: items,
    key: (r) => String(r.number),
    empty: '',
    rowAttrs: (r) => ({ 'data-review': r.number, class: ui.selected === r.number ? 'sel' : undefined }),
    csv: 'change-requests.csv',
  };
}

function listCard(ctx: Context, ui: Ui): string {
  const tabs = (['open', 'closed'] as const)
    .map(
      (s) =>
        `<button class="tab ${ui.state === s ? 'active' : ''}" data-state="${s}" role="tab">${s === 'open' ? 'Open' : 'Closed'}</button>`,
    )
    .join('');
  const items = listing?.key === listKey(ctx) ? listing.items : null;
  const empty =
    ui.state === 'open'
      ? emptyState({
          illustration: 'done',
          compact: true,
          title: 'Nothing waits for a review',
          bodyHtml: 'Send staged changes from the <a href="#/ontology">Ontology</a> page.',
        })
      : emptyState({
          illustration: 'inbox',
          compact: true,
          title: 'No closed change requests yet',
          body: 'Requests that were approved or rejected are kept here, with their discussion.',
        });
  const rows = items === null ? skeleton.list() : items.length ? dataTable(listTable(ctx, ui, items)) : empty;
  return `<div class="card"><div class="tabs" role="tablist">${tabs}</div><div data-review-list>${rows}</div></div>`;
}

function detailCard(ctx: Context, ui: Ui): string {
  if (ui.selected === null)
    return `<div class="card">${emptyState({ illustration: 'select', title: 'Select a change request', body: 'Its changes, discussion and decision show here.' })}</div>`;
  const r = detail?.key === detailKey(ctx) ? detail.review : null;
  if (!r && detailFailed === detailKey(ctx))
    return `<div class="card">${errorState({ title: 'The change request could not be loaded', body: 'The Tiles API didn’t send it (the notice says why). Try again; if it keeps failing, check the connection in Settings.', retry: 'retry-review', compact: true })}</div>`;
  if (!r) return `<div class="card" data-review-detail>${skeleton.card()}</div>`;
  const o = ctx.ontology;
  const open = r.status === 'open';
  const changes = describeChanges(ctx.state.repo.head, r.ops, { compare: open });
  const shown = changes.slice(0, 200);
  const diff = shown
    .map(
      (c) =>
        `<div class="change ${c.sign === '+' ? 'plus' : c.sign === '−' ? 'minus' : 'mod'}"><span class="sign">${c.sign}</span> ${esc(c.text)}${c.problem ? ` <span class="badge bad" title="${esc(c.problem)}">doesn't apply</span>` : ''}</div>`,
    )
    .join('');
  const thread = r.thread
    .map(
      (c) => `
      <div class="comment">
        <div class="small muted"><b>${esc(c.author)}</b> · ${timeAgo(c.created_at)}${c.verdict ? ` ${statusBadge(c.verdict)}` : ''}</div>
        ${c.body ? `<div class="comment-body">${esc(c.body)}</div>` : ''}
      </div>`,
    )
    .join('');
  const canWrite = o.role !== null && o.role !== 'viewer';
  const decide = mayDecide(r, o.userId, o.role);
  const mine = r.author_id !== null && r.author_id === o.userId;
  const outcome =
    r.status === 'approved' && r.commit_id
      ? `<p class="small">Committed as <a class="mono" href="#/ontology" data-history>${esc(r.commit_id.slice(-7))}</a> by ${esc(r.decided_by)} ${r.decided_at ? timeAgo(r.decided_at) : ''}.</p>`
      : r.status !== 'open'
        ? `<p class="small soft">${STATUS[r.status][1]} by ${esc(r.decided_by)} ${r.decided_at ? timeAgo(r.decided_at) : ''}.</p>`
        : '';
  const waiting =
    open && !decide && canWrite && !mine && r.reviewer
      ? `<p class="small soft">Waiting for ${esc(r.reviewer)} (or an admin) to review it.</p>`
      : '';
  return `
    <div class="card" data-review-detail>
      <div class="card-head"><div>
        ${statusBadge(r.status)}${r.source === 'copilot' ? ` ${COPILOT_BADGE}` : ''}
        <h2 class="mt-1_5">#${r.number} ${esc(r.message)}</h2>
        <div class="small muted">${esc(r.author)} · ${timeAgo(r.created_at)} · ${r.reviewer ? `review by ${esc(r.reviewer)}` : 'any engineer may review'}${r.reverts ? ` · reverts <span class="mono">${esc(r.reverts.slice(-7))}</span>` : ''}</div>
      </div></div>
      ${outcome}
      ${open && r.conflict ? `<div class="alert" role="alert"><b>This change no longer fits the ontology</b>: ${esc(r.conflict)}. It can't be approved; its author can rework it.</div>` : ''}
      <h3 class="mt-3 mb-1_5 m-0">Changes <span class="small soft">${stats(r.stats)}</span></h3>
      <div class="diff review-diff">${diff}${changes.length > shown.length ? `<div>… ${changes.length - shown.length} more</div>` : ''}</div>
      <h3 class="mt-4 mb-1_5 m-0">Discussion</h3>
      <div class="thread">${thread || `<p class="small muted">No comments yet.${canWrite ? ' Ask a question or note what to change below; the author sees it here.' : ''}</p>`}</div>
      ${waiting}
      ${
        canWrite
          ? `<form class="stack gap-2 mt-2_5" id="review-form">
        <textarea name="comment" rows="3" maxlength="4000" placeholder="${decide ? 'A comment, or why you approve or reject it' : 'A comment'}" aria-label="Comment">${draft.key === detailKey(ctx) ? esc(draft.text) : ''}</textarea>
        <fieldset class="row gap-2 border-0 p-0 m-0" ${busy ? 'disabled' : ''}>
          <button class="btn" type="button" data-act="comment">Comment</button>
          ${decide ? '<button class="btn primary" type="button" data-act="approve" ' + (r.conflict ? 'disabled title="It no longer fits the ontology"' : '') + '>Approve and commit</button><button class="btn danger" type="button" data-act="reject">Reject</button>' : ''}
          ${reworkButton(r, mine)}
        </fieldset>
      </form>`
          : ''
      }
    </div>`;
}

// The author takes a request back: into their staged changes, or (a revert) just withdrawn.
function reworkButton(r: Review, mine: boolean): string {
  if (!mine || r.status === 'approved' || (r.reverts && r.status !== 'open')) return '';
  const label = r.reverts ? 'Withdraw' : r.status === 'open' ? 'Withdraw and rework' : 'Rework';
  return `<button class="btn" type="button" data-act="rework">${label}</button>`;
}

function policyCard(ctx: Context): string {
  const o = ctx.ontology;
  const text = o.reviewRequired
    ? 'Every ontology change on this site needs another engineer’s approval before it is committed.'
    : 'Engineers commit directly, or ask for a review when they want one.';
  return `<div class="card source-bar small">
      <span>${text}</span>
      <span class="row gap-3">${o.role === 'admin' ? `<label class="row gap-1_5"><input type="checkbox" data-policy ${o.reviewRequired ? 'checked' : ''} /> Require a review for every change</label>` : ''}<button class="btn sm" data-refresh-reviews>Refresh</button></span>
    </div>`;
}

async function fetchList(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const key = listKey(ctx);
  const seq = ++listSeq;
  listing = { key, items: null };
  try {
    const items = await ctx.api.reviews.list(site, uiState(ctx).state);
    if (seq === listSeq) listing = { key, items };
  } catch {
    if (seq === listSeq) listing = { key, items: [] }; // the client showed why
  }
  if (seq === listSeq) ctx.rerender();
}

async function fetchDetail(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  const n = uiState(ctx).selected;
  if (!ctx.api || !site || n === null) return;
  const key = detailKey(ctx);
  const seq = ++detailSeq;
  try {
    const review = await ctx.api.reviews.get(site, n);
    if (seq !== detailSeq) return;
    detail = { key, review };
    detailFailed = null;
  } catch (e) {
    if (seq !== detailSeq) return;
    // Not there (gone, or another site's number): the address goes back to the list. Any other
    // failure keeps the record named, to try again.
    if (e instanceof ApiError && e.status === 404) {
      if (linked(location.hash) === n) showHash(reviewLink(null));
    } else detailFailed = key;
  }
  ctx.rerender();
}

async function act(ctx: Context, action: string, comment: string): Promise<void> {
  const site = siteId(ctx);
  const r = detail?.review;
  if (!ctx.api || !site || !r || busy) return;
  const reviews = ctx.api.reviews;
  const calls: Record<string, () => Promise<Review>> = {
    comment: () => reviews.comment(site, r.number, comment),
    approve: () => reviews.approve(site, r.number, comment),
    reject: () => reviews.reject(site, r.number, comment),
    rework: () => reviews.rework(site, r.number),
  };
  const call = calls[action];
  if (!call) return;
  busy = true;
  ctx.rerender();
  try {
    const review = await call();
    detail = { key: `${site}|${review.number}`, review };
    draft = { key: '', text: '' };
    if (action === 'comment') ctx.toast('Comment added');
    if (action === 'approve') ctx.toast(`#${r.number} approved and committed`);
    if (action === 'reject') ctx.toast(`#${r.number} rejected`);
    if (action !== 'comment') {
      listing = null; // it moved between the tabs
      await ctx.ontology.reload(); // a new commit, or the changes back in your staged ones
    }
    if (action === 'rework' && r.reverts) ctx.toast(`#${r.number} withdrawn`);
    else if (action === 'rework') {
      ctx.toast('Back in your staged changes: edit them, then send them again');
      location.hash = '#/ontology';
    }
  } catch {
    // The client showed why; show the request as it is now.
    detail = null;
    listing = null;
  } finally {
    busy = false;
    ctx.rerender();
  }
}

const view: View = {
  id: 'reviews',
  title: 'Change reviews',
  icon: 'git-pull-request',
  crumbs(ctx) {
    const n = uiState(ctx).selected;
    return ctx.api && ctx.ontology.status === 'ready' && n !== null ? [{ label: `#${n}`, href: `#/reviews/${n}` }] : [];
  },
  render(ctx) {
    const head = pageHead({
      eyebrow: 'Operations · Ontology',
      title: 'Change reviews',
      lead: 'Ontology changes waiting for a second engineer: read the diff, discuss it, then approve (which commits it) or reject it.',
    });
    if (!ctx.api)
      return `${head}<div class="card">${needsApi(`Change reviews are shared by everyone on a site, so they need the Tiles API. In this browser’s own ontology you commit directly.`)}</div>`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}<div class="card">${skeleton.card('Loading from the Tiles API…')}</div>`;
    if (o.status !== 'ready')
      return `${head}${apiUnreachable(o.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })}`;
    sync(ctx);
    const ui = uiState(ctx);
    return `${head}${policyCard(ctx)}${split(listCard(ctx, ui), detailCard(ctx, ui), {
      open: ui.selected !== null,
      back: reviewLink(null),
      label: 'change requests',
    })}`;
  },
  bind(root, ctx) {
    if (!ctx.api || ctx.ontology.status !== 'ready') return;
    const ui = uiState(ctx);
    sync(ctx);
    if (listing?.key !== listKey(ctx)) void fetchList(ctx);
    if (ui.selected !== null && detail?.key !== detailKey(ctx) && detailFailed !== detailKey(ctx))
      void fetchDetail(ctx);
    onAll(root, '[data-retry-review]', 'click', () => {
      detailFailed = null;
      ctx.rerender();
    });

    onAll(root, '[data-state]', 'click', (el) => {
      ui.state = el.dataset.state === 'closed' ? 'closed' : 'open';
      ctx.rerender();
    });
    const items = listing?.key === listKey(ctx) ? listing.items : null;
    if (items?.length) bindTable(root, listTable(ctx, ui, items));
    rowClicks(root, '[data-review-list]', '[data-review]');
    listKeys(
      root,
      '[data-review-list] [data-review]',
      (row) => row.getAttribute('data-review') === String(ui.selected),
    );
    onAll(root, '[data-history]', 'click', () => showHistory(ctx));
    onAll(root, '[data-refresh-reviews]', 'click', () => {
      listing = null;
      detail = null;
      void ctx.ontology.reload();
      ctx.rerender();
    });
    root.querySelector<HTMLTextAreaElement>('#review-form textarea')?.addEventListener(
      'input',
      (e) => {
        draft = { key: detailKey(ctx), text: (e.target as HTMLTextAreaElement).value };
      },
      { signal: bound() },
    );
    onAll(root, '[data-policy]', 'change', (el) => {
      const site = siteId(ctx);
      const required = (el as HTMLInputElement).checked;
      if (!ctx.api || !site) return;
      void ctx.api.ontology
        .setReviewPolicy(site, required)
        .then(() => ctx.toast(required ? 'Every change now needs a review' : 'Reviews are optional again'))
        .catch(() => undefined)
        .finally(() => void ctx.ontology.reload());
    });
    onAll(root, '[data-act]', 'click', (el) => {
      const form = need<HTMLFormElement>(root, '#review-form');
      const box = need<HTMLTextAreaElement>(form, 'textarea');
      const action = el.dataset.act ?? '';
      const comment = box.value.trim();
      if (action === 'comment' && !comment) return void box.focus();
      if (action === 'reject' && !comment) {
        ctx.toast('Say why you reject it, so its author knows what to change');
        return void box.focus();
      }
      void act(ctx, action, comment);
    });
  },
};

export default view;
