// The wear check (T3.13) in the Data explorer, apart from the page: which windows and buckets to
// ask for over the range shown, and the result as a badge and a chart.

import type { WearCheckQuery, WearCheckResult } from './api.ts';
import { esc } from './dom.ts';
import { term } from './ui.ts';
import { TIME_CHART, timeChart } from './svg.ts';
import { t, tHtml, type MessageKey } from './i18n.ts';

const HOUR = 3_600_000;
// Bucket lengths to choose from, in minutes: the shortest that keeps the range to at most 400.
const STEPS = [1, 5, 15, 30, 60, 120, 240, 360, 720, 1440];
const MAX_BUCKETS = 400;
const MAX_SPAN_HOURS = 24 * 120; // as the API allows

// The check over a range: the recent window is its last day (at most a quarter of it), the
// baseline the rest; both whole buckets. A string says why the range can't be checked.
export function wearPlan(range: { from: string; to: string }): WearCheckQuery | string {
  const to = Date.parse(range.to);
  const spanHours = (to - Date.parse(range.from)) / HOUR;
  if (!(spanHours > 0)) return t('wear.chooseRange');
  if (spanHours > MAX_SPAN_HOURS) return t('wear.tooLong');
  const step = STEPS.find((m) => (spanHours * 60) / m <= MAX_BUCKETS) ?? 1440;
  const buckets = Math.floor((spanHours * 60) / step);
  // At least four buckets: long ranges' buckets are long, and their last day may hold fewer.
  const recent = Math.max(4, Math.min(Math.floor((24 * 60) / step), Math.floor(buckets / 4)));
  if (recent < 4 || buckets - recent < 6) return t('wear.tooShort');
  return {
    end: new Date(to).toISOString(),
    recent_hours: (recent * step) / 60,
    baseline_hours: ((buckets - recent) * step) / 60,
    bucket_minutes: step,
  };
}

// A limit typed in, or null; a string says why not. Commas group thousands (1,900), as the
// check's own sentences write them.
export function parseLimit(text: string): number | null | string {
  const typed = text.trim();
  if (!typed) return null;
  const n = Number(typed.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : t('wear.limitNumber');
}

const VERDICT: Record<WearCheckResult['verdict'], [string, MessageKey]> = {
  wearing: ['bad', 'wear.verdict.wearing'],
  stable: ['good', 'wear.verdict.stable'],
  not_enough_data: ['', 'wear.verdict.notEnoughData'],
};

export function wearBlock(r: WearCheckResult, limit: number | null, width = TIME_CHART.width): string {
  const [cls, labelKey] = VERDICT[r.verdict];
  const label = esc(t(labelKey));
  const levels = [
    ...(r.baseline !== null ? [{ v: r.baseline, label: t('wear.level.baseline') }] : []),
    ...(limit !== null ? [{ v: limit, label: t('wear.level.limit') }] : []),
  ];
  const points = r.buckets.map((b) => ({ t: Date.parse(b.at), v: b.value, lo: b.value, hi: b.value }));
  const bucketMs = points.length > 1 ? Math.min(...points.slice(1).map((p, i) => p.t - points[i]!.t)) : HOUR;
  const count = r.baseline_buckets + r.recent_buckets;
  const chart = timeChart({
    points,
    from: Date.parse(r.start),
    to: Date.parse(r.end),
    gap: bucketMs * 1.5,
    yLabel: r.unit ?? '',
    title: t('wear.chartTitle', { tag: r.tag, unit: r.unit ? ` (${r.unit})` : '' }),
    levels,
    spans: [{ from: Date.parse(r.recent_from), to: Date.parse(r.end) }],
    width,
  });
  return `<div class="stack gap-1_5" data-wear-result>
      <p><span class="badge ${cls}">${label}</span> ${esc(r.text)}</p>
      ${chart}
      <p class="small soft">${tHtml('wear.note', {
        medians: term('median', t('wear.medians')),
        count: esc(String(count)),
        buckets: term('bucket', t('wear.buckets', { count })),
        baseline: term('baseline', t('wear.baselineTerm')),
        wearCheck: term('wear-check', t('wear.wearCheckTerm')),
        slope: term('theilsen-slope', t('wear.theilSen')),
        timeToLimit: term('time-to-limit', t('wear.timeToLimit')),
      })}</p>
    </div>`;
}
