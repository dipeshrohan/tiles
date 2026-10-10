import { simulateShot, estimateFriction, PLUNGER } from '../lib/physics.ts';
import { createRng } from '../lib/rng.ts';
import { fitWidth, lineChart } from '../lib/svg.ts';
import { esc, fmt, need, onAll } from '../lib/dom.ts';
import type { Context, View } from './types.ts';
import { badge, pageHead } from '../lib/ui.ts';

const uiState = (ctx: Context) =>
  ctx.ui<{ shot: number }>('physics', { shot: ctx.state.detection.alerts[0]?.firstShot ?? 0 });

const view: View = {
  id: 'physics',
  title: 'Factory physics',
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
        eyebrow: 'Operations · Virtual sensor',
        title: 'Plunger friction · Die-caster DC-02',
        lead: "Friction can't be measured directly. Solving the plunger's equation of motion for every shot turns pressure and velocity payloads into a friction value, which climbs before the plunger seizes.",
        actionsHtml: badge(`● ${detection.alerts.length} warning window(s)`, detection.alerts.length ? 'bad' : 'good'),
      })}

      <div class="grid g4 mb-4">
        <div class="card kpi"><div class="label">Shots analysed</div><div class="value">${fmt(hist.length)}</div><div class="note">${fmt(toH(hist.length), 0)} h of production</div></div>
        <div class="card kpi good"><div class="label">Stops predicted</div><div class="value">${predicted.length}/${scored.length}</div><div class="note">seizure &amp; lubrication codes</div></div>
        <div class="card kpi"><div class="label">Average lead time</div><div class="value">${fmt(lead, 1)} h</div><div class="note">from first warning to stop</div></div>
        <div class="card kpi"><div class="label">Downtime covered</div><div class="value">${fmt(predicted.reduce((a, x) => a + x.durationMin, 0))} min</div><div class="note">of ${fmt(scored.reduce((a, x) => a + x.durationMin, 0))} min recorded</div></div>
      </div>

      <div class="card mb-4">
        <div class="card-head"><div><h2>Run chart</h2><p>Click anywhere on the chart to inspect that shot.</p></div>
          <div class="legend"><span><i class="bg-accent"></i>Friction (virtual sensor)</span><span><i class="bg-warn"></i>Threshold</span><span><i class="box bg-band"></i>Warning window</span><span><i class="bg-bad"></i>Downtime event</span></div>
        </div>
        <div id="run-chart" class="cursor-crosshair">
        ${lineChart({
          series: [
            { values: hist.map((h) => h.friction), color: 'var(--accent)', width: 1.2, label: 'friction' },
            { values: detection.thresholds, color: 'var(--warn)', width: 1.4, dash: '4 3', label: 'threshold' },
          ],
          bands: detection.alerts.map((a) => ({ from: a.firstShot, to: a.lastShot, color: 'var(--band)' })),
          markers: [
            ...shots.downtime.map((d) => ({ x: d.shot, label: d.id, color: 'var(--bad)' })),
            { x: ui.shot, label: `shot ${ui.shot}`, color: 'var(--ink)', width: 1, bottom: true },
          ],
          xFormat: (i) => `${fmt(toH(i), 0)}h`,
          yLabel: 'Friction (N)',
          title: 'Plunger friction by shot (N)',
          width: fitWidth(1040),
          height: 300,
        })}
        </div>
      </div>

      <div class="grid g2 mb-4">
        <div class="card">
          <div class="card-head">
            <div><h2>Shot ${ui.shot} payload</h2><p>${flagged ? '<span class="badge bad">over threshold</span>' : '<span class="badge good">normal</span>'} · estimated friction <b>${fmt(est)} N</b></p></div>
            <div class="row"><button class="btn sm" data-step="-1" aria-label="Previous shot">‹</button><button class="btn sm" data-step="1" aria-label="Next shot">›</button></div>
          </div>
          <input type="range" id="shot" min="0" max="${hist.length - 1}" value="${ui.shot}" aria-label="Shot" />
          <div class="legend mt-2 mb-2 m-0"><span><i class="bg-accent"></i>Hydraulic pressure (bar)</span><span><i class="bg-warm"></i>Metal pressure (bar)</span></div>
          ${lineChart({
            series: [
              { values: payload.ph, color: 'var(--accent)', label: 'hydraulic pressure' },
              { values: payload.pm, color: 'var(--warm)', label: 'metal pressure' },
            ],
            xFormat: (i) => `${fmt(i * PLUNGER.dt * 1000)}ms`,
            yLabel: 'bar',
            title: `Shot ${ui.shot} pressures (bar)`,
            width: fitWidth(480, 0.5),
            height: 200,
            yMin: 0,
          })}
          <div class="legend mt-2 mb-2 m-0"><span><i class="bg-soft"></i>Plunger velocity (m/s)</span></div>
          ${lineChart({ series: [{ values: payload.v, color: 'var(--soft)', label: 'velocity' }], xFormat: (i) => `${fmt(i * PLUNGER.dt * 1000)}ms`, yLabel: 'm/s', title: `Shot ${ui.shot} plunger velocity (m/s)`, width: fitWidth(480, 0.5), height: 150, yMin: 0 })}
        </div>
        <div class="card">
          <div class="card-head"><h2>How it works</h2><span class="badge">model v1.3</span></div>
          <h3>Input data</h3>
          <ul class="actions-list soft"><li>Shot payloads: plunger displacement, velocity, hydraulic &amp; metal pressure</li><li>Past 200 shots for a rolling baseline</li></ul>
          <h3 class="mt-3">The physics</h3>
          <p class="soft mt-1">Equation of motion: <code>m·a = P<sub>h</sub>·A<sub>h</sub> − P<sub>m</sub>·A<sub>m</sub> − F</code>. Solved per sample; the median residual is the shot's friction.</p>
          <p class="small muted mt-1">m = ${PLUNGER.mass} kg · A<sub>h</sub> = ${PLUNGER.hydraulicArea} m² · A<sub>m</sub> = ${PLUNGER.metalArea} m²</p>
          <h3 class="mt-3">Output</h3>
          <ul class="actions-list soft"><li>Friction value for every shot</li><li>Warning after 3 consecutive shots above median + 4 robust σ</li></ul>
          <h3 class="mt-3">How it is used</h3>
          <p class="soft mt-1">A friction warning predicts plunger seizure downtime (<code>DT-SEIZURE</code>) and is delivered through the warning workflow.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Downtime events</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Event</th><th>Code</th><th class="num">At</th><th class="num">Duration</th><th>Predicted</th><th class="num">Lead time</th></tr></thead>
          <tbody>${scored
            .map(
              (d) =>
                `<tr class="clickable" data-goto="${d.shot - d.leadShots}"><td>${esc(d.id)}</td><td class="mono">${esc(d.code)}</td><td class="num">${fmt(toH(d.shot), 1)} h</td><td class="num">${d.durationMin} min</td><td>${d.predicted ? '<span class="badge good">✓ warned</span>' : '<span class="badge bad">missed</span>'}</td><td class="num">${d.predicted ? `${fmt(d.leadHours, 1)} h` : '–'}</td></tr>`,
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
    slider.addEventListener('change', () => go(Number(slider.value)));
    onAll(root, '[data-step]', 'click', (b) => go(ui.shot + Number(b.dataset.step)));
    onAll(root, '[data-goto]', 'click', (r) => go(Number(r.dataset.goto)));
    const chart = need(root, '#run-chart');
    chart.addEventListener('click', (e) => {
      const svg = need<SVGSVGElement>(chart, 'svg');
      const box = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const x = ((e.clientX - box.left) / box.width) * vb.width;
      const left = 52;
      const right = vb.width - 16;
      go(Math.round(((x - left) / (right - left)) * (n - 1)));
    });
  },
};

export default view;
