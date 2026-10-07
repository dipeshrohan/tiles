import { MODELS, evaluate, sweep, sensitivity, makeRun, runDiff, auditRecord, getModel } from '../lib/design.ts';
import { heatmap, hbars } from '../lib/svg.ts';
import { esc, field, fmt, need, onAll, onSubmit, timeAgo } from '../lib/dom.ts';
import type { DesignModel, ParamSpec, Params, Run } from '../lib/types.ts';
import type { Context, View } from './types.ts';

const defaults = (model: DesignModel): Params => Object.fromEntries(model.params.map((p) => [p.key, p.default]));
const stepFor = (p: ParamSpec): number =>
  (p.max - p.min) / 200 < 1 ? Number(((p.max - p.min) / 200).toPrecision(1)) : 1;
const show = (v: unknown): string => (typeof v === 'number' ? fmt(v, 2) : esc(v));
const digits = (p: ParamSpec): number => (stepFor(p) < 1 ? Math.max(0, -Math.floor(Math.log10(stepFor(p)))) : 0);

interface DesignUi {
  model: string;
  params: Record<string, Params>;
  versions: Record<string, string>;
  sweepX: string | null;
  sweepY: string | null;
}

const uiState = (ctx: Context) =>
  ctx.ui<DesignUi>('design', { model: 'swelling', params: {}, versions: {}, sweepX: null, sweepY: null });

// The selected model with its current parameters and version, defaults filled in.
function current(ctx: Context) {
  const ui = uiState(ctx);
  const model = MODELS[ui.model] ?? getModel('swelling');
  const params = (ui.params[model.id] ??= defaults(model));
  const version = (ui.versions[model.id] ??= model.latest);
  return { ui, model, params, version };
}

const view: View = {
  id: 'design',
  title: 'Design studio',
  icon: '◇',
  render(ctx) {
    const { ui, model, params, version } = current(ctx);
    const value = evaluate(model.id, version, params);
    const keys = model.params.map((p) => p.key);
    const xKey = ui.sweepX && keys.includes(ui.sweepX) ? ui.sweepX : keys[0]!;
    let yKey = ui.sweepY && keys.includes(ui.sweepY) ? ui.sweepY : keys[1]!;
    if (yKey === xKey) yKey = keys.find((k) => k !== xKey)!;
    const sw = sweep(model.id, version, params, xKey, yKey, 14);
    const sens = sensitivity(model.id, version, params);
    const runs = ctx.state.runs.filter((r) => r.modelId === model.id);
    const byId = new Map<string, Run>(ctx.state.runs.map((r) => [r.id, r]));
    const unit = model.output.unit;
    const label = (k: string) => model.params.find((p) => p.key === k)?.label ?? k;

    return `
      <div class="page-head">
        <div>
          <div class="eyebrow">Design · Co-engineer</div>
          <h1>Design studio</h1>
          <p>Explore physics models from first principles. Every run records the model version and parameters that produced it, so any result can be traced, compared and exported for audit.</p>
        </div>
        <div class="seg" role="group" aria-label="Model">${Object.values(MODELS)
          .map(
            (m) => `<button data-model="${m.id}" class="${m.id === model.id ? 'active' : ''}">${esc(m.name)}</button>`,
          )
          .join('')}</div>
      </div>

      <div class="grid g3" style="margin-bottom:16px">
        <div class="card">
          <div class="card-head"><div><h2>${esc(model.name)}</h2><p>${esc(model.domain)}</p></div>
            <select id="version" aria-label="Model version">${Object.keys(model.versions)
              .map(
                (v) =>
                  `<option value="${v}" ${v === version ? 'selected' : ''}>v${v}${v === model.latest ? ' (latest)' : ''}</option>`,
              )
              .join('')}</select>
          </div>
          ${model.params
            .map(
              (p) => `<div class="param">
                <span class="name">${esc(p.label)}</span>
                <span class="val"><span data-val="${p.key}">${fmt(params[p.key] ?? p.default, digits(p))}</span> <span class="muted">${esc(p.unit)}</span></span>
                <input type="range" data-param="${p.key}" min="${p.min}" max="${p.max}" step="${stepFor(p)}" value="${params[p.key] ?? p.default}" aria-label="${esc(p.label)}" />
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
            .map(
              (v) =>
                `<tr><td>v${v}</td><td class="num"><b>${fmt(evaluate(model.id, v, params), 2)}</b> ${esc(unit)}</td></tr>`,
            )
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
              <select id="sweep-y" aria-label="Y parameter">${model.params
                .filter((p) => p.key !== xKey)
                .map((p) => `<option value="${p.key}" ${p.key === yKey ? 'selected' : ''}>${esc(p.label)}</option>`)
                .join('')}</select>
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
                    const diff = runDiff(r, r.parent ? byId.get(r.parent) : null);
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
    const { ui, model, params } = current(ctx);
    onAll(root, '[data-model]', 'click', (b) => {
      if (b.dataset.model) ui.model = b.dataset.model;
      ctx.rerender();
    });
    const versionSelect = need<HTMLSelectElement>(root, '#version');
    versionSelect.addEventListener('change', () => {
      ui.versions[model.id] = versionSelect.value;
      ctx.rerender();
    });
    root.querySelectorAll<HTMLInputElement>('[data-param]').forEach((input) => {
      const p = model.params.find((x) => x.key === input.dataset.param);
      if (!p) return;
      input.addEventListener('input', () => {
        params[p.key] = Number(input.value);
        need(root, `[data-val="${p.key}"]`).textContent = fmt(params[p.key] ?? p.default, digits(p));
        need(root, '#result').textContent = fmt(evaluate(model.id, ui.versions[model.id] ?? model.latest, params), 2);
      });
      input.addEventListener('change', () => ctx.rerender());
    });
    onAll(root, '[data-reset]', 'click', () => {
      ui.params[model.id] = defaults(model);
      ctx.rerender();
    });
    const sweepX = need<HTMLSelectElement>(root, '#sweep-x');
    sweepX.addEventListener('change', () => {
      ui.sweepX = sweepX.value;
      ctx.rerender();
    });
    const sweepY = need<HTMLSelectElement>(root, '#sweep-y');
    sweepY.addEventListener('change', () => {
      ui.sweepY = sweepY.value;
      ctx.rerender();
    });
    onSubmit(root, '#run-form', (form) => {
      const note = field(form, 'note').trim();
      ctx.update((s) => {
        const parent = s.runs.find((r) => r.modelId === model.id) ?? null;
        s.runs.unshift(
          makeRun({
            modelId: model.id,
            version: ui.versions[model.id] ?? model.latest,
            params,
            author: s.user.email,
            note,
            parent: parent?.id ?? null,
          }),
        );
      });
      ctx.toast('Run saved');
    });
    onAll(root, '[data-run]', 'click', (row) => {
      const run = ctx.state.runs.find((r) => r.id === row.dataset.run);
      if (!run) return;
      ui.params[model.id] = { ...run.params };
      ui.versions[model.id] = run.version;
      ctx.rerender();
      ctx.toast(`Restored run “${run.note || run.id}”`);
    });
    onAll(root, '[data-export]', 'click', () => {
      const blob = new Blob([JSON.stringify(auditRecord(ctx.state.runs, model.id), null, 2)], {
        type: 'application/json',
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tiles-audit-${model.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  },
};

export default view;
