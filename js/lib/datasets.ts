// The correlation finder page's logic (T3.11), apart from the page: a CSV read into a typed batch
// table, the failed values typed in, and the forest plot of the effects.

import type { CorrelationFinding, DatasetColumn, DatasetValue } from './api.ts';
import { esc } from './dom.ts';
import { parseNumber } from './importer.ts';

const TRUE = new Set(['true', 'yes']);
const FALSE = new Set(['false', 'no']);

// Each column's kind, from its cells: numbers if every filled one is a number, true/false if every
// one is true/false or yes/no, otherwise text. Names are trimmed, and made unique.
export function inferColumns(header: string[], rows: string[][]): DatasetColumn[] {
  const seen = new Map<string, number>();
  return header.map((raw, i) => {
    let name = raw.trim() || `column ${i + 1}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    const cells = rows.map((r) => (r[i] ?? '').trim()).filter(Boolean);
    const kind: DatasetColumn['kind'] =
      cells.length && cells.every((c) => parseNumber(c, false) !== null)
        ? 'number'
        : cells.length && cells.every((c) => TRUE.has(c.toLowerCase()) || FALSE.has(c.toLowerCase()))
          ? 'bool'
          : 'text';
    return { name: name.slice(0, 100), kind };
  });
}

// The rows as the API takes them: each cell as its column's kind, empty ones null.
export function typedRows(rows: string[][], columns: DatasetColumn[]): Record<string, DatasetValue>[] {
  return rows.map((r) =>
    Object.fromEntries(
      columns.map((c, i) => {
        const cell = (r[i] ?? '').trim();
        if (!cell) return [c.name, null];
        if (c.kind === 'number') return [c.name, parseNumber(cell, false)];
        if (c.kind === 'bool') return [c.name, TRUE.has(cell.toLowerCase())];
        return [c.name, cell.slice(0, 1000)];
      }),
    ),
  );
}

// The values typed in that mean a failed batch, as the outcome column's kind; a string says why not.
export function parseNgValues(text: string, kind: DatasetColumn['kind']): DatasetValue[] | string {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return kind === 'bool' ? [true] : 'Type the value(s) that mean a failed batch, e.g. NG';
  if (kind === 'number') {
    const numbers = parts.map((p) => parseNumber(p, false));
    return numbers.every((n) => n !== null)
      ? (numbers as number[])
      : 'The failed values of a number column are numbers';
  }
  if (kind === 'bool') {
    if (!parts.every((p) => TRUE.has(p.toLowerCase()) || FALSE.has(p.toLowerCase())))
      return 'The failed values of a true/false column are true or false';
    return parts.map((p) => TRUE.has(p.toLowerCase()));
  }
  return parts;
}

// Each effect with its 95% interval on one scale, 0 marked: those whose interval misses 0 stand out.
export function forestPlot(findings: CorrelationFinding[], width = 760): string {
  const shown = findings.filter((f) => f.ci_low !== null && f.ci_high !== null).slice(0, 24);
  if (!shown.length)
    return '<p class="small soft">No effect could be measured: each group needs two batches or more.</p>';
  const label = 220;
  const pad = 16;
  const rowH = 24;
  const height = shown.length * rowH + 30;
  const reach = Math.max(1, ...shown.flatMap((f) => [Math.abs(f.ci_low!), Math.abs(f.ci_high!)]));
  const x = (d: number) => label + pad + ((d + reach) / (2 * reach)) * (width - label - 2 * pad);
  const rows = shown
    .map((f, i) => {
      const y = 20 + i * rowH + rowH / 2;
      const cls = f.clear ? (f.effect > 0 ? 'bad' : 'good') : 'muted';
      const name = f.segment === 'all' ? f.variable : `${f.segment} · ${f.variable}`;
      return `<text class="tick" x="${label}" y="${y + 4}" text-anchor="end">${esc(name)}</text>
        <line class="ci ${cls}" x1="${x(f.ci_low!).toFixed(1)}" x2="${x(f.ci_high!).toFixed(1)}" y1="${y}" y2="${y}"/>
        <circle class="ci ${cls}" cx="${x(f.effect).toFixed(1)}" cy="${y}" r="4"><title>d = ${f.effect.toFixed(2)} (95% CI ${f.ci_low!.toFixed(2)} to ${f.ci_high!.toFixed(2)})</title></circle>`;
    })
    .join('');
  return `<svg class="chart forest" viewBox="0 0 ${width} ${height}" style="max-width:${width * 1.5}px" role="img" aria-label="Effect sizes with their 95% confidence intervals">
    <line class="grid" x1="${x(0)}" x2="${x(0)}" y1="12" y2="${height - 18}"/>
    <text class="tick" x="${x(0)}" y="${height - 4}" text-anchor="middle">0</text>
    <text class="tick" x="${x(-reach)}" y="${height - 4}">failed ran lower</text>
    <text class="tick" x="${x(reach)}" y="${height - 4}" text-anchor="end">failed ran higher</text>
    ${rows}
  </svg>`;
}
