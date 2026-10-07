import { correlationFinder, explain, wearCheck } from '../lib/analysis.ts';
import { CUTTER_VARIABLES, type CutterVariable } from '../lib/data.ts';
import { mean } from '../lib/stats.ts';
import { dumbbell, hbars, lineChart } from '../lib/svg.ts';
import { esc, fmt, need, onAll, signed } from '../lib/dom.ts';
import type { Material } from '../lib/types.ts';
import type { Context, View } from './types.ts';

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

interface QualityUi {
  split: boolean;
  variable: CutterVariable;
}

const uiState = (ctx: Context) => ctx.ui<QualityUi>('quality', { split: true, variable: 'tension' });

const view: View = {
  id: 'quality',
  title: 'Process & quality',
  icon: '⌁',
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
        label: `${cap(m)} sheet`,
        sub: m === 'anode' ? 'graphite stretches under load' : 'stiff NMC needs tension to cut clean',
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
      <div class="page-head">
        <div>
          <div class="eyebrow">Operations · Correlation finder</div>
          <h1>Why are cutter batches failing?</h1>
          <p>Notching Cutter C-01 leaves inconsistent tab widths. ${ng} of ${rows.length} batches were NG. The finder ranks every process variable by how strongly it separates failed from healthy batches.</p>
        </div>
        <div class="seg" role="group" aria-label="Segmentation">
          <button data-split="0" class="${ui.split ? '' : 'active'}">Pooled</button>
          <button data-split="1" class="${ui.split ? 'active' : ''}">Split by material</button>
        </div>
      </div>

      <div class="grid g2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-head"><h2>Effect size by variable</h2><p>Cohen's d, failed vs healthy · |d| ≥ 0.8 is strong</p></div>
          ${hbars({ items: effects, width: 480, left: 200, format: (x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2) })}
          ${ui.split ? '' : '<p class="small soft" style="margin-top:8px">Pooled across materials, nothing stands out. Try <a href="#/quality" data-split="1">splitting by material</a>.</p>'}
        </div>
        <div class="stack">
          ${
            top.length
              ? top
                  .map(
                    (f) => `<div class="callout"><div class="arrow">${f.direction === 'high' ? '▲' : '▼'}</div><div>
                      <div class="k">${esc(f.segment.toUpperCase())}</div>
                      <div class="t">${esc(f.label)} ran too ${f.direction}</div>
                      <div class="d">${signed(f.delta)} ${esc(f.unit)} vs healthy · ${f.ngCount} NG batches</div></div></div>`,
                  )
                  .join('')
              : '<div class="card"><div class="empty">No variable explains the failures on pooled data.</div></div>'
          }
          ${
            top.length
              ? `<div class="card"><h3>Proposed actions</h3><ul class="actions-list">
                  <li>Set material-specific tension limits → raise the cathode limit, lower the anode limit</li>
                  <li>Track tension separately per material as a live SPC signal</li>
                  <li>Material change → trigger calibration on every roll</li></ul></div>`
              : ''
          }
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-head">
          <div><h2>Failed vs healthy average</h2><p>One setting can fail two materials in opposite directions.</p></div>
          <select id="variable" aria-label="Variable">${CUTTER_VARIABLES.map((x) => `<option value="${x.key}" ${x.key === ui.variable ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
        </div>
        <div class="legend" style="margin-bottom:6px"><span><i class="box" style="background:var(--bad);border-radius:50%"></i>NG (failed) avg</span><span><i class="box" style="background:var(--muted);border-radius:50%"></i>Healthy avg</span></div>
        ${dumbbell({ rows: dumb, width: 1040, domain: [Math.min(...all) - pad, Math.max(...all) + pad], xLabel: `Average ${v.label.toLowerCase()} (${v.unit})` })}
      </div>

      <div class="card">
        <div class="card-head">
          <div><div class="eyebrow">Predictive maintenance · Tab Welder W-03</div><h2>A second signal that a welding tip is worn</h2>
          <p>Tips are swapped on a fixed cycle count. The line's own power data confirms real wear.</p></div>
          <div class="row"><span class="badge bad">Cathode ${signed(cat.change * 100, 1)}%</span><span class="badge">Anode ${signed(an.change * 100, 1)}%</span></div>
        </div>
        <div class="legend" style="margin-bottom:6px"><span><i style="background:var(--bad)"></i>Cathode tip</span><span><i style="background:var(--accent)"></i>Anode tip</span><span><i class="box" style="background:var(--band)"></i>Final 24 h before swap</span></div>
        ${lineChart({
          series: [
            { values: series.map((s) => s.anode), color: 'var(--accent)' },
            { values: series.map((s) => s.cathode), color: 'var(--bad)', width: 2 },
          ],
          bands: [{ from: swapAt - 24, to: swapAt, color: 'var(--band)' }],
          markers: [{ x: swapAt, label: 'scheduled swap', color: 'var(--soft)' }],
          xFormat: (h) => `${h}h`,
          yLabel: 'Median welding power (W)',
          width: 1040,
          height: 260,
        })}
        <div class="grid g2" style="margin-top:12px">
          <div><h3>Proposed action</h3><p class="soft">Monitor both triggers: cycle counter <i>and</i> median welding power. When power crosses the wear threshold, replace the tip even if the counter hasn't reached its swap point. Wear started around hour ${wearStart}.</p></div>
          <div class="kpi"><div class="label">Power-based warning</div><div class="value">${fmt(warnHours)} h</div><div class="note">before the scheduled swap · threshold baseline +5% (${fmt(threshold)} W)</div></div>
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
    select.addEventListener('change', () => {
      const chosen = CUTTER_VARIABLES.find((x) => x.key === select.value);
      if (chosen) ui.variable = chosen.key;
      ctx.rerender();
    });
  },
};

export default view;
