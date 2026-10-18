// Similar past warnings (T10.02): what the API found for a warning, said in words.
import type { SimilarWarning, SimilarWarnings } from './api.ts';
import { duration, percent } from './format.ts';
import { t, type MessageKey } from './i18n.ts';

const HOUR = 3_600_000;

const KINDS: Record<NonNullable<SimilarWarning['followed']>['kind'], MessageKey> = {
  downtime: 'similar.followed.downtime',
  scrap: 'similar.followed.scrap',
  other: 'similar.followed.other',
};

// What followed a past warning: the first event of its machine within a day, or nothing.
export function followedText(w: SimilarWarning): string {
  if (!w.followed) return t('similar.followed.nothing');
  return t(KINDS[w.followed.kind], { code: w.followed.code, after: duration(w.followed.hours_after * HOUR) });
}

// How alike, as a share.
export const match = (w: SimilarWarning): string => percent(w.score);

// One line over the list: how the similar ones ended, and how many an event followed.
export function summary(s: SimilarWarnings): string {
  const o = s.outcomes;
  return t('similar.summary', {
    count: s.similar.length,
    trueAlarms: o.true_alarm,
    falseAlarms: o.false_alarm,
    open: o.open + o.unknown,
    followed: s.followed,
  });
}

// Why a batch table is suggested.
const WHY: Record<SimilarWarnings['datasets'][number]['why'], MessageKey> = {
  name: 'similar.why.name',
  column: 'similar.why.column',
  value: 'similar.why.value',
};
export const whyText = (d: SimilarWarnings['datasets'][number], asset: string | null, tag: string): string =>
  t(WHY[d.why], { asset: asset ?? tag, tag });
