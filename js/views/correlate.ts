import { esc, fmt, onAll, onSubmit, onNavigate, routeOf } from '../lib/dom.ts';
import { detectDelimiter, parseCsv } from '../lib/csv.ts';
import { forestPlot, inferColumns, parseNgValues, typedRows } from '../lib/datasets.ts';
import type { CorrelationResult, Dataset, DatasetValue, InsightSource } from '../lib/api.ts';
import { bindDraft, correlationDraft, draftForm, insightLink, readDraft, type DraftText } from '../lib/insights.ts';
import type { Context, View } from './types.ts';
import { confirmDialog } from '../lib/overlay.ts';
import { emptyState, loadingState, needsApi, pageHead, apiUnreachable } from '../lib/ui.ts';

// The correlation finder (T3.11): which settings separate failed batches from good ones, on real
// batch tables kept by the Tiles API. Upload a CSV (one row per batch), choose the outcome and what
// failed means, the variables and a split (material, line, shift…), and read each effect (Cohen's
// d) with its 95% confidence interval. The Process & quality page shows the same on demo data.

interface Ui {
  selected: string | null;
  outcome: string;
  ngText: string;
  variables: string[] | null; // null: every number column
  split: string; // '' for none
}

const uiState = (ctx: Context) =>
  ctx.ui<Ui>('correlate', { selected: null, outcome: '', ngText: '', variables: null, split: '' });

let listing: { site: string; items: Dataset[] | null } | null = null;
let detail: { id: string; data: Dataset & { preview: Record<string, DatasetValue>[] } } | null = null;
let result: { key: string; data: CorrelationResult; split: boolean; source: InsightSource; dataset: string } | null =
  null;
let saving: { key: string; text: DraftText } | null = null; // the insight being saved from the result
let busy = '';
let upload: { done: number; total: number } | null = null;
// The file and name chosen for upload, kept across re-renders (a file input can't be refilled).
let chosen: { file: File | null; name: string } = { file: null, name: '' };

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;
const resultKey = (ctx: Context): string => JSON.stringify({ site: siteId(ctx), ...uiState(ctx) });

onNavigate((hash) => {
  if (routeOf(hash) !== 'correlate') {
    listing = null;
    detail = null;
  }
});

async function loadList(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  listing = { site, items: null };
  try {
    const items = await ctx.api.datasets.list(site);
    if (listing?.site === site) listing = { site, items };
  } catch {
    if (listing?.site === site) listing = { site, items: [] };
  }
  ctx.rerender();
}

async function loadDetail(ctx: Context, id: string): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  try {
    const data = await ctx.api.datasets.get(site, id);
    if (uiState(ctx).selected === id) detail = { id, data };
  } catch {
    if (uiState(ctx).selected === id) uiState(ctx).selected = null;
  }
  ctx.rerender();
}

function listCard(ctx: Context, ui: Ui): string {
  const canEdit = ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';
  const items = listing?.items;
  const rows =
    items === null || items === undefined
      ? loadingState()
      : items
          .map(
            (d) => `<button class="review-row ${ui.selected === d.id ? 'sel' : ''}" data-dataset="${esc(d.id)}">
              <b>${esc(d.name)}</b>
              <span class="small muted">${fmt(d.row_count, 0)} batch(es) · ${d.columns.length} column(s)${d.created_by ? ` · ${esc(d.created_by)}` : ''}</span>
            </button>`,
          )
          .join('') || emptyState({ compact: true, title: 'No batch tables yet', body: 'Upload one below.' });
  const form = canEdit
    ? `<form class="stack gap-2 mt-3" id="dataset-form">
        <h3>Upload a batch table</h3>
        <p class="small soft">A CSV with one row per batch: its settings and measurements, and a column saying whether it failed.</p>
        <label class="field">CSV file<input type="file" name="file" accept=".csv,text/csv,text/plain"></label>
        ${chosen.file ? `<p class="small" data-chosen-file>Chosen: ${esc(chosen.file.name)}</p>` : ''}
        <label class="field">Name<input type="text" name="name" maxlength="200" value="${esc(chosen.name)}" placeholder="e.g. Cutter batches, September"></label>
        <div><button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${upload ? `Uploading ${fmt(upload.done, 0)} of ${fmt(upload.total, 0)}…` : 'Upload'}</button></div>
      </form>`
    : '';
  return `<div class="card"><div class="review-list" data-dataset-list>${rows}</div>${form}</div>`;
}

function analysisCard(ctx: Context, ui: Ui): string {
  if (!ui.selected)
    return `<div class="card">${emptyState({ illustration: 'chart', title: 'Choose a batch table', body: 'Or upload one: its settings are compared between good and failed batches.' })}</div>`;
  const d = detail?.id === ui.selected ? detail.data : null;
  if (!d) return `<div class="card">${loadingState()}</div>`;
  const numbers = d.columns.filter((c) => c.kind === 'number').map((c) => c.name);
  const outcome =
    d.columns.find((c) => c.name === ui.outcome) ?? d.columns.find((c) => c.kind === 'bool') ?? d.columns[0];
  const checked = new Set(ui.variables ?? numbers.filter((n) => n !== outcome?.name));
  const option = (name: string, current: string) =>
    `<option value="${esc(name)}" ${name === current ? 'selected' : ''}>${esc(name)}</option>`;
  const preview = d.preview.length
    ? `<details><summary class="small">The first ${d.preview.length} batch(es)</summary><div class="table-wrap"><table class="small"><thead><tr>${d.columns.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${d.preview
        .map(
          (r) =>
            `<tr>${d.columns.map((c) => `<td>${esc(r[c.name] === null || r[c.name] === undefined ? '' : String(r[c.name]))}</td>`).join('')}</tr>`,
        )
        .join('')}</tbody></table></div></details>`
    : '';
  const r = result?.key === resultKey(ctx) ? result : null;
  const canEdit = ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';
  return `<div class="card stack gap-3" data-analysis>
      <div class="row justify-between items-start gap-3">
        <div><h2>${esc(d.name)}</h2><p class="small soft">${fmt(d.row_count, 0)} batch(es)</p></div>
        ${canEdit ? `<button class="btn" type="button" data-delete-dataset ${busy ? 'disabled' : ''}>Delete</button>` : ''}
      </div>
      ${preview}
      <form class="stack gap-2_5" id="correlate-form">
        <div class="row gap-3 wrap items-end">
          <label class="field">Outcome<select name="outcome">${d.columns.map((c) => option(c.name, outcome?.name ?? '')).join('')}</select></label>
          <label class="field">Failed when it is${outcome?.kind === 'bool' ? ' (default true)' : ''}<input type="text" name="ng" value="${esc(ui.ngText)}" placeholder="${outcome?.kind === 'bool' ? 'true' : 'e.g. NG, scrap'}" class="w-12em"></label>
          <label class="field">Split by<select name="split"><option value="">nothing (pooled)</option>${d.columns
            .filter((c) => c.kind !== 'number' && c.name !== outcome?.name)
            .map((c) => option(c.name, ui.split))
            .join('')}</select></label>
          <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>Find</button>
        </div>
        <fieldset class="row gap-2_5 wrap border-0 p-0 m-0"><legend class="small soft">Variables</legend>${numbers
          .filter((n) => n !== outcome?.name)
          .map(
            (n) =>
              `<label class="row small gap-1"><input type="checkbox" name="variable" value="${esc(n)}" ${checked.has(n) ? 'checked' : ''}> ${esc(n)}</label>`,
          )
          .join('')}</fieldset>
      </form>
      ${r ? resultBlock(r.data, r.split) : ''}
      ${r && canEdit ? (saving?.key === r.key ? `<div class="stack gap-1_5"><h3>Save as an insight</h3>${draftForm('insight-save', saving.text, Boolean(busy))}</div>` : '<div><button class="btn" type="button" data-save-insight>Save as insight</button></div>') : ''}
    </div>`;
}

function resultBlock(r: CorrelationResult, split: boolean): string {
  const said = r.explanations.length
    ? `<ul class="stack gap-1" data-explanations>${r.explanations.map((e) => `<li>${esc(e.text)}</li>`).join('')}</ul>`
    : '<p class="small soft" data-explanations>No large, clear effect (|d| ≥ 0.8 with an interval that leaves out 0).</p>';
  const rows = r.findings
    .slice(0, 50)
    .map(
      (f) =>
        `<tr><td>${esc(f.segment)}</td><td>${esc(f.variable)}</td><td>${f.ng_mean === null ? '–' : fmt(f.ng_mean, 2)}</td><td>${f.ok_mean === null ? '–' : fmt(f.ok_mean, 2)}</td><td><b>${f.effect.toFixed(2)}</b></td><td>${f.ci_low === null || f.ci_high === null ? '–' : `${f.ci_low.toFixed(2)} to ${f.ci_high.toFixed(2)}`}${f.clear ? '' : ' <span class="small soft">(could be 0)</span>'}</td><td>${f.r.toFixed(2)}</td><td>${f.ng_count} / ${f.ok_count}</td></tr>`,
    )
    .join('');
  return `<div class="stack gap-2_5" data-result>
      <p class="small soft">${fmt(r.rows, 0)} batch(es) with an outcome: ${fmt(r.ng, 0)} failed, ${fmt(r.ok, 0)} good.</p>
      ${said}
      ${forestPlot(r.findings, split)}
      <div class="table-wrap"><table><thead><tr><th>Segment</th><th>Variable</th><th>Failed mean</th><th>Good mean</th><th>d</th><th>95% CI</th><th>r</th><th>Failed / good</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
}

async function uploadFile(ctx: Context, file: File, name: string): Promise<void> {
  const site = siteId(ctx);
  const api = ctx.api;
  if (!api || !site) return;
  const text = await file.text();
  const table = parseCsv(text, detectDelimiter(text)).filter((r) => r.some((c) => c.trim()));
  const [header, ...body] = table;
  if (!header || !body.length) {
    ctx.toast('The file needs a header row and at least one batch');
    return;
  }
  const columns = inferColumns(header, body);
  const rows = typedRows(body, columns);
  busy = 'upload';
  upload = { done: 0, total: rows.length };
  ctx.rerender();
  let created: string | null = null;
  try {
    const d = await api.datasets.create(site, name, columns);
    created = d.id;
    for (let i = 0; i < rows.length; i += 2000) {
      const sent = await api.datasets.addRows(site, d.id, rows.slice(i, i + 2000));
      upload = { done: sent.row_count, total: rows.length };
      ctx.rerender();
    }
    ctx.toast(`${name}: ${fmt(rows.length, 0)} batch(es) uploaded`);
    Object.assign(uiState(ctx), { selected: d.id, outcome: '', ngText: '', variables: null, split: '' });
    detail = null;
    listing = null;
    created = null;
  } catch {
    // The client showed why. A half-uploaded table would mislead: remove it.
    if (created) await api.datasets.remove(site, created).catch(() => undefined);
    listing = null;
  } finally {
    busy = '';
    upload = null;
    ctx.rerender();
  }
}

async function removeDataset(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  const ui = uiState(ctx);
  const d = detail?.id === ui.selected ? detail.data : null;
  if (!ctx.api || !site || !d) return;
  const yes = await confirmDialog({
    title: `Delete ${d.name}?`,
    body: `Its ${d.row_count} batch(es) are deleted for good; insights saved from it keep their evidence.`,
    confirm: 'Delete',
    tone: 'danger',
  });
  if (!yes) return;
  busy = 'delete';
  ctx.rerender();
  try {
    await ctx.api.datasets.remove(site, d.id);
    ctx.toast(`${d.name} deleted`);
    Object.assign(ui, { selected: null, outcome: '', ngText: '', variables: null, split: '' });
    detail = null;
    listing = null;
  } catch {
    // the client showed why
  } finally {
    busy = '';
    ctx.rerender();
  }
}

async function saveInsight(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site || !result || !saving || saving.key !== result.key) return;
  const draft = readDraft(saving.text);
  if (typeof draft === 'string') return void ctx.toast(draft);
  busy = 'save';
  ctx.rerender();
  try {
    const saved = await ctx.api.insights.create(site, draft, result.source);
    saving = null;
    ctx.toast(`Insight #${saved.number} saved: another engineer reviews it`);
    location.hash = insightLink(saved.number);
  } catch {
    // the client showed why
  } finally {
    busy = '';
    ctx.rerender();
  }
}

// `#/correlate?dataset=<id>` (a saved insight links here) selects that dataset.
function selectFromLink(ctx: Context): void {
  const id = new URLSearchParams(location.hash.split('?')[1] ?? '').get('dataset');
  if (!id) return;
  history.replaceState(null, '', `${location.pathname}${location.search}#/correlate`);
  Object.assign(uiState(ctx), { selected: id, outcome: '', ngText: '', variables: null, split: '' });
  detail = null;
}

async function find(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  const ui = uiState(ctx);
  const d = detail?.data;
  if (!ctx.api || !site || !d || !ui.selected) return;
  const outcome =
    d.columns.find((c) => c.name === ui.outcome) ?? d.columns.find((c) => c.kind === 'bool') ?? d.columns[0];
  if (!outcome) return;
  const split = ui.split && ui.split !== outcome.name ? ui.split : null;
  const ng = parseNgValues(ui.ngText, outcome.kind);
  if (typeof ng === 'string') {
    ctx.toast(ng);
    return;
  }
  const numbers = d.columns.filter((c) => c.kind === 'number' && c.name !== outcome.name).map((c) => c.name);
  const variables = (ui.variables ?? numbers).filter((v) => numbers.includes(v));
  if (!variables.length) {
    ctx.toast('Choose at least one variable');
    return;
  }
  const key = resultKey(ctx);
  busy = 'find';
  ctx.rerender();
  try {
    const q = { outcome: outcome.name, ng_values: ng, variables, split };
    const data = await ctx.api.datasets.correlate(site, ui.selected, q);
    const source: InsightSource = { kind: 'correlation', dataset_id: ui.selected, ...q };
    result = { key, data, split: split !== null, source, dataset: d.name };
  } catch {
    // the client showed why
  } finally {
    busy = '';
    ctx.rerender();
  }
}

const view: View = {
  id: 'correlate',
  title: 'Correlation finder',
  icon: 'chart-scatter',
  render(ctx) {
    const head = pageHead({
      eyebrow: 'Data · Analysis',
      title: 'Correlation finder',
      lead: 'Which settings separate failed batches from good ones: each variable’s effect (Cohen’s d) with its 95% confidence interval, overall or per material, line or shift.',
    });
    if (!ctx.api)
      return `${head}<div class="card">${needsApi(`Batch tables are kept by the Tiles API. The <a href="#/quality">Process & quality</a> page shows the finder on demo batches.`)}</div>`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}<div class="card">Loading from the Tiles API…</div>`;
    if (o.status !== 'ready') return `${head}${apiUnreachable(o.error)}`;
    const ui = uiState(ctx);
    return `${head}<div class="reviews">${listCard(ctx, ui)}${analysisCard(ctx, ui)}</div>`;
  },
  bind(root, ctx) {
    if (!ctx.api || ctx.ontology.status !== 'ready') return;
    selectFromLink(ctx);
    const ui = uiState(ctx);
    const site = siteId(ctx);
    if (site && listing?.site !== site) void loadList(ctx);
    if (ui.selected && detail?.id !== ui.selected) void loadDetail(ctx, ui.selected);
    onAll(root, '[data-dataset]', 'click', (el) => {
      Object.assign(ui, { selected: el.dataset.dataset ?? null, outcome: '', ngText: '', variables: null, split: '' });
      ctx.rerender();
    });
    const uploadForm = root.querySelector<HTMLFormElement>('#dataset-form');
    uploadForm?.querySelector<HTMLInputElement>('[name=file]')?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0] ?? null;
      chosen = {
        file,
        name:
          chosen.name ||
          (file
            ? file.name
                .replace(/\.[^.]+$/, '')
                .trim()
                .slice(0, 200)
                .trim()
            : ''),
      };
      ctx.rerender();
    });
    uploadForm?.querySelector<HTMLInputElement>('[name=name]')?.addEventListener('input', (e) => {
      chosen.name = (e.target as HTMLInputElement).value;
    });
    onSubmit(root, '#dataset-form', () => {
      const name = chosen.name.trim();
      if (!chosen.file) return void ctx.toast('Choose the CSV file first');
      if (!name) return void ctx.toast('Give the batch table a name');
      const file = chosen.file;
      chosen = { file: null, name: '' };
      void uploadFile(ctx, file, name);
    });
    // Every choice is kept as it is made, so a re-render never loses it.
    const form = root.querySelector<HTMLFormElement>('#correlate-form');
    form?.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement | HTMLSelectElement;
      if (el.name === 'outcome')
        Object.assign(ui, {
          outcome: el.value,
          ngText: '',
          variables: null,
          split: ui.split === el.value ? '' : ui.split,
        });
      if (el.name === 'split') ui.split = el.value;
      if (el.name === 'variable')
        ui.variables = [...form.querySelectorAll<HTMLInputElement>('[name=variable]:checked')].map((c) => c.value);
      if (el.name === 'outcome') ctx.rerender();
    });
    form?.querySelector<HTMLInputElement>('[name=ng]')?.addEventListener('input', (e) => {
      ui.ngText = (e.target as HTMLInputElement).value;
    });
    onSubmit(root, '#correlate-form', () => void find(ctx));
    onAll(root, '[data-save-insight]', 'click', () => {
      if (!result || !detail) return;
      saving = { key: result.key, text: correlationDraft(result.dataset, result.data) };
      ctx.rerender();
    });
    const saveForm = root.querySelector<HTMLFormElement>('#insight-save');
    if (saveForm && saving) {
      bindDraft(saveForm, saving.text);
      onAll(saveForm, '[data-cancel]', 'click', () => {
        saving = null;
        ctx.rerender();
      });
      onSubmit(root, '#insight-save', () => void saveInsight(ctx));
    }
    onAll(root, '[data-delete-dataset]', 'click', () => void removeDataset(ctx));
  },
};

export default view;
