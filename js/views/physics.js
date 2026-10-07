import { simulateShot, estimateFriction, PLUNGER } from '../lib/physics.ts';
import { createRng } from '../lib/rng.ts';
import { lineChart } from '../lib/svg.ts';
import { esc, fmt } from '../lib/dom.ts';

export default {
  id: 'physics',
  title: 'Factory physics',
  icon: '∿',
  render(ctx) {
    const { shots, detection, scored } = ctx.state;
    const ui = ctx.ui('physics', { shot: detection.alerts[0]?.firstShot ?? 0 });
    const hist = shots.history;
    const toH = (i) => (i * shots.cycleSeconds) / 3600;
    const predicted = scored.filter((s) => s.predicted);
    const lead = predicted.reduce((a, s) => a + s.leadHours, 0) / (predicted.length || 1);

    const s = hist[ui.shot];
    const payload = simulateShot(s.trueFriction, createRng(1000 + ui.shot));
    const est = estimateFriction(payload);
    const flagged = detection.flags[ui.shot];

    return `
      <div class="page-head">
        <div>
          <div class="eyebrow">Operations · Virtual sensor</div>
          <h1>Plunger friction · Die-caster DC-02</h1>
          <p>Friction can't be measured directly. Solving the plunger's equation of motion for every shot turns pressure and velocity payloads into a friction value, which climbs before the plunger seizes.</p>
        </div>
        <span class="badge ${detection.alerts.length ? 'bad' : 'good'}">● ${detection.alerts.length} warning window(s)</span>
      </div>

      <div class="grid g4" style="margin-bottom:16px">
        <div class="card kpi"><div class="label">Shots analysed</div><div class="value">${fmt(hist.length)}</div><div class="note">${fmt(toH(hist.length), 0)} h of production</div></div>
        <div class="card kpi good"><div class="label">Stops predicted</div><div class="value">${predicted.length}/${scored.length}</div><div class="note">seizure &amp; lubrication codes</div></div>
        <div class="card kpi"><div class="label">Average lead time</div><div class="value">${fmt(lead, 1)} h</div><div class="note">from first warning to stop</div></div>
        <div class="card kpi"><div class="label">Downtime covered</div><div class="value">${fmt(predicted.reduce((a, x) => a + x.durationMin, 0))} min</div><div class="note">of ${fmt(scored.reduce((a, x) => a + x.durationMin, 0))} min recorded</div></div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><div><h2>Run chart</h2><p>Click anywhere on the chart to inspect that shot.</p></div>
          <div class="legend"><span><i style="background:var(--accent)"></i>Friction (virtual sensor)</span><span><i style="background:var(--warn)"></i>Threshold</span><span><i class="box" style="background:var(--band)"></i>Warning window</span><span><i style="background:var(--bad)"></i>Downtime event</span></div>
        </div>
        <div id="run-chart" style="cursor:crosshair">
        ${lineChart({
          series: [
            { values: hist.map((h) => h.friction), color: 'var(--accent)', width: 1.2 },
            { values: detection.thresholds, color: 'var(--warn)', width: 1.4, dash: '4 3' },
          ],
          bands: detection.alerts.map((a) => ({ from: a.firstShot, to: a.lastShot, color: 'var(--band)' })),
          markers: [
            ...shots.downtime.map((d) => ({ x: d.shot, label: d.id, color: 'var(--bad)' })),
            { x: ui.shot, label: `shot ${ui.shot}`, color: 'var(--ink)', width: 1, bottom: true },
          ],
          xFormat: (i) => `${fmt(toH(i), 0)}h`,
          yLabel: 'Friction (N)',
          width: 1040,
          height: 300,
        })}
        </div>
      </div>

      <div class="grid g2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-head">
            <div><h2>Shot ${ui.shot} payload</h2><p>${flagged ? '<span class="badge bad">over threshold</span>' : '<span class="badge good">normal</span>'} · estimated friction <b>${fmt(est)} N</b></p></div>
            <div class="row"><button class="btn sm" data-step="-1" aria-label="Previous shot">‹</button><button class="btn sm" data-step="1" aria-label="Next shot">›</button></div>
          </div>
          <input type="range" id="shot" min="0" max="${hist.length - 1}" value="${ui.shot}" aria-label="Shot" />
          <div class="legend" style="margin:8px 0"><span><i style="background:var(--accent)"></i>Hydraulic pressure (bar)</span><span><i style="background:var(--warm)"></i>Metal pressure (bar)</span></div>
          ${lineChart({
            series: [
              { values: payload.ph, color: 'var(--accent)' },
              { values: payload.pm, color: 'var(--warm)' },
            ],
            xFormat: (i) => `${fmt(i * PLUNGER.dt * 1000)}ms`,
            yLabel: 'bar',
            width: 480,
            height: 200,
            yMin: 0,
          })}
          <div class="legend" style="margin:8px 0"><span><i style="background:var(--soft)"></i>Plunger velocity (m/s)</span></div>
          ${lineChart({ series: [{ values: payload.v, color: 'var(--soft)' }], xFormat: (i) => `${fmt(i * PLUNGER.dt * 1000)}ms`, yLabel: 'm/s', width: 480, height: 150, yMin: 0 })}
        </div>
        <div class="card">
          <div class="card-head"><h2>How it works</h2><span class="badge">model v1.3</span></div>
          <h3>Input data</h3>
          <ul class="actions-list soft"><li>Shot payloads: plunger displacement, velocity, hydraulic &amp; metal pressure</li><li>Past 200 shots for a rolling baseline</li></ul>
          <h3 style="margin-top:12px">The physics</h3>
          <p class="soft" style="margin-top:4px">Equation of motion: <code>m·a = P<sub>h</sub>·A<sub>h</sub> − P<sub>m</sub>·A<sub>m</sub> − F</code>. Solved per sample; the median residual is the shot's friction.</p>
          <p class="small muted" style="margin-top:4px">m = ${PLUNGER.mass} kg · A<sub>h</sub> = ${PLUNGER.hydraulicArea} m² · A<sub>m</sub> = ${PLUNGER.metalArea} m²</p>
          <h3 style="margin-top:12px">Output</h3>
          <ul class="actions-list soft"><li>Friction value for every shot</li><li>Warning after 3 consecutive shots above median + 4 robust σ</li></ul>
          <h3 style="margin-top:12px">How it is used</h3>
          <p class="soft" style="margin-top:4px">A friction warning predicts plunger seizure downtime (<code>DT-SEIZURE</code>) and is delivered through the warning workflow.</p>
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
    const ui = ctx.ui('physics');
    const n = ctx.state.shots.history.length;
    const go = (i) => {
      ui.shot = Math.max(0, Math.min(n - 1, i));
      ctx.rerender();
    };
    root.querySelector('#shot').addEventListener('change', (e) => go(Number(e.target.value)));
    root
      .querySelectorAll('[data-step]')
      .forEach((b) => b.addEventListener('click', () => go(ui.shot + Number(b.dataset.step))));
    root.querySelectorAll('[data-goto]').forEach((r) => r.addEventListener('click', () => go(Number(r.dataset.goto))));
    root.querySelector('#run-chart').addEventListener('click', (e) => {
      const svg = e.currentTarget.querySelector('svg');
      const box = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const x = ((e.clientX - box.left) / box.width) * vb.width;
      const left = 52;
      const right = vb.width - 16;
      go(Math.round(((x - left) / (right - left)) * (n - 1)));
    });
  },
};
