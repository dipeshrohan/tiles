// The warnings inbox's logic (T3.08), apart from the page: its filters as an API query, which
// actions someone may take on a warning, the stretch of time its chart shows, and how its
// activity and payload read.

import { oneOf } from './url-state.ts';
import type { WarningActivity, WarningDetail, WarningInfo, WarningOutcome, WarningQuery } from './api.ts';
import { t } from './i18n.ts';
import { dateTime, upTo } from './format.ts';

export type Show = 'unresolved' | 'raised' | 'acknowledged' | 'resolved' | 'all';
export type Who = 'anyone' | 'me' | 'none';
export type SignalState = 'all' | 'open' | 'ended';

export interface Filters {
  show: Show;
  who: Who;
  signal: SignalState;
}

export const DEFAULT_FILTERS: Filters = { show: 'unresolved', who: 'anyone', signal: 'all' };

const SHOWS: readonly Show[] = ['unresolved', 'raised', 'acknowledged', 'resolved', 'all'];
const WHOS: readonly Who[] = ['anyone', 'me', 'none'];
const SIGNALS: readonly SignalState[] = ['all', 'open', 'ended'];

// The filters in the page's address (U3.05): `?show=all&who=me&signal=open`, defaults left out.
export function filtersFromQuery(params: URLSearchParams): Filters {
  return {
    show: oneOf(params.get('show'), SHOWS, DEFAULT_FILTERS.show),
    who: oneOf(params.get('who'), WHOS, DEFAULT_FILTERS.who),
    signal: oneOf(params.get('signal'), SIGNALS, DEFAULT_FILTERS.signal),
  };
}
export function filtersQuery(f: Filters): Record<string, string | null> {
  return {
    show: f.show === DEFAULT_FILTERS.show ? null : f.show,
    who: f.who === DEFAULT_FILTERS.who ? null : f.who,
    signal: f.signal === DEFAULT_FILTERS.signal ? null : f.signal,
  };
}

// Getters: the words are read when shown, in the language of the moment.
export const SHOW_LABELS: Record<Show, string> = {
  get unresolved() {
    return t('warnings.show.unresolved');
  },
  get raised() {
    return t('warnings.show.raised');
  },
  get acknowledged() {
    return t('warnings.show.acknowledged');
  },
  get resolved() {
    return t('warnings.show.resolved');
  },
  get all() {
    return t('warnings.show.all');
  },
};

type StatusLook = [cls: 'bad' | 'warn' | 'good', label: string];
export const STATUS: Record<WarningInfo['status'], StatusLook> = {
  get raised(): StatusLook {
    return ['bad', t('warnings.show.raised')];
  },
  get acknowledged(): StatusLook {
    return ['warn', t('warnings.show.acknowledged')];
  },
  get resolved(): StatusLook {
    return ['good', t('warnings.show.resolved')];
  },
};

export const OUTCOMES: Record<WarningOutcome, string> = {
  get true_alarm() {
    return t('warnings.outcomes.trueAlarm');
  },
  get false_alarm() {
    return t('warnings.outcomes.falseAlarm');
  },
  get unknown() {
    return t('warnings.outcomes.unknown');
  },
};

export function queryFor(f: Filters): WarningQuery {
  return {
    status: f.show,
    ...(f.who === 'anyone' ? {} : { assignee: f.who }),
    ...(f.signal === 'all' ? {} : { state: f.signal }),
  };
}

export type Action = 'acknowledge' | 'assign' | 'resolve' | 'reopen' | 'comment';

// What someone with `role` may do to the warning now (the API checks the same).
export function actionsFor(w: Pick<WarningInfo, 'status'>, role: string | null): Action[] {
  if (role !== 'engineer' && role !== 'admin') return [];
  if (w.status === 'resolved') return ['reopen', 'comment'];
  return [...(w.status === 'raised' ? (['acknowledge'] as const) : []), 'assign', 'resolve', 'comment'];
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

// When something happened, as a shift reads it: minutes or hours ago today, else the date and time.
export function when(iso: string, now: number): string {
  const at = Date.parse(iso);
  const ago = now - at;
  if (ago >= 0 && ago < MINUTE) return t('warnings.ago.justNow');
  if (ago >= 0 && ago < HOUR) return t('warnings.ago.minutes', { n: Math.floor(ago / MINUTE) });
  if (ago >= 0 && ago < 12 * HOUR) return t('warnings.ago.hours', { n: Math.floor(ago / HOUR) });
  return dateTime(at, { zone: false });
}

// The time the chart shows: the warning, with twice its length (at least an hour) before it for
// the signal's normal behaviour, and half that after it, up to now.
export function chartRange(w: Pick<WarningInfo, 'started_at' | 'last_at' | 'ended_at'>, now: number) {
  const start = Date.parse(w.started_at);
  const end = Date.parse(w.ended_at ?? w.last_at);
  const pad = Math.max(2 * (end - start), HOUR);
  return { from: start - pad, to: Math.max(end, Math.min(now, end + pad / 2)), start, end };
}

const num = (x: number): string => {
  const abs = Math.abs(x);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return upTo(x, digits);
};

// How far out it went: the peak against the threshold, as a multiple of the allowed spread.
export function howFar(w: Pick<WarningInfo, 'peak' | 'baseline' | 'threshold' | 'side'>): string {
  const allowed = w.threshold - w.baseline;
  const times = allowed ? (w.peak - w.baseline) / allowed : NaN;
  const values = {
    peak: num(w.peak),
    side: w.side === 'above' ? 'above' : 'below',
    threshold: num(w.threshold),
    baseline: num(w.baseline),
  };
  return Number.isFinite(times)
    ? t('warnings.howFarSpread', { ...values, times: upTo(times, 1) })
    : t('warnings.howFar', values);
}

export function activityText(a: WarningActivity): string {
  const who = a.actor ?? t('warnings.detail.someone');
  switch (a.action) {
    case 'raised':
      return t('warnings.activity.raised');
    case 'acknowledged':
      return t('warnings.activity.acknowledged', { who });
    case 'assigned':
      return t('warnings.activity.assigned', { who, assignee: a.assignee ?? t('warnings.detail.someone') });
    case 'unassigned':
      return t('warnings.activity.unassigned', { who });
    case 'resolved':
      return t('warnings.activity.resolved', {
        who,
        outcome: a.outcome ? OUTCOMES[a.outcome].toLowerCase() : t('warnings.activity.noOutcome'),
      });
    case 'reopened':
      return t('warnings.activity.reopened', { who });
    case 'commented':
      return t('warnings.activity.commented', { who });
  }
}

// The warning's payload: what the detector saw and was set to, as label and value rows.
export function payload(w: WarningDetail): [string, string][] {
  const settings = Object.entries(w.detector_config).map(
    ([k, v]) => [t('warnings.payload.detectorSetting', { name: k.replace(/_/g, ' ') }), String(v)] as [string, string],
  );
  return [
    [t('warnings.payload.signal'), w.signal_tag],
    [t('warnings.payload.detector'), w.detector],
    [t('warnings.payload.side'), w.side],
    [t('warnings.payload.peak'), num(w.peak)],
    [t('warnings.payload.threshold'), num(w.threshold)],
    [t('warnings.payload.baseline'), num(w.baseline)],
    [t('warnings.payload.readingsOut'), String(w.readings)],
    [t('warnings.payload.started'), w.started_at],
    [t('warnings.payload.lastOut'), w.last_at],
    [t('warnings.payload.backIn'), w.ended_at ?? t('warnings.stillOut')],
    ...settings,
  ];
}
