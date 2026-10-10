// Saved insights (T3.12), apart from the page: the save form shared by the correlation finder and
// the Data explorer, what an insight's query says in words, where it links back to, and who may do
// what with it (the API checks the same).

import type { CorrelationResult, Insight, InsightDraft, InsightStatus, InsightSummary } from './api.ts';
import { esc } from './dom.ts';

export const MAX_ACTIONS = 20;

// The form's text, as typed: actions one per line.
export interface DraftText {
  title: string;
  summary: string;
  actions: string;
}

export const STATUS: Record<InsightStatus, [string, string]> = {
  proposed: ['warn', 'Waiting for review'],
  accepted: ['good', 'Accepted'],
  rejected: ['bad', 'Rejected'],
};

export function statusBadge(status: InsightStatus): string {
  const [cls, text] = STATUS[status];
  return `<span class="badge ${cls}">${text}</span>`;
}

// One action per line, blank lines left out; a string says why not.
export function parseActions(text: string): string[] | string {
  const actions = text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
  if (actions.length > MAX_ACTIONS) return `At most ${MAX_ACTIONS} actions`;
  if (actions.some((a) => a.length > 500)) return 'Keep each action to 500 characters';
  return actions;
}

// The draft as the API takes it; a string says what to fix.
export function readDraft(text: DraftText): InsightDraft | string {
  const title = text.title.trim();
  if (!title) return 'Give the insight a title';
  if (title.length > 200) return 'Keep the title to 200 characters';
  if (text.summary.length > 5000) return 'Keep the summary to 5,000 characters';
  const actions = parseActions(text.actions);
  if (typeof actions === 'string') return actions;
  return { title, summary: text.summary.trim(), actions };
}

export const draftText = (d: Pick<InsightDraft, 'title' | 'summary' | 'actions'>): DraftText => ({
  title: d.title,
  summary: d.summary,
  actions: d.actions.join('\n'),
});

// A first draft from a correlation: its strongest clear effect, and what was found.
export function correlationDraft(dataset: string, r: CorrelationResult): DraftText {
  const top = r.explanations[0];
  const title = top
    ? `${top.variable} separates failed batches${top.segment === 'all' ? '' : ` (${top.segment})`}`
    : `No clear effect in ${dataset}`;
  const summary = [`${dataset}: ${r.rows} batch(es), ${r.ng} failed.`, ...r.explanations.map((e) => e.text)].join('\n');
  return { title: title.slice(0, 200), summary, actions: '' };
}

export function seriesDraft(tags: string[], from: string, to: string): DraftText {
  return {
    title: `${tags.join(', ')}`.slice(0, 200),
    summary: `From ${when(from)} to ${when(to)}.`,
    actions: '',
  };
}

export const when = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

// The form to save (or edit) an insight. `id` tells the page's forms apart.
export function draftForm(id: string, text: DraftText, busy: boolean, submit = 'Save insight'): string {
  return `<form class="stack insight-form gap-2" id="${esc(id)}">
      <label class="field">Title<input type="text" name="title" maxlength="200" value="${esc(text.title)}"></label>
      <label class="field">Summary<textarea name="summary" rows="3" maxlength="5000">${esc(text.summary)}</textarea></label>
      <label class="field">Proposed actions <span class="small soft">(one per line)</span><textarea name="actions" rows="3" placeholder="e.g. Lower anode tension to 1,000 N for a week">${esc(text.actions)}</textarea></label>
      <div class="row gap-2"><button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${esc(submit)}</button><button class="btn" type="button" data-cancel>Cancel</button></div>
    </form>`;
}

// Keeps what is typed in a draft form in `text` as it is typed, so a re-render never loses it.
export function bindDraft(form: HTMLFormElement, text: DraftText): void {
  form.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement;
    if (el.name === 'title' || el.name === 'summary' || el.name === 'actions') text[el.name] = el.value;
  });
}

// What produced the evidence, in words.
export function sourceText(i: Pick<Insight, 'query' | 'evidence'>): string {
  const q = i.query;
  if (q.kind === 'correlation') {
    const name = i.evidence.dataset?.name ?? 'a dataset';
    const failed = q.ng_values?.length ? q.ng_values.map(String).join(', ') : 'true';
    const parts = [`Correlation of ${name}: outcome ${q.outcome} (failed when ${failed})`];
    if (q.split) parts.push(`split by ${q.split}`);
    parts.push(q.variables?.length ? `variables ${q.variables.join(', ')}` : 'every number column');
    return parts.join(', ');
  }
  const tags = i.evidence.series?.map((s) => s.tag) ?? [];
  return `${tags.length ? tags.join(', ') : `${q.signals.length} signal(s)`} from ${when(q.start)} to ${when(q.end)}`;
}

// Where to ask the same question again, on today's data.
export function sourceLink(i: Pick<Insight, 'query'>): { href: string; text: string } {
  const q = i.query;
  if (q.kind === 'correlation')
    return { href: `#/correlate?dataset=${encodeURIComponent(q.dataset_id)}`, text: 'Open in the correlation finder' };
  const params = new URLSearchParams({ signals: q.signals.join(','), from: q.start, to: q.end });
  return { href: `#/explorer?${params.toString()}`, text: 'Open in the Data explorer' };
}

export const insightLink = (n: number): string => `#/insights/${n}`;

// The insight number in `#/insights/<n>`, if any.
export function numberFromHash(hash: string): number | null {
  const m = hash.match(/^#\/insights\/(\d+)(?:[?/]|$)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

type Role = 'viewer' | 'engineer' | 'admin' | null;

// What you may do with an insight (the API checks the same).
export function mayDo(
  i: Pick<InsightSummary, 'status' | 'author_id'>,
  me: string | null,
  role: Role,
): { review: boolean; edit: boolean; reopen: boolean; remove: boolean } {
  // Until you are known (`me` null), only an admin's rights don't depend on who wrote it.
  const editor = role === 'engineer' || role === 'admin';
  const owner = editor && ((me !== null && i.author_id === me) || role === 'admin');
  return {
    review: editor && me !== null && i.status === 'proposed' && i.author_id !== me,
    edit: owner && i.status === 'proposed',
    reopen: owner && i.status !== 'proposed',
    remove: owner,
  };
}
