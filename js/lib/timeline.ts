// The machine timeline (T10.01): what the API gives for one machine and range, made into the lanes
// drawn over its charts and the list of everything in time order.
import type { MachineTimeline } from './api.ts';
import { dateTime } from './format.ts';
import { t, type MessageKey } from './i18n.ts';
import type { Lane } from './svg.ts';

export const RANGES = ['day', 'week', 'month'] as const;
export type Range = (typeof RANGES)[number];
const DAY = 86_400_000;
export const RANGE_MS: Record<Range, number> = { day: DAY, week: 7 * DAY, month: 30 * DAY };

// The range ending at `now`, as the API takes it.
export function rangeOf(range: Range, now: number): { from: string; to: string } {
  return { from: new Date(now - RANGE_MS[range]).toISOString(), to: new Date(now).toISOString() };
}

export type ItemKind = 'warning' | 'downtime' | 'scrap' | 'other' | 'planned' | 'change';
export interface Item {
  at: number;
  to?: number; // a stretch: a warning, a planned stop
  kind: ItemKind;
  what: string; // the detector, the code, the reason, the commit's message or the change
  detail: string; // the tag, the author, the outcome
  warning?: string; // its id, to open it
  ongoing?: boolean; // a warning still out: `to` is the range's end
  plannedDowntime?: boolean;
}

// The audit log's actions said in words; another one (a later version's) as it is.
const ACTIONS: Record<string, MessageKey> = {
  'signal.update': 'timeline.action.signalUpdate', // i18n-ok
  'detector.create': 'timeline.action.detectorCreate', // i18n-ok
  'detector.update': 'timeline.action.detectorUpdate', // i18n-ok
  'detector.run': 'timeline.action.detectorRun', // i18n-ok
  'detector.stop': 'timeline.action.detectorStop', // i18n-ok
};

const STATUS: Record<MachineTimeline['warnings'][number]['status'], MessageKey> = {
  open: 'timeline.status.open',
  acknowledged: 'timeline.status.acknowledged',
  resolved: 'timeline.status.resolved',
};
const OUTCOME: Record<NonNullable<MachineTimeline['warnings'][number]['outcome']>, MessageKey> = {
  true_alarm: 'timeline.outcome.trueAlarm',
  false_alarm: 'timeline.outcome.falseAlarm',
  unknown: 'timeline.outcome.unknown',
};

// Everything in the timeline, oldest first; a warning still out runs to the range's end.
export function itemsOf(tl: MachineTimeline): Item[] {
  const end = Date.parse(tl.end);
  const items: Item[] = [
    ...tl.warnings.map((w) => ({
      at: Date.parse(w.started_at),
      to: w.ended_at ? Date.parse(w.ended_at) : end,
      kind: 'warning' as const,
      what: w.detector,
      detail: w.outcome
        ? t('timeline.warningResolved', { tag: w.tag, outcome: t(OUTCOME[w.outcome]) })
        : t('timeline.warningStatus', { tag: w.tag, status: t(STATUS[w.status]) }),
      warning: w.id,
      ongoing: !w.ended_at,
    })),
    ...tl.events.map((e) => ({
      at: Date.parse(e.at),
      kind: e.kind,
      what: e.code,
      detail: e.planned ? t('timeline.plannedDowntime', { tag: e.tag }) : e.tag,
      plannedDowntime: e.planned,
    })),
    ...tl.planned.map((p) => ({
      at: Date.parse(p.starts_at),
      to: Date.parse(p.ends_at),
      kind: 'planned' as const,
      what: p.reason || t('timeline.plannedStop'),
      detail: p.asset ?? t('timeline.wholeSite'),
    })),
    ...tl.changes.map((c) => {
      const action = ACTIONS[c.action];
      return {
        at: Date.parse(c.at),
        kind: 'change' as const,
        what: c.kind === 'ontology' ? c.action : action ? t(action, { subject: c.subject }) : c.action,
        detail:
          c.kind === 'ontology'
            ? t('timeline.commit', { number: c.subject, author: c.author ?? '' })
            : (c.author ?? ''),
      };
    }),
  ];
  return items.sort((a, b) => a.at - b.at);
}

// The lanes over the charts: warnings, stops (downtime), other events, planned stops, changes.
export function lanesOf(items: Item[]): Lane[] {
  const mark = (i: Item) => ({
    from: i.at,
    ...(i.to === undefined ? {} : { to: i.to }),
    label: i.detail
      ? t('timeline.markLabel', { when: dateTime(i.at), what: i.what, detail: i.detail })
      : t('timeline.markShort', { when: dateTime(i.at), what: i.what }),
  });
  const lane = (label: string, color: string, kinds: ItemKind[]): Lane => ({
    label,
    color,
    marks: items.filter((i) => kinds.includes(i.kind)).map(mark),
  });
  return [
    lane(t('timeline.lane.warnings'), 'var(--bad)', ['warning']),
    lane(t('timeline.lane.stops'), 'var(--warn)', ['downtime']),
    lane(t('timeline.lane.events'), 'var(--accent)', ['scrap', 'other']),
    lane(t('timeline.lane.planned'), 'var(--soft)', ['planned']),
    lane(t('timeline.lane.changes'), 'var(--good)', ['change']),
  ];
}

export const KIND_LABEL: Record<ItemKind, MessageKey> = {
  warning: 'timeline.kind.warning',
  downtime: 'timeline.kind.downtime',
  scrap: 'timeline.kind.scrap',
  other: 'timeline.kind.other',
  planned: 'timeline.kind.planned',
  change: 'timeline.kind.change',
};
