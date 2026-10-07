import { MODELS, evaluate, sweep, sensitivity, makeRun, runDiff, auditRecord } from '../lib/design.js';
import { heatmap, hbars } from '../lib/svg.js';
import { esc, fmt, timeAgo } from '../lib/dom.js';

const defaults = (model) => Object.fromEntries(model.params.map((p) => [p.key, p.default]));
const stepFor = (p) => ((p.max - p.min) / 200 < 1 ? Number(((p.max - p.min) / 200).toPrecision(1)) : 1);
const show = (v) => (typeof v === 'number' ? fmt(v, 2) : esc(v));
const digits = (p) => (stepFor(p) < 1 ? Math.max(0, -Math.floor(Math.log10(stepFor(p)))) : 0);

export default {
  id: 'design',
  title: 'Design studio',
  icon: '◇',
  render(ctx) {
    const ui = ctx.ui('design', { model: 'swelling', params: {}, versions: {}, sweepX: null, sweepY: null });
    const model = MODELS[ui.model];
    ui.params[model.id] ??= defaults(model);
    ui.versions[model.id] ??= model.latest;
    const params = ui.params[model.id];
    const version = ui.versions[model.id];
    const value = evaluate(model.id, version, params);
    const xKey = ui.sweepX && model.params.some((p) => p.key === ui.sweepX) ? ui.sweepX : model.params[0].key;
    let yKey = ui.sweepY && model.params.some((p) => p.key === ui.sweepY) ? ui.sweepY : model.params[1].key;
    if (yKey === xKey) yKey = model.params.find((p) => p.key !== xKey).key;
    const sw = sweep(model.id, version, params, xKey, yKey, 14);
    const sens = sensitivity(model.id, version, params);
    const runs = ctx.state.runs.filter((r) => r.modelId === model.id);
    const byId = Object.fromEntries(ctx.state.runs.map((r) => [r.id, r]));
    const unit = model.output.unit;
    const label = (k) => model.params.find((p) => p.key === k)?.label ?? k;

    return `
      <div class="page-head">
        <div>
          <div class="eyebrow">Design · Co-engineer</div>
          <h1>Design studio</h1>
          <p>Explore physics models from first principles. Every run records the model version and parameters that produced it, so any result can be traced, compared and exported for audit.</p>
        </div>
        <div class="seg" role="group" aria-label="Model">${Object.values(MODELS).map((m) => `<button data-model="${m.id}" class="${m.id === model.id ? 'active' : ''}">${esc(m.name)}</button>`).join('')}</div>
      </div>

      <div class="grid g3" style="margin-bottom:16px">
        <div class="card">
          <div class="card-head"><div><h2>${esc(model.name)}</h2><p>${esc(model.domain)}</p></div>
            <select id="version" aria-label="Model version">${Object.keys(model.versions).map((v) => `<option value="${v}" ${v === version ? 'selected' : ''}>v${v}${v === model.latest ? ' (latest)' : ''}</option>`).join('')}</select>
          </div>
          ${model.params
            .map(
              (p) => `<div class="param">
                <span class="name">${esc(p.label)}</span>
                <span class="val"><span data-val="${p.key}">${fmt(params[p.key], digits(p))}</span> <span class="muted">${esc(p.unit)}</span></span>
                <input type="range" data-param="${p.key}" min="${p.min}" max="${p.max}" step="${stepFor(p)}" value="${params[p.key]}" aria-label="${esc(p.label)}" />
              </div>`,
            )
            .join('')}
          <button class="btn sm" data-reset>Reset to defaults</button>
        </div>
        <div class="card">
          <div class="label soft small">${esc(model.output.label)}</div>
          <div class="result-big"><span id="result">${fmt(value, 2)}</span> <span class="muted" style="font-size:18px">${esc(unit)}</span></div>
          <div class="small muted" style="margin-bottom:14px">model ${esc(model.id)} v${esc(version)}</div>
          <h3>Across model versions</h3>
          <table style="margin:6px 0 14px"><tbody>${Object.keys(model.versions)
            .map((v) => `<tr><td>v${v}</td><td class="num"><b>${fmt(evaluate(model.id, v, params), 2)}</b> ${esc(unit)}</td></tr>`)
            .join('')}</tbody></table>
          <form id="run-form" class="stack" style="gap:8px">
            <input type="text" name="note" placeholder="Note for this run (optional)" aria-label="Run note" />
            <button class="btn primary" type="submit">Save run</button>
          </form>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Sensitivity</h2><p>Output change for ±10% of each range</p></div></div>
          ${hbars({ items: sens.map((s) => ({ label: s.label, value: s.delta, color: 'var(--accent)' })), width: 320, left: 120, format: (x) => `${x >= 0 ? '+' : '−'}${fmt(Math.abs(x), 2)}` })}
        </div>
      </div>

      <div class="grid g2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-head"><div><h2>Parameter sweep</h2><p>${fmt(sw.min, 2)} – ${fmt(sw.max, 2)} ${esc(unit)} · other parameters held at current values</p></div>
            <div class="row">
              <select id="sweep-x" aria-label="X parameter">${model.params.map((p) => `<option value="${p.key}" ${p.key === xKey ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
              <span class="muted">×</span>
              <select id="sweep-y" aria-label="Y parameter">${model.params.filter((p) => p.key !== xKey).map((p) => `<option value="${p.key}" ${p.key === yKey ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
            </div>
          </div>
          ${heatmap({ ...sw, xLabel: label(xKey), yLabel: label(yKey), format: (v) => `${fmt(v, 2)} ${unit}` })}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Run history</h2><p>Click a run to restore its exact parameters.</p></div>
            <button class="btn sm" data-export ${runs.length ? '' : 'disabled'}>Export audit record</button>
          </div>
          ${
            runs.length
              ? `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Changed vs parent</th><th class="num">${esc(model.output.label)}</th></tr></thead><tbody>
                ${runs
                  .map((r) => {
                    const diff = runDiff(r, byId[r.parent]);
                    return `<tr class="clickable" data-run="${esc(r.id)}"><td><b>v${esc(r.version)}</b> ${r.note ? esc(r.note) : '<span class="muted">untitled</span>'}<div class="small muted">${esc(r.author)} · ${timeAgo(r.date)}</div></td>
                      <td class="diff">${r.parent ? diff.map((d) => `${esc(label(d.key))}: ${show(d.from)} → ${show(d.to)}`).join('<br>') || 'no change' : 'first run'}</td>
                      <td class="num"><b>${fmt(r.value, 2)}</b> ${esc(unit)}</td></tr>`;
                  })
                  .join('')}</tbody></table></div>`
              : '<div class="empty">No runs yet. Adjust parameters and press “Save run”.</div>'
          }
        </div>
      </div>`;
  },
  bind(root, ctx) {
    const ui = ctx.ui('design');
    const model = MODELS[ui.model];
    const params = ui.params[model.id];
    root.querySelectorAll('[data-model]').forEach((b) => b.addEventListener('click', () => { ui.model = b.dataset.model; ctx.rerender(); }));
    root.querySelector('#version').addEventListener('change', (e) => { ui.versions[model.id] = e.target.value; ctx.rerender(); });
    root.querySelectorAll('[data-param]').forEach((input) => {
      const p = model.params.find((x) => x.key === input.dataset.param);
      input.addEventListener('input', () => {
        params[p.key] = Number(input.value);
        root.querySelector(`[data-val="${p.key}"]`).textContent = fmt(params[p.key], digits(p));
        root.querySelector('#result').textContent = fmt(evaluate(model.id, ui.versions[model.id], params), 2);
      });
      input.addEventListener('change', () => ctx.rerender());
    });
    root.querySelector('[data-reset]').addEventListener('click', () => { ui.params[model.id] = defaults(model); ctx.rerender(); });
    root.querySelector('#sweep-x').addEventListener('change', (e) => { ui.sweepX = e.target.value; ctx.rerender(); });
    root.querySelector('#sweep-y').addEventListener('change', (e) => { ui.sweepY = e.target.value; ctx.rerender(); });
    root.querySelector('#run-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const note = e.target.note.value.trim();
      ctx.update((s) => {
        const parent = s.runs.find((r) => r.modelId === model.id) ?? null;
        s.runs.unshift(makeRun({ modelId: model.id, version: ui.versions[model.id], params, author: s.user.email, note, parent: parent?.id ?? null }));
      });
      ctx.toast('Run saved');
    });
    root.querySelectorAll('[data-run]').forEach((row) =>
      row.addEventListener('click', () => {
        const run = ctx.state.runs.find((r) => r.id === row.dataset.run);
        ui.params[model.id] = { ...run.params };
        ui.versions[model.id] = run.version;
        ctx.rerender();
        ctx.toast(`Restored run “${run.note || run.id}”`);
      }),
    );
    root.querySelector('[data-export]')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(auditRecord(ctx.state.runs, model.id), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tiles-audit-${model.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  },
};
