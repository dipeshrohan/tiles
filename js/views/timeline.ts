// The machine timeline on the Plant page (T10.01): a machine's warnings, events, planned stops and
// changes as lanes over its readings, on one time axis, and the list of them, newest first. Asked
// once per site, machine and range, again on Refresh.
import type { MachineTimeline } from '../lib/api.ts';
import { bound, esc, onNavigate, routeOf } from '../lib/dom.ts';
import { dateTime } from '../lib/format.ts';
import { t, type MessageKey } from '../lib/i18n.ts';
import { gapFor, laneChart, timeChart, toPoints } from '../lib/svg.ts';
import { itemsOf, KIND_LABEL, lanesOf, RANGES, rangeOf, type Range } from '../lib/timeline.ts';
import { card, loadFailed, skeleton, table, tabs } from '../lib/ui.ts';
import type { Context } from './types.ts';

const SHOWN = 100; // rows of the list
const RANGE_LABEL: Record<Range, MessageKey> = {
  day: 'timeline.range.day',
  week: 'timeline.range.week',
  month: 'timeline.range.month',
};

let range: Range = 'week';
let shown: { key: string; data: MachineTimeline | null | 'failed' } | null = null;
let asked = 0; // only the latest request's answer is shown
const keyOf = (ctx: Context, machine: string): string => `${ctx.ontology.site?.id ?? ''}|${machine}|${range}`;

// Readings come in all the time: coming back asks again.
onNavigate((hash) => {
  if (routeOf(hash) !== 'plant') shown = null;
});

export async function loadTimeline(ctx: Context, machine: string, redraw = false): Promise<void> {
  const site = ctx.ontology.site?.id;
  if (!ctx.api || !site) return;
  const key = keyOf(ctx, machine);
  const mine = ++asked;
  shown = { key, data: null };
  if (redraw) ctx.rerender();
  const { from, to } = rangeOf(range, Date.now());
  let data: MachineTimeline | 'failed';
  try {
    data = await ctx.api.timeline(site, machine, from, to);
  } catch {
    data = 'failed'; // the client showed why
  }
  if (mine === asked && shown?.key === key) {
    shown = { key, data };
    ctx.rerender();
  }
}

// Asked when the card is drawn and nothing is known yet for this machine and range.
export function timelineWanted(ctx: Context, machine: string): boolean {
  return shown?.key !== keyOf(ctx, machine);
}

function body(tl: MachineTimeline): string {
  const from = Date.parse(tl.start);
  const to = Date.parse(tl.end);
  const items = itemsOf(tl);
  if (!items.length && !tl.signals.length) return `<p class="small soft">${esc(t('timeline.none'))}</p>`;
  const lanes = laneChart({ lanes: lanesOf(items), from, to, title: t('timeline.lanesTitle', { machine: tl.label }) });
  const charts = tl.signals
    .map((s) => {
      const points = toPoints(s);
      const spans = tl.warnings
        .filter((w) => w.tag === s.tag)
        .map((w) => ({ from: Date.parse(w.started_at), to: w.ended_at ? Date.parse(w.ended_at) : to }));
      return timeChart({ points, from, to, gap: gapFor(s, points), yLabel: s.unit ?? '', title: s.tag, spans });
    })
    .join('');
  const rows = [...items]
    .reverse()
    .slice(0, SHOWN)
    .map((i) => {
      const when =
        i.to === undefined ? dateTime(i.at) : t('timeline.fromTo', { from: dateTime(i.at), to: dateTime(i.to) });
      const what = i.warning
        ? `<a href="#/warnings?show=all&amp;warning=${encodeURIComponent(i.warning)}">${esc(i.what)}</a>`
        : esc(i.what);
      return `<tr><td class="nowrap">${esc(when)}</td><td>${esc(t(KIND_LABEL[i.kind]))}</td><td>${what} <span class="small soft">${esc(i.detail)}</span></td></tr>`;
    })
    .join('');
  return `${lanes}${charts}
    ${tl.more_signals ? `<p class="small soft">${esc(t('timeline.moreSignals', { count: tl.signals.length }))}</p>` : ''}
    ${
      items.length
        ? table({ headers: [t('timeline.when'), t('timeline.kind'), t('timeline.what')], rowsHtml: rows })
        : `<p class="small soft">${esc(t('timeline.nothing'))}</p>`
    }
    ${items.length > SHOWN ? `<p class="small soft">${esc(t('timeline.moreRows', { count: SHOWN }))}</p>` : ''}
    ${tl.more ? `<p class="small soft">${esc(t('timeline.more'))}</p>` : ''}`;
}

export function timelineCard(ctx: Context, machine: string): string {
  if (!ctx.api || !ctx.ontology.site) return '';
  const data = shown?.key === keyOf(ctx, machine) ? shown.data : null;
  const choose = tabs({
    label: t('timeline.range'),
    items: RANGES.map((r) => [r, t(RANGE_LABEL[r])] as const),
    current: range,
    data: 'timeline-range',
  });
  const head = `<div class="card-head"><h2>${esc(t('timeline.title'))}</h2>${choose}</div>`;
  const attrs = { attrs: { 'data-timeline': '' } };
  if (data === 'failed') return card(`${head}${loadFailed(t('timeline.title'), 3)}`, attrs);
  if (!data) return card(`${head}${skeleton.chart(t('timeline.loading'))}`, attrs);
  return card(`${head}<p class="small soft">${esc(t('timeline.lead'))}</p>${body(data)}`, attrs);
}

export function bindTimeline(root: HTMLElement, ctx: Context, machine: string): void {
  if (!root.querySelector('[data-timeline]')) return;
  if (timelineWanted(ctx, machine)) void loadTimeline(ctx, machine);
  root.querySelectorAll<HTMLButtonElement>('[data-timeline-range]').forEach((b) =>
    b.addEventListener(
      'click',
      () => {
        range = (b.dataset.timelineRange as Range | undefined) ?? 'week';
        void loadTimeline(ctx, machine, true);
      },
      { signal: bound() },
    ),
  );
}
