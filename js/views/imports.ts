import { ux } from '../lib/analytics.ts';
import { esc, field, fmt, need, onAll } from '../lib/dom.ts';
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

const FORMATS: [TimeFormat, string][] = [
  ['iso', 'ISO 8601 (2026-10-01 08:00:00)'],
  ['dmy', 'Day first (01.10.2026 08:00)'],
  ['mdy', 'Month first (10/01/2026 08:00)'],
  ['epoch-s', 'Seconds since 1970'],
  ['epoch-ms', 'Milliseconds since 1970'],
];

function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function load(fileName: string, text: string, zone = browserZone()): Loaded | string {
  const table = parseCsv(text, detectDelimiter(text));
  const [header, ...rows] = table;
  if (!header || header.length < 2 || !rows.length)
    return `${fileName} needs a header row and at least one data row, with two or more columns.`;
  return { fileName, header, rows, mapping: suggestMapping(header, rows, zone) };
}

function options(header: string[], selected: number, skip: number[] = []): string {
  return header
    .map((h, i) =>
      skip.includes(i)
        ? ''
        : `<option value="${i}" ${i === selected ? 'selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`,
    )
    .join('');
}

function mappingForm(l: Loaded): string {
  const m = l.mapping;
  const long = m.long !== null;
  const columns = long
    ? `<div class="row gap-3 wrap">
        <label class="field">Tag column<select name="tagColumn">${options(l.header, m.long?.tagColumn ?? -1, [m.timeColumn])}</select></label>
        <label class="field">Value column<select name="valueColumn">${options(l.header, m.long?.valueColumn ?? -1, [m.timeColumn])}</select></label>
      </div>
      <p class="small soft">Each row is one reading; tags become signal names (TT-101 → tt-101).</p>`
    : `<div class="table-wrap"><table><thead><tr><th>Import</th><th>Column</th><th>Signal</th></tr></thead><tbody>${l.header
        .map((h, i) =>
          i === m.timeColumn
            ? ''
            : `<tr><td><input type="checkbox" name="use-${i}" ${m.columns[i] ? 'checked' : ''} aria-label="Import ${esc(h)}"></td><td>${esc(h)}</td>
               <td><input type="text" name="tag-${i}" value="${esc(m.columns[i] ?? slugTag(h) ?? '')}" aria-label="Signal for ${esc(h)}" class="w-full"></td></tr>`,
        )
        .join('')}</tbody></table></div>`;
  return `<form id="import-mapping" class="stack gap-3">
      <fieldset class="row gap-4 border-0 p-0">
        <label><input type="radio" name="shape" value="wide" ${long ? '' : 'checked'}> One column per signal</label>
        <label><input type="radio" name="shape" value="long" ${long ? 'checked' : ''}> One row per reading (tag, time, value)</label>
      </fieldset>
      <div class="row gap-3 wrap">
        <label class="field">Time column<select name="timeColumn">${options(l.header, m.timeColumn)}</select></label>
        <label class="field">Time format<select name="timeFormat">${FORMATS.map(([f, label]) => `<option value="${f}" ${f === m.timeFormat ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label class="field">Time zone (for times without one)<input type="text" name="timeZone" value="${esc(m.timeZone)}"></label>
      </div>
      <div class="row gap-4 wrap">
        <label><input type="checkbox" name="decimalComma" ${m.decimalComma ? 'checked' : ''}> Decimal comma (21,5)</label>
        <label><input type="checkbox" name="keepText" ${m.keepText ? 'checked' : ''}> Keep text cells as text readings</label>
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
  const range =
    s.first && s.last
      ? ` from ${s.first.replace('T', ' ').slice(0, 19)} to ${s.last.replace('T', ' ').slice(0, 19)} UTC`
      : '';
  const skipped = Object.entries(s.skipped)
    .map(([reason, n]) => `${fmt(n, 0)} ${reason}`)
    .join(', ');
  return `${fmt(s.readings, 0)} readings for ${s.signals.size} signal(s) in ${fmt(s.rows, 0)} rows${range}.${skipped ? ` Skipped: ${skipped}.` : ''}`;
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
  if (fields.length) problems.unshift('Correct the fields marked above.');
  if (problems.length)
    return `<div class="stack gap-1">${problems.map((p) => `<p class="small text-bad">${esc(p)}</p>`).join('')}</div>`;
  const stats = summarize(l.rows, l.mapping);
  const examples = stats.examples.length
    ? `<ul class="small soft">${stats.examples.map((e) => `<li>Line ${e.row}: ${esc(e.message)}</li>`).join('')}</ul>`
    : '';
  const signals = [...stats.signals]
    .slice(0, 12)
    .map((t) => `<span class="badge">${esc(t)}</span>`)
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
    return `<div class="card stack gap-2"><h2>Import readings</h2><p class="small soft">Imports go into the Tiles API. Connect to it in <a href="#/settings">Settings</a> (data source: Tiles API).</p></div>`;
  if (ctx.ontology.role === 'viewer')
    return `<div class="card stack gap-2"><h2>Import readings</h2><p class="small soft">Your role on this site is viewer: you can see past imports, but engineers and admins run them.</p></div>`;
  const l = loaded;
  const busy = running !== null;
  return `<div class="card stack gap-3" id="import-card">
      <h2>Import readings</h2>
      <p class="small soft">Backfill history from a CSV file or a historian export. The file is read in this browser; readings Tiles already has (same signal and time) are skipped, so importing a file twice is safe.</p>
      <label class="field">File<input type="file" accept=".csv,.tsv,.txt,text/csv" data-import-file ${busy ? 'disabled' : ''}></label>
      ${
        l
          ? `<p class="small"><b>${esc(l.fileName)}</b>: ${fmt(l.rows.length, 0)} rows, ${l.header.length} columns.</p>
             ${preview(l)}
             ${mappingForm(l)}
             <div data-import-check aria-live="polite">${summaryBox(l)}</div>
             <div class="row gap-2">
               <button class="btn primary" type="button" data-import-run ${busy || mappingProblems(l.header, l.mapping).length ? 'disabled' : ''}>Import</button>
               ${busy ? '<button class="btn" type="button" data-import-cancel>Stop</button>' : ''}
             </div>`
          : ''
      }
      <div data-import-progress aria-live="polite">${running ? progress(running) : lastResult ? `<p>${esc(lastResult)}</p>` : ''}</div>
    </div>`;
}

function progress(r: Running): string {
  const pct = r.total ? Math.round((100 * r.sent) / r.total) : 0;
  return `<p>Sent ${fmt(r.sent, 0)} of ${fmt(r.total, 0)} readings (${pct}%), ${fmt(r.stored, 0)} new.</p>
    <progress max="${r.total}" value="${r.sent}" class="w-full"></progress>`;
}

function historyCard(): string {
  return `<div class="card stack gap-3"><h2>Past imports</h2><div data-import-history aria-live="polite">${skeleton.table(3, 5, 'Loading the past imports…')}</div></div>`;
}

export function historyTable(runs: ImportRun[]): string {
  if (!runs.length)
    return emptyState({
      illustration: 'inbox',
      compact: true,
      level: 3,
      title: 'No imports yet',
      body: 'Files you import above are listed here, with who imported them and how many readings they added.',
    });
  return `<div class="table-wrap"><table><thead><tr><th>File</th><th>By</th><th>Started</th><th>Readings</th><th>New</th><th>Status</th></tr></thead><tbody>${runs
    .map(
      (r) =>
        `<tr><td>${esc(r.name)}</td><td>${esc(r.created_by ?? '—')}</td><td>${esc(new Date(r.created_at).toLocaleString('en-GB'))}</td><td>${esc(fmt(r.received, 0))}</td><td>${esc(fmt(r.stored, 0))}</td><td>${r.finished_at ? '<span class="badge good">finished</span>' : '<span class="badge warn">not finished</span>'}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

async function fillHistory(root: HTMLElement, ctx: Context): Promise<void> {
  const box = root.querySelector('[data-import-history]');
  const site = ctx.ontology.site;
  if (!box) return;
  if (!ctx.api || !site) {
    box.innerHTML = '<p class="small soft">Past imports are kept in the Tiles API.</p>';
    return;
  }
  try {
    box.innerHTML = historyTable(await ctx.api.imports.list(site.id));
  } catch {
    box.innerHTML = loadFailed('The imports');
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
  const what = `${fmt(state.stored, 0)} new readings stored (${fmt(state.sent, 0)} sent; the rest were already in Tiles).`;
  const open = unfinished ? ` The import could not be marked finished (${unfinished}); it shows as not finished.` : '';
  lastResult = failure
    ? `Stopped by an error after ${fmt(state.sent, 0)} readings: ${failure}. ${what}${open}`
    : state.cancelled
      ? `Stopped. ${what}${open}`
      : unfinished
        ? `All readings sent, but not finished. ${what}${open}`
        : `Done. ${what}`;
  ctx.toast(
    failure || unfinished
      ? 'Import stopped by an error'
      : state.cancelled
        ? 'Import stopped'
        : `Imported ${l.fileName}`,
  );
  ctx.rerender();
}

const view: View = {
  id: 'import',
  title: 'Import data',
  icon: 'upload',
  render(ctx) {
    return `${pageHead({ eyebrow: 'Data', title: 'Import data', lead: 'Backfill readings from CSV files and historian exports, mapped to signals.' })}
      <div class="stack gap-4">${importCard(ctx)}${historyCard()}</div>`;
  },
  bind(root, ctx) {
    void fillHistory(root, ctx);
    const input = root.querySelector<HTMLInputElement>('[data-import-file]');
    input?.addEventListener('change', () => {
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
    });
    const form = root.querySelector<HTMLFormElement>('#import-mapping');
    if (form && loaded) markFields(form, loaded);
    form?.addEventListener('change', (e) => {
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
    });
    onAll(root, '[data-import-run]', 'click', () => void runImport(ctx));
    onAll(root, '[data-import-cancel]', 'click', () => {
      if (running) running.cancelled = true;
    });
  },
};

export default view;
