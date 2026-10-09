import { MODELS, evaluate, sweep, sensitivity, makeRun, runDiff, auditRecord, getModel } from '../lib/design.ts';
import type { RunChange } from '../lib/design.ts';
import { API_MODEL, asRun, changesOf, headOf } from '../lib/design-runs.ts';
import { heatmap, hbars } from '../lib/svg.ts';
import { esc, field, fmt, need, onAll, onSubmit, onNavigate, routeOf, timeAgo } from '../lib/dom.ts';
import type { DesignProject, DesignRun } from '../lib/api.ts';
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
  project: string | null; // the shared project shown, with the Tiles API (T4.14)
  projectSite: string | null; // the site `project` is of
}

const uiState = (ctx: Context) =>
  ctx.ui<DesignUi>('design', {
    model: 'swelling',
    params: {},
    versions: {},
    sweepX: null,
    sweepY: null,
    project: null,
    projectSite: null,
  });

// With the Tiles API, runs are stored on the site in shared projects (T4.11, T4.14); without it,
// in this browser. Fetched afresh at each visit: others run designs meanwhile. `loaded` is false
// until a fetch answers: a run saved before its project's history is known would lose its parent.
let projects: { site: string; items: DesignProject[] } | null = null;
let projectsFetching: string | null = null; // the site whose projects are being fetched
let apiRuns: { key: string; items: DesignRun[]; loaded: boolean } | null = null;
let saving = false;
let visit = 0; // a fetch that answers after you left (and maybe came back) is dropped
onNavigate((hash) => {
  if (routeOf(hash) !== 'design') {
    projects = null;
    projectsFetching = null;
    apiRuns = null;
    visit += 1;
  }
});

// The site whose runs are shown, with the Tiles API; null in this browser's mode, or while the
// API's site isn't ready (nothing is saved then: see `apiWaiting`).
const siteOf = (ctx: Context): string | null =>
  ctx.api && ctx.ontology.status === 'ready' ? (ctx.ontology.site?.id ?? null) : null;
const apiWaiting = (ctx: Context): boolean => ctx.api !== null && siteOf(ctx) === null;

// The project shown on this site: the one chosen, if it is still there, or the latest.
function projectOf(ctx: Context, site: string): DesignProject | null {
  const ui = uiState(ctx);
  const items = projects?.site === site ? projects.items : [];
  if (ui.projectSite !== site) Object.assign(ui, { project: null, projectSite: site });
  return items.find((p) => p.id === ui.project) ?? items[0] ?? null;
}

const runsKey = (site: string, project: string, model: string) => `${site}|${project}|${model}`;

async function fetchProjects(ctx: Context, site: string): Promise<void> {
  if (projectsFetching === site) return; // one at a time
  projectsFetching = site;
  const at = visit;
  let items: DesignProject[] = [];
  try {
    items = await ctx.api!.designProjects.list(site);
  } catch {
    // The client showed why; no projects are shown.
  }
  if (at !== visit || projectsFetching !== site) return; // left meanwhile
  projectsFetching = null;
  projects = { site, items };
  ctx.rerender();
}

async function fetchRuns(ctx: Context, site: string, project: string, model: string): Promise<void> {
  const key = runsKey(site, project, model);
  if (apiRuns?.key === key) return; // fetching or fetched
  apiRuns = { key, items: [], loaded: false };
  const at = visit;
  try {
    const page = await ctx.api!.runs.list(site, { project, model: API_MODEL[model] ?? model, limit: 200 });
    if (at === visit && apiRuns?.key === key) apiRuns = { key, items: page.runs, loaded: true };
  } catch {
    if (at === visit && apiRuns?.key === key) apiRuns = null; // the client showed why; tried again when drawn
    return;
  }
  if (at === visit) ctx.rerender();
}

function projectBar(ctx: Context, site: string): string {
  const items = projects?.site === site ? projects.items : null;
  const shown = projectOf(ctx, site);
  const canWrite = ctx.ontology.role !== null && ctx.ontology.role !== 'viewer';
  const choose =
    items === null
      ? '<span class="small soft">Loading projects…</span>'
      : items.length
        ? `<label class="row" style="gap:8px">Project <select id="project" aria-label="Design project">${items
            .map(
              (p) =>
                `<option value="${esc(p.id)}" ${p.id === shown?.id ? 'selected' : ''}>${esc(p.name)} (${p.runs} run${p.runs === 1 ? '' : 's'})</option>`,
            )
            .join('')}</select></label>`
        : '<span class="small soft">No projects yet on this site.</span>';
  const create = canWrite
    ? `<form id="new-project" class="row" style="gap:8px"><input type="text" name="name" maxlength="200" placeholder="New project name" aria-label="New project name" required /><button class="btn sm" type="submit">Create project</button></form>`
    : '';
  return `<div class="card row" data-projects style="gap:16px;flex-wrap:wrap;justify-content:space-between;margin-bottom:16px">
      <div class="row" style="gap:16px;flex-wrap:wrap">${choose}${shown?.description ? `<span class="small soft">${esc(shown.description)}</span>` : ''}</div>
      ${create}
      <span class="small soft" style="flex-basis:100%">Runs in a project are stored on the site and shared with everyone on it.</span>
    </div>`;
}

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
    const site = siteOf(ctx);
    const project = site ? projectOf(ctx, site) : null;
    const fetched = site && project && apiRuns?.key === runsKey(site, project.id, model.id) ? apiRuns : null;
    const stored = fetched?.items ?? [];
    const remote = site !== null || apiWaiting(ctx);
    const runs: Run[] = remote ? stored.map(asRun) : ctx.state.runs.filter((r) => r.modelId === model.id);
    const byId = new Map<string, Run>(ctx.state.runs.map((r) => [r.id, r]));
    // What changed from each run's parent: the API says, for stored runs (their parent may be on another page).
    const apiChanges = new Map<string, RunChange[]>(stored.map((r) => [String(r.number), changesOf(r)]));
    const diffOf = (r: Run): RunChange[] => apiChanges.get(r.id) ?? runDiff(r, r.parent ? byId.get(r.parent) : null);
    const canSave = remote
      ? Boolean(fetched?.loaded) && ctx.ontology.role !== null && ctx.ontology.role !== 'viewer'
      : true;
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
      ${site ? projectBar(ctx, site) : apiWaiting(ctx) ? `<div class="card" data-projects style="margin-bottom:16px"><span class="small soft">${ctx.ontology.status === 'error' ? "Can't reach the Tiles API: runs can't be saved or shown until it answers." : 'Connecting to the Tiles API…'}</span></div>` : ''}

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
            <input type="text" name="note" maxlength="500" placeholder="Note for this run (optional)" aria-label="Run note" />
            <button class="btn primary" type="submit" ${canSave && !saving ? '' : 'disabled'}>Save run${site && project ? ` to ${esc(project.name)}` : ''}</button>
            ${site && !project ? '<span class="small soft">Create a project to save runs on the site.</span>' : ''}
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
            ${
              site
                ? `<div class="row" style="gap:6px"><button class="btn sm" data-audit="json" ${runs.length ? '' : 'disabled'} title="The latest run with its whole lineage, each model version's spec and a SHA-256 digest">Audit record (JSON)</button><button class="btn sm" data-audit="pdf" ${runs.length ? '' : 'disabled'}>Audit report (PDF)</button><button class="btn sm" data-export ${runs.length ? '' : 'disabled'} title="Every run of this model in the project, branches too">All runs (JSON)</button></div>`
                : `<button class="btn sm" data-export ${runs.length ? '' : 'disabled'}>Export audit record</button>`
            }
          </div>
          ${
            runs.length
              ? `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Changed vs parent</th><th class="num">${esc(model.output.label)}</th></tr></thead><tbody>
                ${runs
                  .map((r) => {
                    const diff = diffOf(r);
                    return `<tr class="clickable" data-run="${esc(r.id)}"><td><b>v${esc(r.version)}</b> ${r.note ? esc(r.note) : '<span class="muted">untitled</span>'}<div class="small muted">${esc(r.author)} · ${timeAgo(r.date)}</div></td>
                      <td class="diff">${r.parent ? diff.map((d) => `${esc(label(d.key))}: ${show(d.from)} → ${show(d.to)}`).join('<br>') || 'no change' : 'first run'}</td>
                      <td class="num"><b>${fmt(r.value, 2)}</b> ${esc(unit)}</td></tr>`;
                  })
                  .join('')}</tbody></table></div>`
              : `<div class="empty">${site && !project ? 'Pick or create a project to see its runs.' : site && !fetched?.loaded ? 'Loading runs…' : remote && !site ? '' : 'No runs yet. Adjust parameters and press “Save run”.'}</div>`
          }
        </div>
      </div>`;
  },
  bind(root, ctx) {
    const { ui, model, params } = current(ctx);
    const site = siteOf(ctx);
    if (site && projects?.site !== site) void fetchProjects(ctx, site);
    const project = site ? projectOf(ctx, site) : null;
    if (site && project && apiRuns?.key !== runsKey(site, project.id, model.id))
      void fetchRuns(ctx, site, project.id, model.id);
    root.querySelector<HTMLSelectElement>('#project')?.addEventListener('change', (e) => {
      ui.project = (e.target as HTMLSelectElement).value;
      ctx.rerender();
    });
    onSubmit(root, '#new-project', async (form) => {
      const name = field(form, 'name').trim();
      if (!site || !ctx.api || !name) return;
      try {
        const created = await ctx.api.designProjects.create(site, name);
        ui.project = created.id;
        projects = { site, items: [created, ...(projects?.site === site ? projects.items : [])] };
        ctx.toast(`Project “${created.name}” created`);
        ctx.rerender();
      } catch {
        // The client showed why (a name taken, say).
      }
    });
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
    onSubmit(root, '#run-form', async (form) => {
      const note = field(form, 'note').trim();
      if (site) {
        const key = runsKey(site, project?.id ?? '', model.id);
        if (!ctx.api || !project || saving || apiRuns?.key !== key || !apiRuns.loaded) return;
        const items = apiRuns.items;
        saving = true;
        ctx.rerender();
        try {
          const created = await ctx.api.runs.create(site, {
            model: API_MODEL[model.id] ?? model.id,
            version: ui.versions[model.id] ?? model.latest,
            params,
            note,
            parent: headOf(items, model.id),
            project: project.id,
          });
          ctx.toast(`Run saved to ${project.name}`);
          if (apiRuns?.key === key) apiRuns = { key, items: [created, ...items], loaded: true };
          if (projects?.site === site)
            projects = {
              site,
              items: projects.items.map((p) =>
                p.id === project.id ? { ...p, runs: p.runs + 1, last_run_at: created.created_at } : p,
              ),
            };
        } catch {
          // The client showed why.
        } finally {
          saving = false;
          ctx.rerender();
        }
        return;
      }
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
    const shownRuns = (): Run[] => {
      if (!site && !apiWaiting(ctx)) return ctx.state.runs.filter((r) => r.modelId === model.id);
      const key = site && project ? runsKey(site, project.id, model.id) : null;
      return apiRuns?.key === key ? apiRuns.items.map(asRun) : [];
    };
    onAll(root, '[data-run]', 'click', (row) => {
      const run = shownRuns().find((r) => r.id === row.dataset.run);
      if (!run) return;
      ui.params[model.id] = { ...run.params };
      ui.versions[model.id] = run.version;
      ctx.rerender();
      ctx.toast(`Restored run “${run.note || (site ? `#${run.id}` : run.id)}”`);
    });
    const download = (blob: Blob, name: string) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    onAll(root, '[data-export]', 'click', () => {
      const record = auditRecord(shownRuns(), model.id);
      download(
        new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }),
        `tiles-audit-${model.id}.json`,
      );
    });
    // With the API (T4.13): the latest run's audit record, made by the API from the stored runs.
    onAll(root, '[data-audit]', 'click', async (b) => {
      const latest = shownRuns()[0];
      if (!site || !ctx.api || !latest) return;
      const n = Number(latest.id);
      try {
        if (b.dataset.audit === 'pdf') download(await ctx.api.runs.auditPdf(site, n), `tiles-run-${n}-audit.pdf`);
        else
          download(
            new Blob([await ctx.api.runs.audit(site, n)], { type: 'application/json' }),
            `tiles-run-${n}-audit.json`,
          );
      } catch {
        // The client showed why.
      }
    });
  },
};

export default view;
