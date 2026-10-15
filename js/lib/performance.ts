// The warning performance page's logic (T3.10), apart from the page: the choices it offers, how
// its numbers read, and the codes typed into it.

import type { Distribution, Scores } from './api.ts';
import type { GlossaryKey } from './glossary-data.ts';
import { t } from './i18n.ts';
import { duration as lengthOfTime } from './format.ts';

export const PERIODS = [1, 7, 30, 90] as const; // days
export const HORIZONS = [1, 2, 4, 8, 24] as const; // hours

// A share, rounded down to a tenth of a percent, so one just short of all never reads as 100%.
export function share(x: number | null): string {
  return x === null ? '–' : `${(Math.floor(x * 1000) / 10).toFixed(1)}%`;
}

// A length of time as people say it (format.ts, writing.md).
export const duration = (seconds: number): string => lengthOfTime(seconds * 1000);

export function spread(d: Distribution | null): string {
  return d ? t('performance.spread', { median: duration(d.median), p10: duration(d.p10), p90: duration(d.p90) }) : '–';
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
  term?: GlossaryKey; // the glossary's name for it (U4.05), explained beside the label
}

// The headline numbers: how many events had a warning in time, how many warnings an event followed,
// what people said of them, and how far ahead the warnings came.
export function kpis(s: Scores): Kpi[] {
  const judged = s.confirmed.true_alarm + s.confirmed.false_alarm;
  return [
    {
      label: t('performance.kpi.recall'),
      value: share(s.recall),
      note: t('performance.kpi.recallNote', { caught: s.caught, events: s.events }),
      term: 'recall',
      tone: s.recall === null ? '' : s.recall >= 0.5 ? 'good' : 'bad',
    },
    {
      label: t('performance.kpi.precision'),
      value: share(s.precision),
      note: t(s.pending_warnings ? 'performance.kpi.precisionPending' : 'performance.kpi.precisionNote', {
        n: s.true_warnings,
        total: s.true_warnings + s.false_warnings,
        pending: s.pending_warnings,
      }),
      term: 'precision',
      tone: '',
    },
    {
      label: t('performance.kpi.confirmed'),
      value: share(judged ? s.confirmed.true_alarm / judged : null),
      note: t('performance.kpi.confirmedNote', {
        yes: s.confirmed.true_alarm,
        no: s.confirmed.false_alarm,
        unknown: s.confirmed.unknown,
        open: s.confirmed.unresolved,
      }),
      tone: '',
    },
    {
      label: t('performance.kpi.warningTime'),
      value: s.warning_seconds ? duration(s.warning_seconds.median) : '–',
      note: s.warning_seconds
        ? t('performance.kpi.warningTimeNote', {
            p10: duration(s.warning_seconds.p10),
            p90: duration(s.warning_seconds.p90),
          })
        : t('performance.kpi.noneYet'),
      term: 'warning-time',
      tone: '',
    },
  ];
}
