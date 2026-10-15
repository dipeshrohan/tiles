// Saved insights (T3.12), apart from the page: the save form shared by the correlation finder and
// the Data explorer, what an insight's query says in words, where it links back to, and who may do
// what with it (the API checks the same).

import type { CorrelationResult, Insight, InsightDraft, InsightStatus, InsightSummary } from './api.ts';
import { esc, bound } from './dom.ts';
import { t, type MessageKey } from './i18n.ts';

export const MAX_ACTIONS = 20;

// The form's text, as typed: actions one per line.
export interface DraftText {
  title: string;
  summary: string;
  actions: string;
}

export const STATUS: Record<InsightStatus, [string, MessageKey]> = {
  proposed: ['warn', 'insights.status.proposed'],
  accepted: ['good', 'insights.status.accepted'],
  rejected: ['bad', 'insights.status.rejected'],
};

export function statusBadge(status: InsightStatus): string {
  const [cls, text] = STATUS[status];
  return `<span class="badge ${cls}">${esc(t(text))}</span>`;
}

// One action per line, blank lines left out; a string says why not.
export function parseActions(text: string): string[] | string {
  const actions = text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
  if (actions.length > MAX_ACTIONS) return t('insights.atMostActions', { max: MAX_ACTIONS });
  if (actions.some((a) => a.length > 500)) return t('insights.actionTooLong');
  return actions;
}

// The draft as the API takes it; a string says what to fix.
export function readDraft(text: DraftText): InsightDraft | string {
  const title = text.title.trim();
  if (!title) return t('insights.needTitle');
  if (title.length > 200) return t('insights.titleTooLong');
  if (text.summary.length > 5000) return t('insights.summaryTooLong');
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
    ? t(top.segment === 'all' ? 'insights.draft.title' : 'insights.draft.titleSegment', {
        variable: top.variable,
        segment: top.segment,
      })
    : t('insights.draft.noEffect', { dataset });
  const summary = [
    t('insights.draft.summary', { dataset, rows: r.rows, ng: r.ng }),
    ...r.explanations.map((e) => e.text),
  ].join('\n');
  return { title: title.slice(0, 200), summary, actions: '' };
}

export function seriesDraft(tags: string[], from: string, to: string): DraftText {
  return {
    title: `${tags.join(', ')}`.slice(0, 200),
    summary: t('insights.draft.range', { from: when(from), to: when(to) }),
    actions: '',
  };
}

export const when = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

// The form to save (or edit) an insight. `id` tells the page's forms apart.
export function draftForm(id: string, text: DraftText, busy: boolean, submit = t('insights.form.save')): string {
  return `<form class="stack insight-form gap-2" id="${esc(id)}">
      <label class="field">${esc(t('insights.form.title'))}<input type="text" name="title" maxlength="200" value="${esc(text.title)}"></label>
      <label class="field">${esc(t('insights.form.summary'))}<textarea name="summary" rows="3" maxlength="5000">${esc(text.summary)}</textarea></label>
      <label class="field">${esc(t('insights.form.actions'))} <span class="small soft">${esc(t('insights.form.onePerLine'))}</span><textarea name="actions" rows="3" placeholder="${esc(t('insights.form.actionsPlaceholder'))}">${esc(text.actions)}</textarea></label>
      <div class="row gap-2"><button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${esc(submit)}</button><button class="btn" type="button" data-cancel>${esc(t('insights.form.cancel'))}</button></div>
    </form>`;
}

// Keeps what is typed in a draft form in `text` as it is typed, so a re-render never loses it.
export function bindDraft(form: HTMLFormElement, text: DraftText): void {
  form.addEventListener(
    'input',
    (e) => {
      const el = e.target as HTMLInputElement | HTMLTextAreaElement;
      if (el.name === 'title' || el.name === 'summary' || el.name === 'actions') text[el.name] = el.value;
    },
    { signal: bound() },
  );
}

// What produced the evidence, in words.
export function sourceText(i: Pick<Insight, 'query' | 'evidence'>): string {
  const q = i.query;
  if (q.kind === 'correlation') {
    const name = i.evidence.dataset?.name ?? t('insights.source.aDataset');
    const failed = q.ng_values?.length ? q.ng_values.map(String).join(', ') : 'true';
    const parts = [t('insights.source.correlation', { name, outcome: q.outcome, failed })];
    if (q.split) parts.push(t('insights.source.split', { split: q.split }));
    parts.push(
      q.variables?.length
        ? t('insights.source.variables', { list: q.variables.join(', ') })
        : t('insights.source.everyNumber'),
    );
    return parts.join(', ');
  }
  const tags = i.evidence.series?.map((s) => s.tag) ?? [];
  return t('insights.source.series', {
    what: tags.length ? tags.join(', ') : t('insights.source.signals', { count: q.signals.length }),
    start: when(q.start),
    end: when(q.end),
  });
}

// Where to ask the same question again, on today's data.
export function sourceLink(i: Pick<Insight, 'query'>): { href: string; text: string } {
  const q = i.query;
  if (q.kind === 'correlation')
    return { href: `#/correlate?dataset=${encodeURIComponent(q.dataset_id)}`, text: t('insights.link.correlate') };
  const params = new URLSearchParams({ signals: q.signals.join(','), from: q.start, to: q.end });
  return { href: `#/explorer?${params.toString()}`, text: t('insights.link.explorer') };
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
