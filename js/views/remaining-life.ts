// Remaining life on the Plant page (T9.01): each component at or under a place, its time to its
// wear limit with an interval, soonest first. Asked once per site and place, again on Refresh.
import type { ComponentLife, RemainingLife } from '../lib/api.ts';
import { esc, onNavigate, routeOf } from '../lib/dom.ts';
import { dateTime, duration, number } from '../lib/format.ts';
import { t } from '../lib/i18n.ts';
import { card, linkButton, loadFailed, skeleton, table } from '../lib/ui.ts';
import { draftHref } from '../lib/work-orders.ts';
import type { Context } from './types.ts';

let life: { key: string; data: RemainingLife | null | 'failed' } | null = null;
let asked = 0; // only the latest request's answer is shown
const keyOf = (ctx: Context, place: string): string => `${ctx.ontology.site?.id ?? ''}|${place}`;

// Readings come in all the time: coming back asks again.
onNavigate((hash) => {
  if (routeOf(hash) !== 'plant') life = null;
});

export async function loadLife(ctx: Context, place: string, redraw = false): Promise<void> {
  const site = ctx.ontology.site?.id;
  if (!ctx.api || !site) return;
  const key = keyOf(ctx, place);
  const mine = ++asked;
  life = { key, data: null };
  if (redraw) ctx.rerender();
  let data: RemainingLife | 'failed';
  try {
    data = await ctx.api.remainingLife(site, place);
  } catch {
    data = 'failed'; // the client showed why
  }
  if (mine === asked && life?.key === key) {
    life = { key, data };
    ctx.rerender();
  }
}

// Asked when the card is drawn and nothing is known yet for this place.
export function lifeWanted(ctx: Context, place: string): boolean {
  return life?.key !== keyOf(ctx, place);
}

const HOUR = 3_600_000;
const value = (x: number | null, unit: string | null): string =>
  x === null ? '–' : unit ? `${number(x, 1)} ${unit}` : number(x, 1); // i18n-ok

const YEAR_HOURS = 365 * 24;
// A time to show: past a year it is "over a year", whatever the slope's last digits make it.
const span = (hours: number): string => (hours > YEAR_HOURS ? t('plant.life.overYear') : duration(hours * HOUR));

// When it reaches its limit: now, in about some time (earliest to latest), maybe, or not at this pace.
export function timeLeft(c: ComponentLife): string {
  if (c.verdict === 'not_enough_data') return t('plant.life.noData');
  if (c.hours_to_limit === null)
    return c.hours_earliest === null
      ? t('plant.life.never')
      : t('plant.life.maybe', { earliest: span(c.hours_earliest) });
  if (c.hours_to_limit === 0) return t('plant.life.now');
  const at = span(c.hours_to_limit);
  if (c.hours_earliest === null) return t('plant.life.in', { duration: at });
  const earliest = span(c.hours_earliest);
  return c.hours_latest === null
    ? t('plant.life.inOrNever', { duration: at, earliest })
    : t('plant.life.inBetween', { duration: at, earliest, latest: span(c.hours_latest) });
}

// The next planned stop before the predicted limit (T9.03), or that there is none in time.
export function windowCell(c: ComponentLife): string {
  if (!c.window_needed) return `<td class="soft">–</td>`;
  if (!c.window) return `<td class="text-bad">${esc(t('plant.life.noWindow'))}</td>`;
  const when = dateTime(c.window.starts_at);
  const text = c.window.reason
    ? t('plant.life.windowReason', { reason: c.window.reason, when })
    : t('plant.life.window', { when });
  const late = c.window_safe === false ? ` <span class="badge warn">${esc(t('plant.life.windowLate'))}</span>` : '';
  return `<td>${esc(text)}${late}</td>`;
}

export function lifeCard(ctx: Context, place: string, onMachine = false): string {
  if (!ctx.api || !ctx.ontology.site) return '';
  const shown = life?.key === keyOf(ctx, place) ? life.data : null;
  const head = `<div class="card-head"><h2>${esc(t('plant.life.title'))}</h2></div>`;
  const attrs = { attrs: { 'data-life': '' } };
  if (shown === 'failed') return card(`${head}${loadFailed(t('plant.life.title'), 3)}`, attrs);
  if (!shown) return card(`${head}${skeleton.table(2, 4, t('plant.life.loading'))}`, attrs);
  if (!shown.components.length) return card(`${head}<p class="small soft">${esc(t('plant.life.none'))}</p>`, attrs);
  const canEdit = ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';
  // Engineers draft a work order for a component heading for its limit (T9.02).
  const draftCell = (c: ComponentLife): string =>
    canEdit
      ? `<td class="no-print">${
          c.window_needed
            ? linkButton(
                t('workOrders.draftLink'),
                draftHref(
                  'component',
                  c.signal_id,
                  t('workOrders.titleFor.component', { component: c.component, machine: c.machine_label }),
                ),
                {
                  size: 'sm',
                  variant: 'ghost',
                  attrs: { 'aria-label': t('workOrders.draftNamed', { component: c.component }) },
                },
              )
            : ''
        }</td>`
      : '';
  const rows = shown.components
    .map((c) => {
      const soon = c.hours_to_limit !== null && c.hours_to_limit <= 7 * 24;
      return `<tr data-key="${esc(c.signal_id)}">
          ${onMachine ? '' : `<td>${esc(c.machine_label)}</td>`}
          <td>${esc(c.component)} <span class="small soft mono">${esc(c.tag)}</span></td>
          <td>${esc(value(c.level, c.unit))} / ${esc(value(c.limit, c.unit))}</td>
          <td${soon ? ' class="text-bad"' : c.verdict === 'not_enough_data' ? ' class="soft"' : ''}>${esc(timeLeft(c))}</td>
          ${windowCell(c)}
          ${draftCell(c)}
        </tr>`;
    })
    .join('');
  return card(
    `${head}
      <p class="small soft">${esc(t('plant.life.lead'))}</p>
      ${table({
        headers: [
          ...(onMachine ? [] : [t('plant.coverage.machine')]),
          t('plant.life.component'),
          t('plant.life.level'),
          t('plant.life.left'),
          t('plant.life.windowHead'),
          ...(canEdit ? [{ label: t('workOrders.col.actions'), srOnly: true }] : []),
        ],
        rowsHtml: rows,
      })}
      ${shown.more ? `<p class="small soft">${esc(t('plant.life.more'))}</p>` : ''}`,
    attrs,
  );
}
