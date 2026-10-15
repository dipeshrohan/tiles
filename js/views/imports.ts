import { ux } from '../lib/analytics.ts';
import { esc, field, fmt, need, onAll, bound } from '../lib/dom.ts';
import { detectDelimiter, parseCsv } from '../lib/csv.ts';
import {
  inBatches,
  mappingFieldProblems,
  mappingProblems,
  readings,
  slugTag,
  suggestMapping,
  summarize,
  type ImportMapping,
  type ImportStats,
  type TimeFormat,
} from '../lib/importer.ts';
import type { ImportRun } from '../lib/api.ts';
import type { Context, View } from './types.ts';
import { t, tHtml, type MessageKey } from '../lib/i18n.ts';
import { setFieldError } from '../lib/forms.ts';
import { emptyState, pageHead, skeleton, loadFailed } from '../lib/ui.ts';

// Bulk import (T2.07): backfill readings from a CSV file or historian export. The file is
// read here, in the browser, and sent to the Tiles API in batches; nothing is uploaded
// until the mapping has been checked.

const BATCH = 5000;
const PREVIEW_ROWS = 5;

interface Loaded {
  fileName: string;
  header: string[];
  rows: string[][];
  mapping: ImportMapping;
}

interface Running {
  importId: string;
  sent: number;
  stored: number;
  total: number;
  cancelled: boolean;
}

// The file being imported stays in memory while you move around the app, not in saved state.
let loaded: Loaded | null = null;
let running: Running | null = null;
let lastResult: string | null = null;

const FORMATS: [TimeFormat, MessageKey][] = [
  ['iso', 'imports.format.iso'],
  ['dmy', 'imports.format.dmy'],
  ['mdy', 'imports.format.mdy'],
  ['epoch-s', 'imports.format.epochS'],
  ['epoch-ms', 'imports.format.epochMs'],
];

function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function load(fileName: string, text: string, zone = browserZone()): Loaded | string {
  const table = parseCsv(text, detectDelimiter(text));
  const [header, ...rows] = table;
  if (!header || header.length < 2 || !rows.length) return t('imports.loadError', { name: fileName });
  return { fileName, header, rows, mapping: suggestMapping(header, rows, zone) };
}

function options(header: string[], selected: number, skip: number[] = []): string {
  return header
    .map((h, i) =>
      skip.includes(i)
        ? ''
        : `<option value="${i}" ${i === selected ? 'selected' : ''}>${esc(h || t('imports.columnN', { n: i + 1 }))}</option>`,
    )
    .join('');
}

function mappingForm(l: Loaded): string {
  const m = l.mapping;
  const long = m.long !== null;
  const columns = long
    ? `<div class="row gap-3 wrap">
        <label class="field">${t('imports.map.tagColumn')}<select name="tagColumn">${options(l.header, m.long?.tagColumn ?? -1, [m.timeColumn])}</select></label>
        <label class="field">${t('imports.map.valueColumn')}<select name="valueColumn">${options(l.header, m.long?.valueColumn ?? -1, [m.timeColumn])}</select></label>
      </div>
      <p class="small soft">${esc(t('imports.map.longHint'))}</p>`
    : `<div class="table-wrap"><table><thead><tr><th>${t('imports.map.import')}</th><th>${t('imports.map.column')}</th><th>${t('imports.map.signal')}</th></tr></thead><tbody>${l.header
        .map((h, i) =>
          i === m.timeColumn
            ? ''
            : `<tr><td><input type="checkbox" name="use-${i}" ${m.columns[i] ? 'checked' : ''} aria-label="${esc(t('imports.map.importColumn', { name: h }))}"></td><td>${esc(h)}</td>
               <td><input type="text" name="tag-${i}" value="${esc(m.columns[i] ?? slugTag(h) ?? '')}" aria-label="${esc(t('imports.map.signalFor', { name: h }))}" class="w-full"></td></tr>`,
        )
        .join('')}</tbody></table></div>`;
  return `<form id="import-mapping" class="stack gap-3">
      <fieldset class="row gap-4 border-0 p-0">
        <label><input type="radio" name="shape" value="wide" ${long ? '' : 'checked'}> ${esc(t('imports.map.wide'))}</label>
        <label><input type="radio" name="shape" value="long" ${long ? 'checked' : ''}> ${esc(t('imports.map.long'))}</label>
      </fieldset>
      <div class="row gap-3 wrap">
        <label class="field">${t('imports.map.timeColumn')}<select name="timeColumn">${options(l.header, m.timeColumn)}</select></label>
        <label class="field">${t('imports.map.timeFormat')}<select name="timeFormat">${FORMATS.map(([f, label]) => `<option value="${f}" ${f === m.timeFormat ? 'selected' : ''}>${esc(t(label))}</option>`).join('')}</select></label>
        <label class="field">${esc(t('imports.map.timeZone'))}<input type="text" name="timeZone" value="${esc(m.timeZone)}"></label>
      </div>
      <div class="row gap-4 wrap">
        <label><input type="checkbox" name="decimalComma" ${m.decimalComma ? 'checked' : ''}> ${esc(t('imports.map.decimalComma'))}</label>
        <label><input type="checkbox" name="keepText" ${m.keepText ? 'checked' : ''}> ${esc(t('imports.map.keepText'))}</label>
      </div>
      ${columns}
    </form>`;
}

export function readMapping(form: HTMLFormElement, header: string[], before: ImportMapping): ImportMapping {
  const timeColumn = Number(field(form, 'timeColumn'));
  const base = {
    timeColumn,
    timeFormat: field(form, 'timeFormat') as TimeFormat,
    timeZone: field(form, 'timeZone').trim(),
    decimalComma: (form.elements.namedItem('decimalComma') as HTMLInputElement | null)?.checked ?? false,
    keepText: (form.elements.namedItem('keepText') as HTMLInputElement | null)?.checked ?? false,
  };
  const shape = (form.querySelector('input[name="shape"]:checked') as HTMLInputElement | null)?.value ?? 'wide';
  if (shape === 'long') {
    const pick = (name: string, fallback: number) => {
      const v = form.elements.namedItem(name);
      return v instanceof HTMLSelectElement && v.value !== '' ? Number(v.value) : fallback;
    };
    const others = header.map((_, i) => i).filter((i) => i !== timeColumn);
    return {
      ...base,
      columns: {},
      long: {
        tagColumn: pick('tagColumn', before.long?.tagColumn ?? others[0] ?? -1),
        valueColumn: pick('valueColumn', before.long?.valueColumn ?? others[1] ?? -1),
      },
    };
  }
  const columns: Record<number, string> = {};
  header.forEach((h, i) => {
    if (i === timeColumn) return;
    const use = form.elements.namedItem(`use-${i}`);
    const tag = form.elements.namedItem(`tag-${i}`);
    // Switching from the long shape: suggest the numeric columns again.
    if (!(use instanceof HTMLInputElement)) {
      if (before.long === null && before.columns[i]) columns[i] = before.columns[i] ?? '';
      return;
    }
    if (use.checked) columns[i] = tag instanceof HTMLInputElement ? tag.value.trim() : (slugTag(h) ?? '');
  });
  return { ...base, columns, long: null };
}

export function describeStats(s: ImportStats): string {
  const skipped = Object.entries(s.skipped)
    .map(([reason, n]) => `${fmt(n, 0)} ${reason}`)
    .join(', ');
  const counts = { readings: s.readings, count: s.signals.size, rows: s.rows };
  const main =
    s.first && s.last
      ? t('imports.stats.range', {
          ...counts,
          first: s.first.replace('T', ' ').slice(0, 19),
          last: s.last.replace('T', ' ').slice(0, 19),
        })
      : t('imports.stats.all', counts);
  return skipped ? `${main} ${t('imports.stats.skipped', { list: skipped })}` : main;
}

// The mapping's own fields that are wrong, marked where they are (the rest is in the check below).
function markFields(form: HTMLFormElement, l: Loaded): void {
  const problems = mappingFieldProblems(l.header, l.mapping);
  for (const name of ['timeColumn', 'timeZone']) {
    const el = form.elements.namedItem(name);
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement)
      setFieldError(el, problems.find((p) => p.name === name)?.message ?? null);
  }
}

function summaryBox(l: Loaded): string {
  // A field's own problem is said under it; here, that there is one, and the rest.
  const fields = mappingFieldProblems(l.header, l.mapping).map((p) => p.message);
  const problems = mappingProblems(l.header, l.mapping).filter((p) => !fields.includes(p));
  if (fields.length) problems.unshift(t('imports.check.fields'));
  if (problems.length)
    return `<div class="stack gap-1">${problems.map((p) => `<p class="small text-bad">${esc(p)}</p>`).join('')}</div>`;
  const stats = summarize(l.rows, l.mapping);
  const examples = stats.examples.length
    ? `<ul class="small soft">${stats.examples.map((e) => `<li>${esc(t('imports.check.line', { row: e.row, message: e.message }))}</li>`).join('')}</ul>`
    : '';
  const signals = [...stats.signals]
    .slice(0, 12)
    .map((tag) => `<span class="badge">${esc(tag)}</span>`)
    .join(' ');
  return `<p data-import-summary>${esc(describeStats(stats))}</p>
    ${signals ? `<p>${signals}${stats.signals.size > 12 ? ' …' : ''}</p>` : ''}${examples}`;
}

function preview(l: Loaded): string {
  return `<div class="table-wrap"><table><thead><tr>${l.header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${l.rows
    .slice(0, PREVIEW_ROWS)
    .map((r) => `<tr>${l.header.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

function importCard(ctx: Context): string {
  if (!ctx.api || !ctx.ontology.site)
    return `<div class="card stack gap-2"><h2>${t('imports.card.title')}</h2><p class="small soft">${tHtml('imports.card.noApi', { link: `<a href="#/settings">${esc(t('imports.card.settings'))}</a>` })}</p></div>`;
  if (ctx.ontology.role === 'viewer')
    return `<div class="card stack gap-2"><h2>${t('imports.card.title')}</h2><p class="small soft">${esc(t('imports.card.viewer'))}</p></div>`;
  const l = loaded;
  const busy = running !== null;
  return `<div class="card stack gap-3" id="import-card">
      <h2>${t('imports.card.title')}</h2>
      <p class="small soft">${esc(t('imports.card.lead'))}</p>
      <label class="field">${t('imports.card.file')}<input type="file" accept=".csv,.tsv,.txt,text/csv" data-import-file ${busy ? 'disabled' : ''}></label>
      ${
        l
          ? `<p class="small">${tHtml('imports.card.loaded', { name: `<b>${esc(l.fileName)}</b>`, rows: l.rows.length, columns: l.header.length })}</p>
             ${preview(l)}
             ${mappingForm(l)}
             <div data-import-check aria-live="polite">${summaryBox(l)}</div>
             <div class="row gap-2">
               <button class="btn primary" type="button" data-import-run ${busy || mappingProblems(l.header, l.mapping).length ? 'disabled' : ''}>${t('imports.map.import')}</button>
               ${busy ? `<button class="btn" type="button" data-import-cancel>${t('imports.stop')}</button>` : ''}
             </div>`
          : ''
      }
      <div data-import-progress aria-live="polite">${running ? progress(running) : lastResult ? `<p>${esc(lastResult)}</p>` : ''}</div>
    </div>`;
}

function progress(r: Running): string {
  const pct = r.total ? Math.round((100 * r.sent) / r.total) : 0;
  return `<p>${esc(t('imports.progress', { sent: fmt(r.sent, 0), total: fmt(r.total, 0), pct, stored: fmt(r.stored, 0) }))}</p>
    <progress max="${r.total}" value="${r.sent}" class="w-full"></progress>`;
}

function historyCard(): string {
  return `<div class="card stack gap-3"><h2>${t('imports.history.title')}</h2><div data-import-history aria-live="polite">${skeleton.table(3, 5, t('imports.history.loading'))}</div></div>`;
}

export function historyTable(runs: ImportRun[]): string {
  if (!runs.length)
    return emptyState({
      illustration: 'inbox',
      compact: true,
      level: 3,
      title: t('imports.history.emptyTitle'),
      body: t('imports.history.emptyBody'),
    });
  return `<div class="table-wrap"><table><thead><tr><th>${t('imports.card.file')}</th><th>${t('imports.history.by')}</th><th>${t('imports.history.started')}</th><th>${t('imports.history.readings')}</th><th>${t('imports.history.new')}</th><th>${t('imports.history.status')}</th></tr></thead><tbody>${runs
    .map(
      (r) =>
        `<tr><td>${esc(r.name)}</td><td>${esc(r.created_by ?? '—')}</td><td>${esc(new Date(r.created_at).toLocaleString('en-GB'))}</td><td>${esc(fmt(r.received, 0))}</td><td>${esc(fmt(r.stored, 0))}</td><td>${r.finished_at ? `<span class="badge good">${t('imports.history.finished')}</span>` : `<span class="badge warn">${t('imports.history.notFinished')}</span>`}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

async function fillHistory(root: HTMLElement, ctx: Context): Promise<void> {
  const box = root.querySelector('[data-import-history]');
  const site = ctx.ontology.site;
  if (!box) return;
  if (!ctx.api || !site) {
    box.innerHTML = `<p class="small soft">${esc(t('imports.history.noApi'))}</p>`;
    return;
  }
  try {
    box.innerHTML = historyTable(await ctx.api.imports.list(site.id));
  } catch {
    box.innerHTML = loadFailed(t('imports.history.name'));
  }
}

async function runImport(ctx: Context): Promise<void> {
  const l = loaded;
  const site = ctx.ontology.site;
  const api = ctx.api;
  if (!l || !site || !api || running) return;
  const total = summarize(l.rows, l.mapping).readings;
  let run: ImportRun;
  try {
    run = await api.imports.start(site.id, l.fileName);
  } catch {
    return; // the client already showed why
  }
  running = { importId: run.id, sent: 0, stored: 0, total, cancelled: false };
  lastResult = null;
  ctx.rerender();
  const state = running;
  let failure: string | null = null;
  for (const batch of inBatches(readings(l.rows, l.mapping), BATCH)) {
    if (state.cancelled) break;
    try {
      const answer = await api.imports.send(site.id, run.id, batch);
      state.sent += answer.received;
      state.stored += answer.stored;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      break;
    }
    const box = document.querySelector('[data-import-progress]');
    if (box) box.innerHTML = progress(state);
  }
  let unfinished: string | null = null;
  try {
    await api.imports.finish(site.id, run.id);
    ux('task', 'import.finished');
  } catch (e) {
    // The readings sent are stored, but the import stays open: say so rather than "done".
    unfinished = e instanceof Error ? e.message : String(e);
  }
  running = null;
  const what = t('imports.result.what', { stored: state.stored, sent: fmt(state.sent, 0) });
  const open = unfinished ? ` ${t('imports.result.unfinished', { why: unfinished })}` : '';
  lastResult = failure
    ? `${t('imports.result.failed', { sent: state.sent, why: failure })} ${what}${open}`
    : state.cancelled
      ? `${t('imports.result.stopped')} ${what}${open}`
      : unfinished
        ? `${t('imports.result.notFinished')} ${what}${open}`
        : `${t('imports.result.done')} ${what}`;
  ctx.toast(
    failure || unfinished
      ? t('imports.toast.error')
      : state.cancelled
        ? t('imports.toast.stopped')
        : t('imports.toast.done', { name: l.fileName }),
  );
  ctx.rerender();
}

const view: View = {
  id: 'import',
  get title() {
    return t('imports.title');
  },
  icon: 'upload',
  render(ctx) {
    return `${pageHead({ eyebrow: t('imports.eyebrow'), title: t('imports.title'), lead: t('imports.lead') })}
      <div class="stack gap-4">${importCard(ctx)}${historyCard()}</div>`;
  },
  bind(root, ctx) {
    void fillHistory(root, ctx);
    const input = root.querySelector<HTMLInputElement>('[data-import-file]');
    input?.addEventListener(
      'change',
      () => {
        const file = input.files?.[0];
        if (!file) return;
        void file.text().then((text) => {
          const result = load(file.name, text);
          if (typeof result === 'string') {
            ctx.toast(result);
            return;
          }
          loaded = result;
          lastResult = null;
          ctx.rerender();
        });
      },
      { signal: bound() },
    );
    const form = root.querySelector<HTMLFormElement>('#import-mapping');
    if (form && loaded) markFields(form, loaded);
    form?.addEventListener(
      'change',
      (e) => {
        const l = loaded;
        if (!l) return;
        l.mapping = readMapping(form, l.header, l.mapping);
        const name = (e.target as HTMLInputElement | null)?.name ?? '';
        // A new shape or time column changes the form itself; anything else only the check.
        if (name === 'shape' || name === 'timeColumn') {
          if (name === 'shape' && l.mapping.long === null && !Object.keys(l.mapping.columns).length)
            l.mapping = { ...suggestMapping(l.header, l.rows, l.mapping.timeZone), timeColumn: l.mapping.timeColumn };
          ctx.rerender();
          return;
        }
        need(root, '[data-import-check]').innerHTML = summaryBox(l);
        markFields(form, l);
        const run = root.querySelector<HTMLButtonElement>('[data-import-run]');
        if (run) run.disabled = running !== null || mappingProblems(l.header, l.mapping).length > 0;
      },
      { signal: bound() },
    );
    onAll(root, '[data-import-run]', 'click', () => void runImport(ctx));
    onAll(root, '[data-import-cancel]', 'click', () => {
      if (running) running.cancelled = true;
    });
  },
};

export default view;
