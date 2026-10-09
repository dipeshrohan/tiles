import { esc, field, onAll, onNavigate, onSubmit, routeOf } from '../lib/dom.ts';
import type { EdgeAgent, Onboarding } from '../lib/api.ts';
import {
  agentConfig,
  names,
  outlineOps,
  outlineProblem,
  PROTOCOLS,
  slugFrom,
  STEPS,
  type StepKey,
} from '../lib/onboarding.ts';
import type { Context, View } from './types.ts';

// Setting up a site (T6.06): a wizard from creating the site, through outlining its plant in the
// ontology and connecting an edge agent, to mapping its tags and opening the first dashboard (a
// machine's Plant page with live readings). Each step's state comes from the API's
// /onboarding, worked out from the site's own data, so it can be left and picked up again.

interface Ui {
  step: StepKey | null; // the step shown; null: the first one not done
}

const uiState = (ctx: Context) => ctx.ui<Ui>('onboarding', { step: null });

const POLL_MS = 5_000; // while waiting for an agent's first heartbeat

let progress: { site: string; data: Onboarding | null } | null = null;
let agents: { site: string; list: EdgeAgent[] | null } | null = null;
let revealed: { site: string; name: string; token: string } | null = null; // shown once
let created: { id: string; name: string } | null = null; // a site just created here
let seq = 0;
let busy = false;
let timer: ReturnType<typeof setInterval> | null = null;

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;

onNavigate((hash) => {
  if (routeOf(hash) === 'onboarding') return;
  if (timer !== null) clearInterval(timer);
  timer = null;
  progress = null; // the next visit asks afresh
  agents = null;
  revealed = null; // a token is shown once, on the visit that made it
  ++seq;
});

async function load(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const mine = ++seq;
  if (progress?.site !== site) progress = { site, data: null };
  try {
    // The ontology too: others outline and map meanwhile, and the next steps link into it.
    const [data, list] = await Promise.all([
      ctx.api.onboarding(site),
      ctx.api.agents.list(site),
      ctx.ontology.reload(),
    ]);
    if (mine !== seq) return;
    progress = { site, data };
    agents = { site, list };
  } catch {
    if (mine !== seq) return; // the client showed why
    agents = { site, list: agents?.site === site ? agents.list : [] };
    if (!progress.data) progress = { site, data: null };
  }
  if (routeOf(location.hash) === 'onboarding') ctx.rerender();
}

const canEdit = (ctx: Context): boolean => ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';

function stepList(data: Onboarding, current: StepKey): string {
  return `<ol class="wizard-steps">${STEPS.map((s, i) => {
    const state = data.steps.find((x) => x.key === s.key);
    const done = state?.done ?? false;
    return `<li class="${done ? 'done' : ''} ${s.key === current ? 'current' : ''}">
        <button class="wizard-step" data-step="${s.key}" ${s.key === current ? 'aria-current="step"' : ''}>
          <span class="wizard-mark" aria-hidden="true">${done ? '✓' : i + 1}</span>
          <span><b>${esc(s.title)}</b><span class="small soft">${done ? 'Done: ' : ''}${esc(state?.detail ?? '')}</span></span>
        </button>
      </li>`;
  }).join('')}</ol>`;
}

function siteStep(ctx: Context): string {
  const here = ctx.ontology.site;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const made = created
    ? `<div class="card" role="status"><p><b>${esc(created.name)}</b> is created, with you as its admin.</p>
        <button class="btn primary" data-open-site="${esc(created.id)}">Set up ${esc(created.name)} now</button></div>`
    : '';
  return `<p>You are setting up <b>${esc(here?.name ?? '')}</b>${here ? ` (<code>${esc(here.slug)}</code>)` : ''}. Next: outline its plant.</p>
    ${made}
    <h3>A new site</h3>
    <p class="small soft">Organisation admins create sites. Each is set up on its own: open it, then come back here.</p>
    <form class="stack" id="new-site" style="gap:10px;max-width:520px">
      <label class="field">Name<input type="text" name="name" required maxlength="120" placeholder="Plant 2" autocomplete="off"></label>
      <label class="field">Short name, in links<input type="text" name="slug" required pattern="[a-z0-9][a-z0-9\\-]{0,62}" placeholder="plant-2" autocomplete="off"></label>
      <label class="field">Time zone<input type="text" name="timezone" required value="${esc(zone)}" autocomplete="off"></label>
      <div><button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>Create the site</button></div>
    </form>`;
}

function outlineStep(ctx: Context, data: Onboarding): string {
  const have = data.machines
    ? `<p>The ontology has ${data.machines} machine${data.machines === 1 ? '' : 's'}. Add another line here, or edit them on the <a href="#/ontology">Ontology</a> page.</p>`
    : '<p>Name a line and its machines. Each machine gets a controller (PLC), which is where the edge agent’s tags go.</p>';
  if (!canEdit(ctx)) return `${have}<p class="small soft">Engineers and admins of the site outline the plant.</p>`;
  const staged = ctx.state.repo.staged.length;
  return `${have}
    ${staged ? `<p class="small" role="note">You have ${staged} staged change${staged === 1 ? '' : 's'}: commit or discard them on the <a href="#/ontology">Ontology</a> page first.</p>` : ''}
    <form class="stack" id="outline" style="gap:10px;max-width:520px">
      <label class="field">Workcenter (optional)<input type="text" name="workcenter" placeholder="Housing casting" autocomplete="off"></label>
      <label class="field">Line<input type="text" name="line" required placeholder="Die-cast line 1" autocomplete="off"></label>
      <label class="field">Machines, one per line<textarea name="machines" rows="4" required placeholder="Die-caster DC-01&#10;Die-caster DC-02"></textarea></label>
      <label class="field">How their controllers are read<select name="protocol">${PROTOCOLS.map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>
      <div><button class="btn primary" type="submit" ${busy || staged ? 'disabled' : ''}>${ctx.ontology.reviewRequired ? 'Send for review' : 'Add to the ontology'}</button></div>
    </form>`;
}

function agentStep(ctx: Context, data: Onboarding): string {
  const list = agents?.site === siteId(ctx) ? agents.list : null;
  const rows = (list ?? [])
    .map(
      (a) =>
        `<li><span><b>${esc(a.name)}</b> <span class="small soft">${esc(a.hostname ?? '')}</span></span><span class="badge ${a.status === 'online' ? 'good' : a.status === 'offline' ? 'warn' : ''}">${esc(a.status)}</span></li>`,
    )
    .join('');
  const waiting =
    !data.agents_seen && data.agents
      ? '<p role="status" class="small">Waiting for the agent’s first heartbeat… this page checks every few seconds.</p>'
      : '';
  const token =
    revealed?.site === siteId(ctx)
      ? `<div class="card stack" style="gap:8px" data-agent-token>
          <p><b>${esc(revealed.name)}</b>’s token, shown only this once. Save it on the agent’s machine as <code>/etc/tiles-edge/token</code>, readable only by the agent’s user:</p>
          <pre class="code-block" tabindex="0">${esc(revealed.token)}</pre>
          <p>Then write <code>/etc/tiles-edge/tiles-edge.toml</code>:</p>
          <pre class="code-block" tabindex="0">${esc(agentConfig(ctx.dataSource.apiUrl))}</pre>
          <p>Check it with <code>tiles-edge check -c /etc/tiles-edge/tiles-edge.toml</code>, then run <code>tiles-edge run -c /etc/tiles-edge/tiles-edge.toml</code> as a service. It only connects out, over HTTPS.</p>
        </div>`
      : '';
  const form =
    ctx.ontology.role === 'admin'
      ? `<form class="row" id="new-agent" style="gap:8px;flex-wrap:wrap">
          <label class="field">Agent name<input type="text" name="name" required maxlength="80" value="${esc(list?.length ? `edge-${String(list.length + 1).padStart(2, '0')}` : 'edge-01')}" autocomplete="off"></label>
          <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>Register an agent</button>
        </form>`
      : '<p class="small soft">Admins of the site register edge agents.</p>';
  return `<p>The edge agent runs on a machine on site that can reach the controllers. It reads them read-only, buffers to disk, and sends readings out to Tiles.</p>
    ${rows ? `<ul class="plant-list">${rows}</ul>` : ''}
    ${waiting}${token}${form}`;
}

function mappingStep(data: Onboarding): string {
  if (!data.tags)
    return `<p>No tags have arrived yet. They come once the agent’s connectors are configured (OPC UA, MQTT or SQL, in its config file); or <a href="#/import">import a file</a> of past readings.</p>`;
  return `<p><b>${data.mapped} of ${data.tags}</b> tags are mapped to Signal nodes.</p>
    <p>On the Signals page, <b>Suggest mappings</b> proposes a Signal node for each tag that has none: one to link, or a new one under its machine’s PLC. Every suggestion says why. Map the tags that matter first; the rest can wait.</p>
    <p><a class="btn primary" href="#/signals">Map tags on the Signals page</a></p>`;
}

function dashboardStep(data: Onboarding): string {
  if (!data.dashboard)
    return '<p>Once a machine has a mapped signal, its page shows the live readings: the first dashboard.</p>';
  return `<p><b>${esc(data.dashboard.label)}</b> has live signals. Its page shows each one’s latest reading, its open warnings, and what feeds it.</p>
    <p class="row" style="gap:8px;flex-wrap:wrap">
      <a class="btn primary" href="#/plant/${encodeURIComponent(data.dashboard.id)}">Open ${esc(data.dashboard.label)}</a>
      <a class="btn" href="#/shopfloor">Shopfloor view</a>
      <a class="btn" href="#/explorer">Data explorer</a>
    </p>
    ${data.next === null ? '<p role="status"><b>This site is set up.</b> Next, add detectors to raise warnings (Warnings page) and invite the team.</p>' : ''}`;
}

const view: View = {
  id: 'onboarding',
  title: 'Set up a site',
  icon: '◔',
  render(ctx) {
    const site = ctx.ontology.site;
    const head = `<div class="page-head"><div><div class="eyebrow">Settings · onboarding</div><h1>Set up ${esc(site?.name ?? 'a site')}</h1>
        <p class="soft">From a new site to its first dashboard: outline the plant, connect an edge agent, map its tags.</p></div>
        ${ctx.api ? '<button class="btn" data-onboarding-refresh>Refresh</button>' : ''}</div>`;
    if (!ctx.api)
      return `${head}<div class="card"><p>Setting up a site needs the Tiles API: sites, edge agents and tags live there. Connect to it in <a href="#/settings">Settings</a>.</p></div>`;
    if (ctx.ontology.status === 'loading') return `${head}<div class="card">Loading from the Tiles API…</div>`;
    if (ctx.ontology.status !== 'ready')
      return `${head}<div class="card" role="alert">Can't reach the Tiles API: ${esc(ctx.ontology.error)}</div>`;
    const data = progress?.site === siteId(ctx) ? progress.data : null;
    if (!data) return `${head}<div class="card">Loading this site’s progress…</div>`;
    const ui = uiState(ctx);
    const current = ui.step ?? data.next ?? 'dashboard';
    const meta = STEPS.find((s) => s.key === current) ?? STEPS[0]!;
    const body: Record<StepKey, () => string> = {
      site: () => siteStep(ctx),
      outline: () => outlineStep(ctx, data),
      agent: () => agentStep(ctx, data),
      mapping: () => mappingStep(data),
      dashboard: () => dashboardStep(data),
    };
    const index = STEPS.findIndex((s) => s.key === current);
    const nextKey = STEPS[index + 1]?.key;
    return `${head}<div class="wizard">
        <nav aria-label="Steps">${stepList(data, current)}</nav>
        <section class="card wizard-panel" aria-labelledby="wizard-title">
          <div class="eyebrow">Step ${index + 1} of ${STEPS.length}</div>
          <h2 id="wizard-title">${esc(meta.title)}</h2>
          <p class="soft">${esc(meta.why)}</p>
          <div class="stack" style="gap:12px;margin-top:12px">${body[current]()}</div>
          ${nextKey ? `<p style="margin-top:16px"><button class="btn" data-step="${nextKey}">Next: ${esc(STEPS[index + 1]!.title.toLowerCase())}</button></p>` : ''}
        </section>
      </div>`;
  },
  bind(root, ctx) {
    if (!ctx.api || ctx.ontology.status !== 'ready') return;
    const site = siteId(ctx);
    if (progress?.site !== site) void load(ctx);
    const data = progress?.site === site ? progress.data : null;
    // While an agent is registered but hasn't called in, check every few seconds.
    const waiting = data !== null && data.agents > 0 && data.agents_seen === 0;
    if (waiting && timer === null) timer = setInterval(() => !document.hidden && void load(ctx), POLL_MS);
    if (!waiting && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    const ui = uiState(ctx);
    onAll(root, '[data-step]', 'click', (el) => {
      ui.step = (el.dataset.step as StepKey | undefined) ?? null;
      ctx.rerender();
    });
    onAll(root, '[data-onboarding-refresh]', 'click', () => void load(ctx));

    // The slug follows the name until it is edited.
    const form = root.querySelector<HTMLFormElement>('#new-site');
    const slug = form?.querySelector<HTMLInputElement>('[name=slug]');
    let slugEdited = false;
    slug?.addEventListener('input', () => (slugEdited = true));
    form?.querySelector<HTMLInputElement>('[name=name]')?.addEventListener('input', (e) => {
      if (slug && !slugEdited) slug.value = slugFrom((e.target as HTMLInputElement).value);
    });
    onSubmit(
      root,
      '#new-site',
      (form) =>
        void (async () => {
          if (!ctx.api || busy) return;
          busy = true;
          try {
            const made = await ctx.api.createSite({
              name: field(form, 'name'),
              slug: field(form, 'slug'),
              timezone: field(form, 'timezone'),
            });
            created = { id: made.id, name: made.name };
            ctx.toast(`${made.name} created`);
          } catch {
            // The client showed why (403: only organisation admins create sites).
          } finally {
            busy = false;
            ctx.rerender();
          }
        })(),
    );
    onAll(root, '[data-open-site]', 'click', (el) => {
      const id = el.dataset.openSite;
      if (!id) return;
      created = null;
      ui.step = null;
      ctx.setDataSource({ ...ctx.dataSource, siteId: id });
    });

    onSubmit(
      root,
      '#outline',
      (outline) =>
        void (async () => {
          if (busy) return;
          const o = {
            site: ctx.ontology.site?.name ?? 'Site',
            workcenter: field(outline, 'workcenter'),
            line: field(outline, 'line'),
            machines: names(field(outline, 'machines')),
            protocol: field(outline, 'protocol'),
          };
          const problem = outlineProblem(o);
          if (problem) return ctx.toast(problem);
          busy = true;
          const review = ctx.ontology.reviewRequired;
          const message = `Outline ${o.line.trim()} (${o.machines.length} machine${o.machines.length === 1 ? '' : 's'})`;
          const ok = await ctx.ontology.act(
            async (store, repo) => {
              if (repo.staged.length)
                throw new Error('Commit or discard your staged changes on the Ontology page first');
              const staged = await store.stage(repo, outlineOps(ctx.graph, o));
              return review
                ? store.requestReview(staged, { message })
                : store.commit(staged, message, ctx.state.user.name);
            },
            review ? 'Sent for review: another engineer approves it' : `${o.line.trim()} added to the ontology`,
          );
          busy = false;
          if (!ok) return ctx.rerender();
          ui.step = null; // done: on to the first step left
          await load(ctx);
        })(),
    );

    onSubmit(
      root,
      '#new-agent',
      (agent) =>
        void (async () => {
          if (!ctx.api || !site || busy) return;
          busy = true;
          try {
            const out = await ctx.api.agents.register(site, field(agent, 'name'));
            revealed = { site, name: out.agent.name, token: out.token };
            ctx.toast(`${out.agent.name} registered`);
          } catch {
            // The client showed why.
          } finally {
            busy = false;
          }
          await load(ctx);
        })(),
    );
  },
};

export default view;
