// The ROI report (T6.01): the pilot period against the baseline, made by the API (`POST
// /sites/{id}/roi`, roi.py). This is the browser's side: the form's values as the request, and the
// report's numbers as rows to show.
import { fromInput, inputValue } from './format.ts';
import type { FieldError } from './forms.ts';
import { t } from './i18n.ts';

export interface RoiRequest {
  baseline_start: string;
  baseline_end: string;
  pilot_start: string;
  pilot_end: string;
  horizon_hours: number;
  codes: string[];
  hours_per_stop: number | null;
  hours_source: string | null;
  cost_per_hour: number | null;
  cost_per_scrap: number | null;
  currency: string | null;
  baseline_parts: number | null;
  pilot_parts: number | null;
}

export interface RoiWarnings {
  warnings: number;
  events: number;
  caught: number;
  recall: number | null;
  precision: number | null;
  false_per_day: number | null;
  median_warning_seconds: number | null;
}

export interface RoiPeriod {
  start: string;
  end: string;
  days: number;
  parts: number | null;
  counts: { downtime: number; scrap: number };
  rates: { downtime: number | null; scrap: number | null }; // per day, or per 1,000 parts
  by_asset: { asset: string; downtime: number; scrap: number }[];
  warnings: RoiWarnings;
}

export interface RoiReport {
  periods: { baseline: RoiPeriod; pilot: RoiPeriod };
  avoided: { stops: number | null; downtime_hours: number | null; scrap: number | null; cost: number | null };
  inputs: Record<string, unknown>;
  digest: string; // SHA-256 of the inputs and every counted event
  markdown: string;
}

// A date input's value (2026-10-15) a number of days on, on the calendar.
function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// The form's first periods: the pilot is the last 30 days to today, the baseline the 90 before it.
export function defaultPeriods(now: number): Record<'baselineFrom' | 'baselineTo' | 'pilotFrom' | 'pilotTo', string> {
  const today = inputValue(now).slice(0, 10);
  const pilotFrom = addDays(today, -29);
  return { baselineFrom: addDays(pilotFrom, -90), baselineTo: addDays(pilotFrom, -1), pilotFrom, pilotTo: today };
}

// A day's start on the site's clock, as the API takes it (ISO, with its offset).
const dayStart = (day: string): number => fromInput(`${day}T00:00`);

export type RoiForm = Record<string, string>;

// The form's values as the request, or the fields that are wrong. Each period runs from the start
// of its first day to the end of its last, on the site's clock.
export function roiRequest(f: RoiForm, horizonHours: number, codes: string[]): RoiRequest | FieldError[] {
  const errors: FieldError[] = [];
  const day = (name: string): number => {
    const v = f[name] ?? '';
    const at = /^\d{4}-\d{2}-\d{2}$/.test(v) ? dayStart(v) : Number.NaN;
    if (Number.isNaN(at)) errors.push({ name, message: t('performance.roi.error.date') });
    return at;
  };
  const amount = (name: string): number | null => {
    const v = (f[name] ?? '').trim();
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) errors.push({ name, message: t('performance.roi.error.amount') });
    return n;
  };
  const bFrom = day('baselineFrom');
  const bTo = day('baselineTo');
  const pFrom = day('pilotFrom');
  const pTo = day('pilotTo');
  const end = (name: string, at: number) => (Number.isNaN(at) ? at : dayStart(addDays(f[name] ?? '', 1)));
  const bEnd = end('baselineTo', bTo);
  const pEnd = end('pilotTo', pTo);
  if (!errors.length) {
    if (bTo < bFrom) errors.push({ name: 'baselineTo', message: t('performance.roi.error.order') });
    if (pTo < pFrom) errors.push({ name: 'pilotTo', message: t('performance.roi.error.order') });
    if (bEnd > pFrom) errors.push({ name: 'baselineTo', message: t('performance.roi.error.overlap') });
  }
  // In the form's order, so the errors are too.
  const hours = amount('hoursPerStop');
  const costs = [amount('costPerHour'), amount('costPerScrap')] as const;
  const currency = (f.currency ?? '').trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency))
    errors.push({ name: 'currency', message: t('performance.roi.error.currency') });
  const request = {
    hours_per_stop: hours,
    cost_per_hour: costs[0],
    cost_per_scrap: costs[1],
    baseline_parts: amount('baselineParts'),
    pilot_parts: amount('pilotParts'),
  };
  // Rates per 1,000 parts need both periods' volumes, each more than none.
  const parts = [
    ['baselineParts', request.baseline_parts],
    ['pilotParts', request.pilot_parts],
  ] as const;
  if (parts.some(([, n]) => n !== null))
    for (const [name, n] of parts)
      if (!n && !errors.some((e) => e.name === name)) errors.push({ name, message: t('performance.roi.error.parts') });
  if (errors.length) return errors;
  const iso = (at: number) => new Date(at).toISOString();
  return {
    baseline_start: iso(bFrom),
    baseline_end: iso(bEnd),
    pilot_start: iso(pFrom),
    pilot_end: iso(pEnd),
    horizon_hours: horizonHours,
    codes,
    hours_source: (f.hoursSource ?? '').trim() || null,
    currency: currency || null,
    ...request,
  };
}

// A rate's change from the baseline, as a share (−0.4: 40% fewer), or null when there is none to compare.
export function change(before: number | null, after: number | null): number | null {
  return before === null || after === null || before === 0 ? null : (after - before) / before;
}

// The file the report downloads as: roi-<pilot's first day>-<last day>.md.
// Its days on the site's clock: the period's first, and the day its end (a midnight) closes.
export function fileName(r: RoiReport): string {
  const day = (at: number) => inputValue(at).slice(0, 10);
  return `roi-${day(Date.parse(r.periods.pilot.start))}-${day(Date.parse(r.periods.pilot.end) - 1)}.md`;
}
