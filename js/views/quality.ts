import { correlationFinder, explain, wearCheck } from '../lib/analysis.ts';
import { CUTTER_VARIABLES, type CutterVariable } from '../lib/data.ts';
import { mean } from '../lib/stats.ts';
import { dumbbell, fitWidth, hbars, lineChart } from '../lib/svg.ts';
import { esc, fmt, need, onAll, signed, bound } from '../lib/dom.ts';
import type { Material } from '../lib/types.ts';
import type { Context, View } from './types.ts';
import { pageHead, term } from '../lib/ui.ts';
import { t, tHtml } from '../lib/i18n.ts';

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

interface QualityUi {
  split: boolean;
  variable: CutterVariable;
}

const uiState = (ctx: Context) => ctx.ui<QualityUi>('quality', { split: true, variable: 'tension' });

const view: View = {
  id: 'quality',
  get title() {
    return t('quality.title');
  },
  icon: 'gauge',
  render(ctx) {
    const ui = uiState(ctx);
    const rows = ctx.state.batches;
    const findings = correlationFinder(rows, CUTTER_VARIABLES, { splitBy: ui.split ? 'material' : null });
    const top = explain(findings);
    const ng = rows.filter((r) => r.ng).length;

    const v = CUTTER_VARIABLES.find((x) => x.key === ui.variable) ?? CUTTER_VARIABLES[0]!;
    const materials: Material[] = ['anode', 'cathode'];
    const dumb = materials.map((m) => {
      const sub = rows.filter((r) => r.material === m);
      return {
        label: t('quality.sheet', { material: m }),
        sub: m === 'anode' ? t('quality.anodeSub') : t('quality.cathodeSub'),
        a: mean(sub.filter((r) => r.ng).map((r) => r[v.key])),
        b: mean(sub.filter((r) => !r.ng).map((r) => r[v.key])),
      };
    });
    const all = dumb.flatMap((d) => [d.a, d.b]);
    const pad = (Math.max(...all) - Math.min(...all)) * 0.25 || 1;

    const effects = findings.slice(0, 8).map((f) => ({
      label: `${ui.split ? `${cap(f.segment)} · ` : ''}${f.label}`,
      value: f.effect,
      color: Math.abs(f.effect) >= 0.8 ? 'var(--bad)' : 'var(--line-strong)',
    }));

    const { series, swapAt, wearStart } = ctx.state.weld;
    const cat = wearCheck(series, 'cathode', { until: swapAt });
    const an = wearCheck(series, 'anode', { until: swapAt });
    const threshold = cat.baseline * 1.05;
    const crossed = series.findIndex((p, h) => h < swapAt && p.cathode > threshold);
    const warnHours = crossed >= 0 ? swapAt - crossed : 0;

    return `
      ${pageHead({
        eyebrow: t('quality.eyebrow'),
        title: t('quality.headTitle'),
        lead: t('quality.lead', { ng, total: rows.length }),
        actionsHtml: `<div class="seg" role="group" aria-label="${esc(t('quality.segmentation'))}">
          <button data-split="0" class="${ui.split ? '' : 'active'}">${esc(t('quality.pooled'))}</button>
          <button data-split="1" class="${ui.split ? 'active' : ''}">${esc(t('quality.split'))}</button>
        </div>`,
      })}

      <div class="grid g2 mb-4">
        <div class="card">
          <div class="card-head"><h2>${esc(t('quality.effects.title'))}</h2><p>${tHtml('quality.effects.hint', { d: term('cohens-d') })}</p></div>
          ${hbars({ items: effects, width: 480, left: 200, title: t('quality.effects.chartTitle'), format: (x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2) })}
          ${ui.split ? '' : `<p class="small soft mt-2">${tHtml('quality.effects.pooled', { link: `<a href="#/quality" data-split="1">${esc(t('quality.effects.splitLink'))}</a>` })}</p>`}
        </div>
        <div class="stack">
          ${
            top.length
              ? top
                  .map(
                    (f) => `<div class="callout"><div class="arrow">${f.direction === 'high' ? '▲' : '▼'}</div><div>
                      <div class="k">${esc(f.segment.toUpperCase())}</div>
                      <div class="t">${esc(t('quality.ranToo', { label: f.label, direction: f.direction }))}</div>
                      <div class="d">${esc(t('quality.delta', { delta: signed(f.delta), unit: f.unit, count: f.ngCount }))}</div></div></div>`,
                  )
                  .join('')
              : `<div class="card"><div class="empty">${esc(t('quality.noVariable'))}</div></div>`
          }
          ${
            top.length
              ? `<div class="card"><h3>${esc(t('quality.actions.title'))}</h3><ul class="actions-list">
                  <li>${esc(t('quality.actions.limits'))}</li>
                  <li>${esc(t('quality.actions.track'))}</li>
                  <li>${esc(t('quality.actions.calibrate'))}</li></ul></div>`
              : ''
          }
        </div>
      </div>

      <div class="card mb-4">
        <div class="card-head">
          <div><h2>${esc(t('quality.dumbbell.title'))}</h2><p>${esc(t('quality.dumbbell.hint'))}</p></div>
          <select id="variable" aria-label="${esc(t('quality.dumbbell.variable'))}">${CUTTER_VARIABLES.map((x) => `<option value="${x.key}" ${x.key === ui.variable ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
        </div>
        <div class="legend mb-1_5"><span><i class="box bg-bad round"></i>${esc(t('quality.dumbbell.failed'))}</span><span><i class="box bg-muted round"></i>${esc(t('quality.dumbbell.healthy'))}</span></div>
        ${dumbbell({ rows: dumb, width: fitWidth(1040), domain: [Math.min(...all) - pad, Math.max(...all) + pad], xLabel: t('quality.dumbbell.xLabel', { variable: v.label.toLowerCase(), unit: v.unit }) })}
      </div>

      <div class="card">
        <div class="card-head">
          <div><div class="eyebrow">${esc(t('quality.wear.eyebrow'))}</div><h2>${esc(t('quality.wear.title'))}</h2>
          <p>${esc(t('quality.wear.hint'))}</p></div>
          <div class="row"><span class="badge bad">${esc(t('quality.wear.cathodeChange', { change: signed(cat.change * 100, 1) }))}</span><span class="badge">${esc(t('quality.wear.anodeChange', { change: signed(an.change * 100, 1) }))}</span></div>
        </div>
        <div class="legend mb-1_5"><span><i class="bg-bad"></i>${esc(t('quality.wear.cathodeTip'))}</span><span><i class="bg-accent"></i>${esc(t('quality.wear.anodeTip'))}</span><span><i class="box bg-band"></i>${esc(t('quality.wear.final'))}</span></div>
        ${lineChart({
          series: [
            { values: series.map((s) => s.anode), color: 'var(--accent)', label: t('quality.wear.series.anode') },
            {
              values: series.map((s) => s.cathode),
              color: 'var(--bad)',
              width: 2,
              label: t('quality.wear.series.cathode'),
            },
          ],
          bands: [{ from: swapAt - 24, to: swapAt, color: 'var(--band)' }],
          markers: [{ x: swapAt, label: t('quality.wear.swap'), color: 'var(--soft)' }],
          xFormat: (h) => `${h}h`,
          yLabel: t('quality.wear.yLabel'),
          title: t('quality.wear.chartTitle'),
          width: fitWidth(1040),
          height: 260,
        })}
        <div class="grid g2 mt-3">
          <div><h3>${esc(t('quality.wear.action'))}</h3><p class="soft">${tHtml('quality.wear.actionText', { and: `<i>${esc(t('quality.wear.and'))}</i>`, wear: term('wear', 'wear'), hour: wearStart })}</p></div>
          <div class="kpi"><div class="label">${esc(t('quality.wear.kpi'))}</div><div class="value">${fmt(warnHours)} h</div><div class="note">${esc(t('quality.wear.kpiNote', { threshold: fmt(threshold) }))}</div></div>
        </div>
      </div>`;
  },
  bind(root, ctx) {
    const ui = uiState(ctx);
    onAll(root, '[data-split]', 'click', (b, e) => {
      e.preventDefault();
      ui.split = b.dataset.split === '1';
      ctx.rerender();
    });
    const select = need<HTMLSelectElement>(root, '#variable');
    select.addEventListener(
      'change',
      () => {
        const chosen = CUTTER_VARIABLES.find((x) => x.key === select.value);
        if (chosen) ui.variable = chosen.key;
        ctx.rerender();
      },
      { signal: bound() },
    );
  },
};

export default view;
