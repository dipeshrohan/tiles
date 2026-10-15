import { MODELS, evaluate, sweep, sensitivity, makeRun, runDiff, auditRecord, getModel } from '../lib/design.ts';
import type { RunChange } from '../lib/design.ts';
import { API_MODEL, asRun, changesOf, headOf, sweepGrid, sweepKey } from '../lib/design-runs.ts';
import { heatmap, hbars } from '../lib/svg.ts';
import { esc, field, fmt, need, onAll, onSubmit, onNavigate, routeOf, timeAgo, bound } from '../lib/dom.ts';
import type { ApiSweep, DesignProject, DesignRun } from '../lib/api.ts';
import type { DesignModel, ParamSpec, Params, Run } from '../lib/types.ts';
import type { Context, View } from './types.ts';
import { emptyState, pageHead, skeleton } from '../lib/ui.ts';
import { t } from '../lib/i18n.ts';

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
  sweepSteps: number; // points per axis of a sweep run on the API (T4.12)
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
    sweepSteps: 50,
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
// A sweep run on the API (T4.12) for the design's settings (`key`), followed until it ends.
let apiSweep: { key: string; sweep: ApiSweep } | null = null;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
const SWEEP_STEPS = [25, 50, 100];
const POLL_MS = 400;

const sweepRunning = (s: ApiSweep): boolean => s.status === 'queued' || s.status === 'running';

// Follows a sweep until it ends: its progress is written in place (a slider being dragged isn't
// redrawn under the pointer); the page is drawn again when it ends.
function follow(ctx: Context, site: string, key: string, failures = 0): void {
  const at = visit;
  // After a failed read, wait longer before the next (the client showed why); keep following.
  sweepTimer = setTimeout(
    async () => {
      sweepTimer = null;
      if (at !== visit || apiSweep?.key !== key) return;
      try {
        const sweep = await ctx.api!.sweeps.get(site, apiSweep.sweep.id);
        if (at !== visit || apiSweep?.key !== key) return;
        apiSweep = { key, sweep };
        if (sweepRunning(sweep)) {
          const bar = document.querySelector<HTMLProgressElement>('#view [data-sweep-progress]');
          if (bar) bar.value = sweep.done;
          const text = document.querySelector('#view [data-sweep-done]');
          if (text) text.textContent = t('design.sweep.points', { done: fmt(sweep.done), total: fmt(sweep.total) });
          follow(ctx, site, key);
          return;
        }
      } catch {
        if (at === visit && apiSweep?.key === key) follow(ctx, site, key, failures + 1);
        return;
      }
      ctx.rerender();
    },
    POLL_MS * Math.min(2 ** failures, 16),
  );
}

function sweepControls(ctx: Context, key: string, canStart: boolean): string {
  const ui = uiState(ctx);
  const shown = apiSweep?.key === key ? apiSweep.sweep : null;
  if (shown && sweepRunning(shown))
    return `<div class="row gap-2" data-api-sweep>
      <progress data-sweep-progress max="${shown.total}" value="${shown.done}" aria-label="${esc(t('design.sweep.progress'))}"></progress>
      <span class="small soft" data-sweep-done>${esc(t('design.sweep.points', { done: fmt(shown.done), total: fmt(shown.total) }))}</span>
      ${canStart && !shown.cancel_requested ? `<button class="btn sm" data-sweep-cancel>${esc(t('design.sweep.cancel'))}</button>` : ''}
    </div>`;
  const state =
    shown?.status === 'done'
      ? esc(t('design.sweep.done', { total: fmt(shown.total), cached: shown.cached ? 'yes' : 'no' }))
      : shown?.status === 'cancelled'
        ? esc(t('design.sweep.cancelled', { done: fmt(shown.done), total: fmt(shown.total) }))
        : shown?.status === 'failed'
          ? esc(t('design.sweep.failed', { reason: shown.error ?? t('design.sweep.noReason') }))
          : '';
  return `<div class="row gap-2 wrap" data-api-sweep>
      ${state ? `<span class="small soft" data-sweep-state>${state}</span>` : ''}
      ${
        canStart
          ? `<label class="row small gap-1_5">${esc(t('design.sweep.pointsPerAxis'))} <select id="sweep-steps" aria-label="${esc(t('design.sweep.pointsPerAxis'))}">${SWEEP_STEPS.map((n) => `<option value="${n}" ${n === ui.sweepSteps ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
             <button class="btn sm" data-sweep-start>${esc(t('design.sweep.run'))}</button>`
          : ''
      }
    </div>`;
}
let visit = 0; // a fetch that answers after you left (and maybe came back) is dropped
onNavigate((hash) => {
  if (routeOf(hash) !== 'design') {
    projects = null;
    projectsFetching = null;
    apiRuns = null;
    apiSweep = null;
    if (sweepTimer !== null) clearTimeout(sweepTimer);
    sweepTimer = null;
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
      ? `<span class="small soft" aria-busy="true">${esc(t('design.project.loading'))}</span>`
      : items.length
        ? `<label class="row gap-2">${esc(t('design.project.label'))} <select id="project" aria-label="${esc(t('design.project.aria'))}">${items
            .map(
              (p) =>
                `<option value="${esc(p.id)}" ${p.id === shown?.id ? 'selected' : ''}>${esc(t('design.project.option', { name: p.name, count: p.runs }))}</option>`,
            )
            .join('')}</select></label>`
        : `<span class="small soft">${esc(t('design.project.none', { canWrite: canWrite ? 'yes' : 'no' }))}</span>`;
  const create = canWrite
    ? `<form id="new-project" class="row gap-2"><input type="text" name="name" maxlength="200" placeholder="${esc(t('design.project.newName'))}" aria-label="${esc(t('design.project.newName'))}" required /><button class="btn sm" type="submit">${esc(t('design.project.create'))}</button></form>`
    : '';
  return `<div class="card row gap-4 wrap justify-between mb-4" data-projects>
      <div class="row gap-4 wrap">${choose}${shown?.description ? `<span class="small soft">${esc(shown.description)}</span>` : ''}</div>
      ${create}
      <span class="small soft basis-full">${esc(t('design.project.shared'))}</span>
    </div>`;
}

// The sweep's two parameters: those chosen, else the model's first two (never the same twice).
function sweepAxes(model: DesignModel, ui: DesignUi): { xKey: string; yKey: string } {
  const keys = model.params.map((p) => p.key);
  const xKey = ui.sweepX && keys.includes(ui.sweepX) ? ui.sweepX : keys[0]!;
  let yKey = ui.sweepY && keys.includes(ui.sweepY) ? ui.sweepY : keys[1]!;
  if (yKey === xKey) yKey = keys.find((k) => k !== xKey)!;
  return { xKey, yKey };
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
  get title() {
    return t('design.title');
  },
  icon: 'drafting-compass',
  render(ctx) {
    const { ui, model, params, version } = current(ctx);
    const value = evaluate(model.id, version, params);
    const { xKey, yKey } = sweepAxes(model, ui);
    const site0 = siteOf(ctx);
    const keyNow = site0 ? sweepKey(site0, model.id, version, params, xKey, yKey, ui.sweepSteps) : '';
    const finished = apiSweep?.key === keyNow && apiSweep.sweep.status === 'done' ? apiSweep.sweep.result : null;
    const sw = finished ? sweepGrid(finished) : sweep(model.id, version, params, xKey, yKey, 14);
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
      ${pageHead({
        eyebrow: t('design.eyebrow'),
        title: t('design.title'),
        lead: t('design.lead'),
        actionsHtml: `<div class="seg" role="group" aria-label="${esc(t('design.model'))}">${Object.values(MODELS)
          .map(
            (m) => `<button data-model="${m.id}" class="${m.id === model.id ? 'active' : ''}">${esc(m.name)}</button>`,
          )
          .join('')}</div>`,
      })}
      ${site ? projectBar(ctx, site) : apiWaiting(ctx) ? `<div class="card mb-4" data-projects><span class="small soft">${esc(t(ctx.ontology.status === 'error' ? 'design.api.unreachable' : 'design.api.connecting'))}</span>${ctx.ontology.status === 'error' ? ` <button class="btn sm" type="button" data-reconnect>${esc(t('design.api.tryAgain'))}</button>` : ''}</div>` : ''}

      <div class="grid g3 mb-4">
        <div class="card">
          <div class="card-head"><div><h2>${esc(model.name)}</h2><p>${esc(model.domain)}</p></div>
            <select id="version" aria-label="${esc(t('design.version'))}">${Object.keys(model.versions)
              .map(
                (v) =>
                  `<option value="${v}" ${v === version ? 'selected' : ''}>v${v}${v === model.latest ? esc(t('design.latest')) : ''}</option>`,
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
          <button class="btn sm" data-reset>${esc(t('design.reset'))}</button>
        </div>
        <div class="card">
          <div class="label soft small">${esc(model.output.label)}</div>
          <div class="result-big"><span id="result">${fmt(value, 2)}</span> <span class="muted text-lg">${esc(unit)}</span></div>
          <div class="small muted mb-3_5">${esc(t('design.modelVersion', { id: model.id, version }))}</div>
          <h3>${esc(t('design.acrossVersions'))}</h3>
          <table class="mt-1_5 mb-3_5 m-0"><tbody>${Object.keys(model.versions)
            .map(
              (v) =>
                `<tr><td>v${v}</td><td class="num"><b>${fmt(evaluate(model.id, v, params), 2)}</b> ${esc(unit)}</td></tr>`,
            )
            .join('')}</tbody></table>
          <form id="run-form" class="stack gap-2 no-print">
            <input type="text" name="note" maxlength="500" placeholder="${esc(t('design.run.note'))}" aria-label="${esc(t('design.run.noteLabel'))}" />
            <button class="btn primary" type="submit" ${canSave && !saving ? '' : 'disabled'}>${esc(site && project ? t('design.run.saveTo', { project: project.name }) : t('design.run.save'))}</button>
            ${site && !project ? `<span class="small soft">${esc(t('design.run.needProject'))}</span>` : ''}
          </form>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>${esc(t('design.sensitivity'))}</h2><p>${esc(t('design.sensitivityHint'))}</p></div></div>
          ${hbars({ items: sens.map((s) => ({ label: s.label, value: s.delta, color: 'var(--accent)' })), width: 320, left: 120, title: t('design.sensitivityHint'), format: (x) => `${x >= 0 ? '+' : '−'}${fmt(Math.abs(x), 2)}` })}
        </div>
      </div>

      <div class="grid g2 mb-4">
        <div class="card">
          <div class="card-head"><div><h2>${esc(t('design.sweep.title'))}</h2><p>${esc(t('design.sweep.held', { range: `${fmt(sw.min, 2)} – ${fmt(sw.max, 2)} ${unit}` }))}</p></div>
            <div class="row no-print">
              <select id="sweep-x" aria-label="${esc(t('design.sweep.x'))}">${model.params.map((p) => `<option value="${p.key}" ${p.key === xKey ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
              <span class="muted">×</span>
              <select id="sweep-y" aria-label="${esc(t('design.sweep.y'))}">${model.params
                .filter((p) => p.key !== xKey)
                .map((p) => `<option value="${p.key}" ${p.key === yKey ? 'selected' : ''}>${esc(p.label)}</option>`)
                .join('')}</select>
            </div>
          </div>
          ${site0 ? sweepControls(ctx, keyNow, ctx.ontology.role !== null && ctx.ontology.role !== 'viewer') : ''}
          ${heatmap({ ...sw, xLabel: label(xKey), yLabel: label(yKey), format: (v) => `${fmt(v, 2)} ${unit}` })}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>${esc(t('design.history'))}</h2><p>${esc(t('design.historyHint'))}</p></div>
            ${
              site
                ? `<div class="row gap-1_5"><button class="btn sm" data-audit="json" ${runs.length ? '' : 'disabled'} title="${esc(t('design.audit.jsonHint'))}">${esc(t('design.audit.json'))}</button><button class="btn sm" data-audit="pdf" ${runs.length ? '' : 'disabled'}>${esc(t('design.audit.pdf'))}</button><button class="btn sm" data-export ${runs.length ? '' : 'disabled'} title="${esc(t('design.audit.allHint'))}">${esc(t('design.audit.all'))}</button></div>`
                : `<button class="btn sm" data-export ${runs.length ? '' : 'disabled'}>${esc(t('design.audit.export'))}</button>`
            }
          </div>
          ${
            runs.length
              ? `<div class="table-wrap"><table><thead><tr><th>${esc(t('design.col.run'))}</th><th>${esc(t('design.col.changed'))}</th><th class="num">${esc(model.output.label)}</th></tr></thead><tbody>
                ${runs
                  .map((r) => {
                    const diff = diffOf(r);
                    return `<tr class="clickable" data-run="${esc(r.id)}"><td><b>v${esc(r.version)}</b> ${r.note ? esc(r.note) : `<span class="muted">${esc(t('design.untitled'))}</span>`}<div class="small muted">${esc(r.author)} · ${timeAgo(r.date)}</div></td>
                      <td class="diff">${r.parent ? diff.map((d) => `${esc(label(d.key))}: ${show(d.from)} → ${show(d.to)}`).join('<br>') || esc(t('design.noChange')) : esc(t('design.firstRun'))}</td>
                      <td class="num"><b>${fmt(r.value, 2)}</b> ${esc(unit)}</td></tr>`;
                  })
                  .join('')}</tbody></table></div>`
              : site && !project
                ? emptyState({
                    illustration: 'select',
                    compact: true,
                    level: 3,
                    title: t('design.pick'),
                    body: t('design.pickBody', {
                      canWrite: ctx.ontology.role !== null && ctx.ontology.role !== 'viewer' ? 'yes' : 'no',
                    }),
                  })
                : site && !fetched?.loaded
                  ? skeleton.list(3, t('design.loadingRuns'))
                  : remote && !site
                    ? ''
                    : emptyState({
                        illustration: 'chart',
                        compact: true,
                        level: 3,
                        title: t('design.noRuns'),
                        body:
                          remote && ctx.ontology.role === 'viewer' ? t('design.noRunsViewer') : t('design.noRunsBody'),
                      })
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
    root.querySelector<HTMLSelectElement>('#sweep-steps')?.addEventListener(
      'change',
      (e) => {
        ui.sweepSteps = Number((e.target as HTMLSelectElement).value);
        ctx.rerender();
      },
      { signal: bound() },
    );
    onAll(root, '[data-sweep-start]', 'click', async () => {
      if (!site || !ctx.api) return;
      const { xKey, yKey } = sweepAxes(model, ui);
      const version = ui.versions[model.id] ?? model.latest;
      const axis = (k: string) => {
        const p = model.params.find((q) => q.key === k)!;
        return { param: k, from: p.min, to: p.max, steps: ui.sweepSteps };
      };
      const key = sweepKey(site, model.id, version, params, xKey, yKey, ui.sweepSteps);
      try {
        const sweep = await ctx.api.sweeps.start(site, {
          model: API_MODEL[model.id] ?? model.id,
          version,
          params,
          x: axis(xKey),
          y: axis(yKey),
          project: project?.id ?? null,
        });
        apiSweep = { key, sweep };
        if (sweepRunning(sweep)) follow(ctx, site, key);
        ctx.rerender();
      } catch {
        // The client showed why.
      }
    });
    onAll(root, '[data-sweep-cancel]', 'click', async () => {
      if (!site || !ctx.api || !apiSweep) return;
      try {
        const sweep = await ctx.api.sweeps.cancel(site, apiSweep.sweep.id);
        if (apiSweep?.sweep.id === sweep.id) apiSweep = { key: apiSweep.key, sweep };
        ctx.rerender();
      } catch {
        // The client showed why (it may have just finished).
      }
    });
    root.querySelector<HTMLSelectElement>('#project')?.addEventListener(
      'change',
      (e) => {
        ui.project = (e.target as HTMLSelectElement).value;
        ctx.rerender();
      },
      { signal: bound() },
    );
    onSubmit(root, '#new-project', async (form) => {
      const name = field(form, 'name').trim();
      if (!site || !ctx.api || !name) return;
      try {
        const created = await ctx.api.designProjects.create(site, name);
        ui.project = created.id;
        projects = { site, items: [created, ...(projects?.site === site ? projects.items : [])] };
        ctx.toast(t('design.project.created', { name: created.name }));
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
    versionSelect.addEventListener(
      'change',
      () => {
        ui.versions[model.id] = versionSelect.value;
        ctx.rerender();
      },
      { signal: bound() },
    );
    root.querySelectorAll<HTMLInputElement>('[data-param]').forEach((input) => {
      const p = model.params.find((x) => x.key === input.dataset.param);
      if (!p) return;
      input.addEventListener(
        'input',
        () => {
          params[p.key] = Number(input.value);
          need(root, `[data-val="${p.key}"]`).textContent = fmt(params[p.key] ?? p.default, digits(p));
          need(root, '#result').textContent = fmt(evaluate(model.id, ui.versions[model.id] ?? model.latest, params), 2);
        },
        { signal: bound() },
      );
      input.addEventListener('change', () => ctx.rerender(), { signal: bound() });
    });
    onAll(root, '[data-reset]', 'click', () => {
      ui.params[model.id] = defaults(model);
      ctx.rerender();
    });
    const sweepX = need<HTMLSelectElement>(root, '#sweep-x');
    sweepX.addEventListener(
      'change',
      () => {
        ui.sweepX = sweepX.value;
        ctx.rerender();
      },
      { signal: bound() },
    );
    const sweepY = need<HTMLSelectElement>(root, '#sweep-y');
    sweepY.addEventListener(
      'change',
      () => {
        ui.sweepY = sweepY.value;
        ctx.rerender();
      },
      { signal: bound() },
    );
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
          ctx.toast(t('design.run.savedTo', { project: project.name }));
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
      ctx.toast(t('design.run.saved'));
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
      ctx.toast(t('design.run.restored', { run: run.note || (site ? `#${run.id}` : run.id) }));
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
