// App Studio (T6.10), pure: a template's settings as a form, the form read back and checked as the
// API checks it, and an app's result as a chart. The App Studio page draws them.

import { esc } from './dom.ts';
import type { AppConfig, AppParam, AppResult, AppTemplate } from './api.ts';
import type { TimeChartOptions, TimePoint } from './svg.ts';
import type { FieldError } from './forms.ts';

export const appLink = (n: number): string => `#/apps/${n}`;

// The app number in `#/apps/<n>`, if any.
export function appNumberFromHash(hash: string): number | null {
  const m = hash.match(/^#\/apps\/(\d+)(?:[?/]|$)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function defaultConfig(t: AppTemplate): AppConfig {
  return Object.fromEntries(t.params.map((p) => [p.name, p.default ?? null]));
}

export interface SignalOption {
  id: string;
  tag: string;
  unit: string | null;
}

// One setting as a form field, named after it; the template's limits are the input's too.
export function paramField(p: AppParam, value: unknown, signals: SignalOption[]): string {
  const id = `app-param-${p.name}`;
  const help = p.help ? ` <span class="small soft">${esc(p.help)}</span>` : '';
  const label = `${esc(p.label)}${p.optional ? ' <span class="small soft">(optional)</span>' : ''}${help}`;
  if (p.kind === 'signal') {
    const known = signals.some((s) => s.id === value);
    const options = [
      `<option value="" ${value ? '' : 'selected'} disabled>Choose a signal</option>`,
      ...(value && !known ? [`<option value="${esc(String(value))}" selected>${esc(String(value))}</option>`] : []),
      ...signals.map(
        (s) =>
          `<option value="${esc(s.id)}" ${s.id === value ? 'selected' : ''}>${esc(s.tag)}${s.unit ? ` (${esc(s.unit)})` : ''}</option>`,
      ),
    ];
    return `<label class="field" for="${id}">${label}<select id="${id}" name="${esc(p.name)}" ${p.optional ? '' : 'required'}>${options.join('')}</select></label>`;
  }
  if (p.kind === 'choice')
    return `<label class="field" for="${id}">${label}<select id="${id}" name="${esc(p.name)}">${p.choices
      .map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`)
      .join('')}</select></label>`;
  if (p.kind === 'choices') {
    const chosen = Array.isArray(value) ? value : [];
    return `<fieldset class="field app-choices"><legend>${label}</legend>${p.choices
      .map(
        ([v, l]) =>
          `<label class="row gap-2"><input type="checkbox" name="${esc(p.name)}" value="${esc(v)}" ${chosen.includes(v) ? 'checked' : ''} /> ${esc(l)}</label>`,
      )
      .join('')}</fieldset>`;
  }
  const bounds = `${p.minimum !== null ? ` min="${p.minimum}"` : ''}${p.maximum !== null ? ` max="${p.maximum}"` : ''}`;
  const step = p.kind === 'integer' ? '1' : 'any';
  const shown = typeof value === 'number' ? String(value) : '';
  return `<label class="field" for="${id}">${label}<input id="${id}" type="number" name="${esc(p.name)}" value="${shown}" step="${step}"${bounds} ${p.optional ? '' : 'required'} /></label>`;
}

// The settings as typed (`values`: each field's value, or the checked values of a `choices`), checked
// as the API does; the problems in words.
export function readConfig(
  t: AppTemplate,
  values: Record<string, string | string[]>,
): { config: AppConfig; problems: FieldError[] } {
  const config: AppConfig = {};
  const problems: FieldError[] = [];
  const problem = (p: AppParam, message: string) => problems.push({ name: p.name, message });
  for (const p of t.params) {
    const raw = values[p.name];
    if (p.kind === 'choices') {
      const chosen = (Array.isArray(raw) ? raw : []).filter((v) => p.choices.some(([c]) => c === v));
      if (!chosen.length) problem(p, `${p.label}: choose at least one`);
      config[p.name] = chosen;
      continue;
    }
    const text = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
    if (text === '') {
      if (!p.optional) problem(p, `${p.label} is needed`);
      config[p.name] = null;
      continue;
    }
    if (p.kind === 'signal' || p.kind === 'choice') {
      if (p.kind === 'choice' && !p.choices.some(([c]) => c === text)) problem(p, `${p.label}: choose one`);
      config[p.name] = text;
      continue;
    }
    const n = Number(text);
    if (!Number.isFinite(n)) problem(p, `${p.label} must be a number`);
    else if (p.kind === 'integer' && !Number.isInteger(n)) problem(p, `${p.label} must be a whole number`);
    else if ((p.minimum !== null && n < p.minimum) || (p.maximum !== null && n > p.maximum))
      problem(p, `${p.label} must be from ${p.minimum ?? '…'} to ${p.maximum ?? '…'}`);
    config[p.name] = n;
  }
  return { config, problems };
}

// A form's values by field name: checkboxes as the list of those checked.
export function formValues(form: HTMLFormElement): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      const list = (values[el.name] as string[] | undefined) ?? [];
      if (el.checked) list.push(el.value);
      values[el.name] = list;
    } else values[el.name] = el.value;
  }
  return values;
}

// The result as the chart draws it: the points, the reference levels and the shaded stretches.
export function resultChart(r: AppResult): Omit<TimeChartOptions, 'width'> {
  const points: TimePoint[] = r.points.map((p) => ({ t: Date.parse(p.at), v: p.value, lo: p.value, hi: p.value }));
  return {
    points,
    from: Date.parse(r.start),
    to: Date.parse(r.end),
    gap: r.gap_seconds * 1000,
    yLabel: r.unit ?? '',
    title: `${r.tag}${r.unit ? ` (${r.unit})` : ''}: ${r.headline}`,
    levels: r.levels.map((l) => ({ v: l.value, label: l.label })),
    spans: r.spans.map((s) => ({ from: Date.parse(s.from), to: Date.parse(s.to) })),
  };
}

export function statusBadge(status: AppResult['status']): string {
  const tone = { ok: 'good', alert: 'bad', no_data: '' }[status];
  const text = { ok: 'OK', alert: 'Alert', no_data: 'No data' }[status];
  return `<span class="badge ${tone}">${text}</span>`;
}

export function factText(f: AppResult['facts'][number]): string {
  if (f.format === 'percent') return `${(f.value * 100).toFixed(1)}%`;
  const abs = Math.abs(f.value);
  return abs !== 0 && abs < 1 ? f.value.toPrecision(3) : f.value.toLocaleString('en-GB', { maximumFractionDigits: 1 });
}

// The settings in words, for the app's page: each label and its value (a signal by its tag).
export function configSummary(t: AppTemplate | undefined, config: AppConfig, signalTag: string | null): string[] {
  if (!t) return Object.entries(config).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return t.params.map((p) => {
    const v = config[p.name];
    if (v === null || v === undefined) return `${p.label}: none`;
    if (p.kind === 'signal') return `${p.label}: ${signalTag ?? 'a signal no longer on this site'}`;
    if (p.kind === 'choice') return `${p.label}: ${p.choices.find(([c]) => c === v)?.[1] ?? String(v)}`;
    if (p.kind === 'choices')
      return `${p.label}: ${(Array.isArray(v) ? v : []).map((x) => p.choices.find(([c]) => c === x)?.[1] ?? String(x)).join('; ')}`;
    return `${p.label}: ${String(v)}`;
  });
}
