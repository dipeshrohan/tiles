// The warning performance page's logic (T3.10), apart from the page: the choices it offers, how
// its numbers read, and the codes typed into it.

import type { Distribution, Scores } from './api.ts';

export const PERIODS = [1, 7, 30, 90] as const; // days
export const HORIZONS = [1, 2, 4, 8, 24] as const; // hours

// A share, rounded down to a tenth of a percent, so one just short of all never reads as 100%.
export function share(x: number | null): string {
  return x === null ? '–' : `${(Math.floor(x * 1000) / 10).toFixed(1)}%`;
}

// A length of time as people say it.
export function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

export function spread(d: Distribution | null): string {
  return d ? `${duration(d.median)} (${duration(d.p10)} to ${duration(d.p90)})` : '–';
}

// The codes typed in: split at commas or line breaks, trimmed, each once, at most 50.
export function parseCodes(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((c) => c.trim())
        .filter(Boolean),
    ),
  ].slice(0, 50);
}

export interface Kpi {
  label: string;
  value: string;
  note: string;
  tone: '' | 'good' | 'bad';
}

// The headline numbers: how many events had a warning in time, how many warnings an event followed,
// what people said of them, and how far ahead the warnings came.
export function kpis(t: Scores): Kpi[] {
  const judged = t.confirmed.true_alarm + t.confirmed.false_alarm;
  return [
    {
      label: 'Events warned of',
      value: share(t.recall),
      note: `${t.caught} of ${t.events} downtime or scrap event(s)`,
      tone: t.recall === null ? '' : t.recall >= 0.5 ? 'good' : 'bad',
    },
    {
      label: 'Warnings an event followed',
      value: share(t.precision),
      note: `${t.true_warnings} of ${t.true_warnings + t.false_warnings}${t.pending_warnings ? `; ${t.pending_warnings} too recent to tell` : ''}`,
      tone: '',
    },
    {
      label: 'Confirmed true by people',
      value: share(judged ? t.confirmed.true_alarm / judged : null),
      note: `${t.confirmed.true_alarm} true, ${t.confirmed.false_alarm} false, ${t.confirmed.unknown} unknown, ${t.confirmed.unresolved} open`,
      tone: '',
    },
    {
      label: 'Warning time (median)',
      value: t.warning_seconds ? duration(t.warning_seconds.median) : '–',
      note: t.warning_seconds
        ? `${duration(t.warning_seconds.p10)} to ${duration(t.warning_seconds.p90)} (10th to 90th percentile)`
        : 'no event warned of yet',
      tone: '',
    },
  ];
}
