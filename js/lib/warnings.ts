// The warnings inbox's logic (T3.08), apart from the page: its filters as an API query, which
// actions someone may take on a warning, the stretch of time its chart shows, and how its
// activity and payload read.

import type { WarningActivity, WarningDetail, WarningInfo, WarningOutcome, WarningQuery } from './api.ts';

export type Show = 'unresolved' | 'raised' | 'acknowledged' | 'resolved' | 'all';
export type Who = 'anyone' | 'me' | 'none';
export type SignalState = 'all' | 'open' | 'ended';

export interface Filters {
  show: Show;
  who: Who;
  signal: SignalState;
}

export const DEFAULT_FILTERS: Filters = { show: 'unresolved', who: 'anyone', signal: 'all' };

export const SHOW_LABELS: Record<Show, string> = {
  unresolved: 'To do',
  raised: 'New',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  all: 'All',
};

export const STATUS: Record<WarningInfo['status'], [cls: 'bad' | 'warn' | 'good', label: string]> = {
  raised: ['bad', 'New'],
  acknowledged: ['warn', 'Acknowledged'],
  resolved: ['good', 'Resolved'],
};

export const OUTCOMES: Record<WarningOutcome, string> = {
  true_alarm: 'True alarm',
  false_alarm: 'False alarm',
  unknown: 'Unknown',
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
  const t = Date.parse(iso);
  const ago = now - t;
  if (ago >= 0 && ago < MINUTE) return 'just now';
  if (ago >= 0 && ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago >= 0 && ago < 12 * HOUR) return `${Math.floor(ago / HOUR)} h ago`;
  return new Date(t).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
  return x.toLocaleString('en-GB', { maximumFractionDigits: digits });
};

// How far out it went: the peak against the threshold, as a multiple of the allowed spread.
export function howFar(w: Pick<WarningInfo, 'peak' | 'baseline' | 'threshold' | 'side'>): string {
  const allowed = w.threshold - w.baseline;
  const times = allowed ? (w.peak - w.baseline) / allowed : NaN;
  const word = w.side === 'above' ? 'above' : 'below';
  return `Peak ${num(w.peak)}, ${word} the threshold of ${num(w.threshold)} (baseline ${num(w.baseline)}${
    Number.isFinite(times) ? `; ${times.toLocaleString('en-GB', { maximumFractionDigits: 1 })}× the allowed spread` : ''
  })`;
}

export function activityText(a: WarningActivity): string {
  const who = a.actor ?? 'someone';
  switch (a.action) {
    case 'raised':
      return 'Raised by the detector';
    case 'acknowledged':
      return `${who} acknowledged it`;
    case 'assigned':
      return `${who} assigned it to ${a.assignee ?? 'someone'}`;
    case 'unassigned':
      return `${who} unassigned it`;
    case 'resolved':
      return `${who} resolved it: ${a.outcome ? OUTCOMES[a.outcome].toLowerCase() : 'no outcome'}`;
    case 'reopened':
      return `${who} reopened it`;
    case 'commented':
      return `${who} commented`;
  }
}

// The warning's payload: what the detector saw and was set to, as label and value rows.
export function payload(w: WarningDetail): [string, string][] {
  const settings = Object.entries(w.detector_config).map(
    ([k, v]) => [`Detector ${k.replace(/_/g, ' ')}`, String(v)] as [string, string],
  );
  return [
    ['Signal', w.signal_tag],
    ['Detector', w.detector],
    ['Side', w.side],
    ['Peak', num(w.peak)],
    ['Threshold', num(w.threshold)],
    ['Baseline', num(w.baseline)],
    ['Readings out', String(w.readings)],
    ['Started', w.started_at],
    ['Last out', w.last_at],
    ['Back in', w.ended_at ?? 'still out'],
    ...settings,
  ];
}
