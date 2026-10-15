import { simulateShot, estimateFriction, PLUNGER } from '../lib/physics.ts';
import { createRng } from '../lib/rng.ts';
import { fitWidth, lineChart } from '../lib/svg.ts';
import { esc, fmt, need, onAll, bound } from '../lib/dom.ts';
import type { Context, View } from './types.ts';
import { badge, pageHead, term } from '../lib/ui.ts';
import { t, tHtml } from '../lib/i18n.ts';

const uiState = (ctx: Context) =>
  ctx.ui<{ shot: number }>('physics', { shot: ctx.state.detection.alerts[0]?.firstShot ?? 0 });

// Symbols and codes, the same in every language.
const constants = `m = ${PLUNGER.mass} kg · A<sub>h</sub> = ${PLUNGER.hydraulicArea} m² · A<sub>m</sub> = ${PLUNGER.metalArea} m²`; // i18n-ok
const SEIZURE = '<code>DT-SEIZURE</code>'; // i18n-ok

const view: View = {
  id: 'physics',
  get title() {
    return t('physics.title');
  },
  icon: 'atom',
  render(ctx) {
    const { shots, detection, scored } = ctx.state;
    const ui = uiState(ctx);
    const hist = shots.history;
    const toH = (i: number) => (i * shots.cycleSeconds) / 3600;
    const predicted = scored.filter((s) => s.predicted);
    const lead = predicted.reduce((a, s) => a + s.leadHours, 0) / (predicted.length || 1);

    const s = hist[ui.shot];
    const payload = simulateShot(s?.trueFriction ?? s?.friction ?? 0, createRng(1000 + ui.shot));
    const est = estimateFriction(payload);
    const flagged = detection.flags[ui.shot];

    return `
      ${pageHead({
        eyebrow: t('common.eyebrow.virtualSensor'),
        title: t('physics.headTitle'),
        lead: t('physics.lead'),
        actionsHtml: badge(
          t('physics.windows', { count: detection.alerts.length }),
          detection.alerts.length ? 'bad' : 'good',
        ),
      })}

      <div class="grid g4 mb-4">
        <div class="card kpi"><div class="label">${esc(t('physics.kpi.shots'))}</div><div class="value">${fmt(hist.length)}</div><div class="note">${esc(t('physics.kpi.hours', { hours: fmt(toH(hist.length), 0) }))}</div></div>
        <div class="card kpi good"><div class="label">${esc(t('physics.kpi.predicted'))}</div><div class="value">${predicted.length}/${scored.length}</div><div class="note">${esc(t('physics.kpi.codes'))}</div></div>
        <div class="card kpi"><div class="label">${tHtml('physics.kpi.average', { term: term('warning-time', 'warning time') })}</div><div class="value">${esc(t('physics.events.hours', { hours: fmt(lead, 1) }))}</div><div class="note">${esc(t('physics.kpi.leadNote'))}</div></div>
        <div class="card kpi"><div class="label">${esc(t('physics.kpi.covered'))}</div><div class="value">${esc(t('physics.kpi.minutes', { minutes: fmt(predicted.reduce((a, x) => a + x.durationMin, 0)) }))}</div><div class="note">${esc(t('physics.kpi.recorded', { minutes: fmt(scored.reduce((a, x) => a + x.durationMin, 0)) }))}</div></div>
      </div>

      <div class="card mb-4">
        <div class="card-head"><div><h2>${esc(t('physics.run.title'))}</h2><p>${esc(t('physics.run.hint'))}</p></div>
          <div class="legend"><span><i class="bg-accent"></i>${esc(t('physics.legend.friction'))}</span><span><i class="bg-warn"></i>${esc(t('physics.legend.threshold'))}</span><span><i class="box bg-band"></i>${esc(t('physics.legend.window'))}</span><span><i class="bg-bad"></i>${esc(t('physics.legend.downtime'))}</span></div>
        </div>
        <div id="run-chart" class="cursor-crosshair">
        ${lineChart({
          series: [
            {
              values: hist.map((h) => h.friction),
              color: 'var(--accent)',
              width: 1.2,
              label: t('physics.series.friction'),
            },
            {
              values: detection.thresholds,
              color: 'var(--warn)',
              width: 1.4,
              dash: '4 3',
              label: t('physics.series.threshold'),
            },
          ],
          bands: detection.alerts.map((a) => ({ from: a.firstShot, to: a.lastShot, color: 'var(--band)' })),
          markers: [
            ...shots.downtime.map((d) => ({ x: d.shot, label: d.id, color: 'var(--bad)' })),
            {
              x: ui.shot,
              label: t('physics.marker.shot', { n: ui.shot }),
              color: 'var(--ink)',
              width: 1,
              bottom: true,
            },
          ],
          xFormat: (i) => `${fmt(toH(i), 0)}h`,
          yLabel: t('physics.run.yLabel'),
          title: t('physics.run.chartTitle'),
          width: fitWidth(1040),
          height: 300,
        })}
        </div>
      </div>

      <div class="grid g2 mb-4">
        <div class="card">
          <div class="card-head">
            <div><h2>${esc(t('physics.shot.title', { n: ui.shot }))}</h2><p>${flagged ? `<span class="badge bad">${esc(t('physics.shot.over'))}</span>` : `<span class="badge good">${esc(t('physics.shot.normal'))}</span>`} ${tHtml('physics.shot.estimated', { value: `<b>${esc(fmt(est))} N</b>` })}</p></div>
            <div class="row"><button class="btn sm" data-step="-1" aria-label="${esc(t('physics.shot.previous'))}">‹</button><button class="btn sm" data-step="1" aria-label="${esc(t('physics.shot.next'))}">›</button></div>
          </div>
          <input type="range" id="shot" min="0" max="${hist.length - 1}" value="${ui.shot}" aria-label="${esc(t('physics.shot.slider'))}" />
          <div class="legend mt-2 mb-2 m-0"><span><i class="bg-accent"></i>${esc(t('physics.legend.hydraulic'))}</span><span><i class="bg-warm"></i>${esc(t('physics.legend.metal'))}</span></div>
          ${lineChart({
            series: [
              { values: payload.ph, color: 'var(--accent)', label: t('physics.series.hydraulic') },
              { values: payload.pm, color: 'var(--warm)', label: t('physics.series.metal') },
            ],
            xFormat: (i) => `${fmt(i * PLUNGER.dt * 1000)}ms`,
            yLabel: 'bar',
            title: t('physics.shot.pressures', { n: ui.shot }),
            width: fitWidth(480, 0.5),
            height: 200,
            yMin: 0,
          })}
          <div class="legend mt-2 mb-2 m-0"><span><i class="bg-soft"></i>${esc(t('physics.legend.velocity'))}</span></div>
          ${lineChart({ series: [{ values: payload.v, color: 'var(--soft)', label: t('physics.series.velocity') }], xFormat: (i) => `${fmt(i * PLUNGER.dt * 1000)}ms`, yLabel: 'm/s', title: t('physics.shot.velocity', { n: ui.shot }), width: fitWidth(480, 0.5), height: 150, yMin: 0 })}
        </div>
        <div class="card">
          <div class="card-head"><h2>${esc(t('physics.how.title'))}</h2><span class="badge">${esc(t('physics.how.model', { version: '1.3' }))}</span></div>
          <h3>${esc(t('physics.how.input'))}</h3>
          <ul class="actions-list soft"><li>${esc(t('physics.how.payloads'))}</li><li>${tHtml('physics.how.baseline', { baseline: term('baseline', 'baseline') })}</li></ul>
          <h3 class="mt-3">${esc(t('physics.how.physics'))}</h3>
          <p class="soft mt-1">${tHtml('physics.how.equation', { equation: '<code>m·a = P<sub>h</sub>·A<sub>h</sub> − P<sub>m</sub>·A<sub>m</sub> − F</code>', median: term('median', 'median'), residual: term('residual', 'residual'), virtualSensor: term('virtual-sensor', 'virtual sensor') })}</p>
          <p class="small muted mt-1">${constants}</p>
          <h3 class="mt-3">${esc(t('physics.how.output'))}</h3>
          <ul class="actions-list soft"><li>${esc(t('physics.how.value'))}</li><li>${tHtml('physics.how.warning', { persistence: term('persistence', 'persistence'), threshold: term('threshold', 'threshold'), k: term('k'), sigma: term('robust-σ', 'robust σ') })}</li></ul>
          <h3 class="mt-3">${esc(t('physics.how.used'))}</h3>
          <p class="soft mt-1">${tHtml('physics.how.predicts', { code: SEIZURE })}</p>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>${esc(t('physics.events.title'))}</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th>${esc(t('physics.events.event'))}</th><th>${esc(t('physics.events.code'))}</th><th class="num">${esc(t('physics.events.at'))}</th><th class="num">${esc(t('physics.events.duration'))}</th><th>${esc(t('physics.events.predicted'))}</th><th class="num">${esc(t('physics.events.lead'))}</th></tr></thead>
          <tbody>${scored
            .map(
              (d) =>
                `<tr class="clickable" data-goto="${d.shot - d.leadShots}"><td>${esc(d.id)}</td><td class="mono">${esc(d.code)}</td><td class="num">${esc(t('physics.events.hours', { hours: fmt(toH(d.shot), 1) }))}</td><td class="num">${esc(t('physics.kpi.minutes', { minutes: d.durationMin }))}</td><td>${d.predicted ? `<span class="badge good">${esc(t('physics.events.warned'))}</span>` : `<span class="badge bad">${esc(t('physics.events.missed'))}</span>`}</td><td class="num">${d.predicted ? esc(t('physics.events.hours', { hours: fmt(d.leadHours, 1) })) : '–'}</td></tr>`,
            )
            .join('')}</tbody>
        </table></div>
      </div>`;
  },
  bind(root, ctx) {
    const ui = uiState(ctx);
    const n = ctx.state.shots.history.length;
    const go = (i: number) => {
      ui.shot = Math.max(0, Math.min(n - 1, Number.isFinite(i) ? i : 0));
      ctx.rerender();
    };
    const slider = need<HTMLInputElement>(root, '#shot');
    slider.addEventListener('change', () => go(Number(slider.value)), { signal: bound() });
    onAll(root, '[data-step]', 'click', (b) => go(ui.shot + Number(b.dataset.step)));
    onAll(root, '[data-goto]', 'click', (r) => go(Number(r.dataset.goto)));
    const chart = need(root, '#run-chart');
    chart.addEventListener(
      'click',
      (e) => {
        const svg = need<SVGSVGElement>(chart, 'svg');
        const box = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const x = ((e.clientX - box.left) / box.width) * vb.width;
        const left = 52;
        const right = vb.width - 16;
        go(Math.round(((x - left) / (right - left)) * (n - 1)));
      },
      { signal: bound() },
    );
  },
};

export default view;
