import { esc, field, onAction, onAll, onNavigate, onSubmit, routeOf, bound } from '../lib/dom.ts';
import type { EdgeAgent, Onboarding } from '../lib/api.ts';
import { placeLink } from '../lib/plant.ts';
import {
  agentConfig,
  DEMO_TAGS,
  freeAgentName,
  LOCAL_KEY,
  localProgress,
  mappedTo,
  mappingOps,
  suggestFor,
  type DemoTag,
  type LocalSetup,
  names,
  outlineOps,
  outlineProblem,
  PROTOCOLS,
  slugFrom,
  STEPS,
  type StepKey,
} from '../lib/onboarding.ts';
import type { Context, View } from './types.ts';
import { button, pageHead, skeleton, apiUnreachable, table } from '../lib/ui.ts';
import { load as loadSaved, save } from '../lib/store.ts';
import { t, tHtml } from '../lib/i18n.ts';

// Setting up a site (T6.06): a wizard from creating the site, through outlining its plant in the
// ontology and connecting an edge agent, to mapping its tags and opening the first dashboard (a
// machine's Plant page with live readings). Each step's state comes from the API's
// /onboarding, worked out from the site's own data, so it can be left and picked up again.
// Without the API (U4.10) it runs on the demo plant, so the flow can be learnt first: progress is
// worked out here from this browser's ontology, a demo agent stands in for a real one, and the
// demo's tags are mapped to Signal nodes (js/lib/onboarding.ts).

interface Ui {
  step: StepKey | null; // the step shown; null: the first one not done
  demoAgent: boolean; // local mode: the demo agent called in (kept here too, should storage fail)
}

const uiState = (ctx: Context) => ctx.ui<Ui>('onboarding', { step: null, demoAgent: false });

const POLL_MS = 5_000; // while waiting for an agent's first heartbeat

// The agent's files and commands, the same in every language.
const TOKEN_PATH = '<code>/etc/tiles-edge/token</code>'; // i18n-ok
const CONFIG_PATH = '<code>/etc/tiles-edge/tiles-edge.toml</code>'; // i18n-ok
const CHECK_CMD = '<code>tiles-edge check -c /etc/tiles-edge/tiles-edge.toml</code>'; // i18n-ok
const RUN_CMD = '<code>tiles-edge run -c /etc/tiles-edge/tiles-edge.toml</code>'; // i18n-ok
const DEMO_AGENT = 'edge-01'; // i18n-ok
const checkAndRun = (): string => tHtml('onboarding.agent.checkRun', { check: CHECK_CMD, run: RUN_CMD });
// A note that the ontology has staged changes, which the wizard won't add to.
const stagedNote = (staged: number): string =>
  `<p class="small" role="note">${tHtml('onboarding.staged', { count: staged, ontology: `<a href="#/ontology">${esc(t('onboarding.ontology'))}</a>` })}</p>`;

// `failed`: the last fetch failed with nothing to show: Try again, not a fetch at every render.
let progress: { site: string; data: Onboarding | null; failed?: boolean } | null = null;
let agents: { site: string; list: EdgeAgent[] | null } | null = null;
let revealed: { site: string; name: string; token: string } | null = null; // shown once
let created: { id: string; name: string } | null = null; // a site just created here
let seq = 0;
let busy = false;
let timer: ReturnType<typeof setInterval> | null = null;

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;

// Slugs someone typed (the element is kept when the page is drawn again, U3.03, and so is this).
const slugEdited = new WeakSet<HTMLInputElement>();

onNavigate((hash) => {
  if (routeOf(hash) === 'onboarding') return;
  if (timer !== null) clearInterval(timer);
  timer = null;
  progress = null; // the next visit asks afresh
  agents = null;
  revealed = null; // a token is shown once, on the visit that made it
  ++seq;
});

// The site's progress and agents. `withOntology`: the ontology too (Refresh, a visit), since others
// outline and map meanwhile; the poll for a heartbeat leaves it. A poll renders only on news, so
// what is being typed in a form stays.
async function load(ctx: Context, { withOntology = false, quiet = false } = {}): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const mine = ++seq;
  if (progress?.site !== site) progress = { site, data: null };
  const before = JSON.stringify([progress.data, agents?.site === site ? agents.list : null]);
  try {
    const [data, list] = await Promise.all([
      ctx.api.onboarding(site),
      ctx.api.agents.list(site),
      withOntology ? ctx.ontology.reload() : undefined,
    ]);
    if (mine !== seq) return;
    // The step shown just got done (the agent called in): on to the first step left.
    const ui = uiState(ctx);
    const was = progress.data?.steps.find((x) => x.key === ui.step);
    if (was && !was.done && data.steps.find((x) => x.key === ui.step)?.done) ui.step = null;
    progress = { site, data };
    agents = { site, list };
  } catch {
    if (mine !== seq) return; // the client showed why
    if (!progress.data) progress = { site, data: null, failed: true };
    if (quiet) return;
  }
  if (quiet && JSON.stringify([progress.data, agents?.list ?? null]) === before) return;
  if (routeOf(location.hash) === 'onboarding') ctx.rerender();
}

const canEdit = (ctx: Context): boolean =>
  !ctx.api || ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';

// The demo agent, kept in this browser across visits (and in the page's state, should storage
// refuse it). Progress and mapping read the committed ontology: a staged change isn't done yet.
const localSetup = (ctx: Context): LocalSetup => ({
  agent: uiState(ctx).demoAgent || loadSaved<Partial<LocalSetup>>(LOCAL_KEY, {}).agent === true,
});
const committed = (ctx: Context) => ctx.state.repo.head;

function localSiteStep(ctx: Context): string {
  const site = Object.values(ctx.graph.nodes).find((n) => n.type === 'Site');
  return `<p>${tHtml('onboarding.local.site', { site: site ? `, <b>${esc(site.label)}</b>` : '' })}</p>
    <p class="small soft">${tHtml('onboarding.local.siteApi', { settings: `<a href="#/settings">${esc(t('onboarding.settings'))}</a>` })}</p>`;
}

function localAgentStep(ctx: Context): string {
  const on = localSetup(ctx).agent;
  return `<p>${esc(t('onboarding.local.agentIntro'))}</p>
    <div class="card stack gap-2">
      <p>${tHtml('onboarding.local.saveToken', { token: TOKEN_PATH, config: CONFIG_PATH })}</p>
      <pre class="code-block" tabindex="0">${esc(agentConfig('https://tiles.example.com'))}</pre>
      <p>${checkAndRun()}</p>
    </div>
    ${
      on
        ? `<ul class="plant-list"><li><span><b>${DEMO_AGENT}</b> <span class="small soft">${esc(t('onboarding.demo'))}</span></span><span class="badge good">${esc(t('onboarding.online'))}</span></li></ul>`
        : `<p>${esc(t('onboarding.local.standIn'))}</p>
      <div>${button(t('onboarding.local.connect'), { variant: 'primary', attrs: { 'data-demo-agent': true } })}</div>`
    }`;
}

function localMappingStep(ctx: Context): string {
  if (!localSetup(ctx).agent) return `<p>${esc(t('onboarding.local.noTags'))}</p>`;
  const graph = committed(ctx);
  const staged = ctx.state.repo.staged.length;
  const tags = DEMO_TAGS.map((tag: DemoTag) => ({ tag, to: mappedTo(graph, tag.tag), s: suggestFor(graph, tag) }));
  const can = canEdit(ctx) && !staged;
  const rows = tags
    .map(({ tag, to, s }) => {
      const cell = to
        ? `<span class="badge good">${esc(t('onboarding.mapped'))}</span> ${esc(graph.nodes[to]?.label ?? to)}`
        : s.kind === 'none'
          ? `<span class="small soft">${esc(s.why)}</span>`
          : `${tHtml(s.kind === 'link' ? 'onboarding.linkTo' : 'onboarding.newSignal', { label: `<b>${esc(s.label)}</b>` })}<div class="small soft">${esc(s.why)}</div>`;
      const act =
        to || s.kind === 'none' || !can
          ? ''
          : button(t('onboarding.map'), {
              size: 'sm',
              attrs: { 'data-map-tag': tag.tag, 'aria-label': t('onboarding.mapNamed', { tag: tag.tag }) },
            });
      return `<tr data-key="tag-${esc(tag.tag)}"><td><code>${esc(tag.tag)}</code></td><td>${esc(tag.unit)}</td><td>${cell}</td><td>${act}</td></tr>`;
    })
    .join('');
  const left = tags.some(({ to, s }) => !to && s.kind !== 'none');
  return `<p>${esc(t('onboarding.local.sent', { count: DEMO_TAGS.length }))}</p>
    ${staged ? stagedNote(staged) : ''}
    ${table({ headers: [t('onboarding.col.tag'), t('onboarding.col.unit'), t('onboarding.col.suggestion'), { label: t('onboarding.col.action'), srOnly: true }], rowsHtml: rows })}
    ${left && can ? `<div>${button(t('onboarding.local.mapAll'), { variant: 'primary', attrs: { 'data-map-all': true } })}</div>` : ''}
    <p class="small soft">${tHtml('onboarding.local.signalsPage', { suggest: `<b>${esc(t('onboarding.suggestMappings'))}</b>` })}</p>`;
}

function stepList(data: Onboarding, current: StepKey): string {
  return `<ol class="wizard-steps">${STEPS.map((s, i) => {
    const state = data.steps.find((x) => x.key === s.key);
    const done = state?.done ?? false;
    return `<li class="${done ? 'done' : ''} ${s.key === current ? 'current' : ''}">
        <button class="wizard-step" data-step="${s.key}" ${s.key === current ? 'aria-current="step"' : ''}>
          <span class="wizard-mark" aria-hidden="true">${done ? '✓' : i + 1}</span>
          <span><b>${esc(s.title)}</b><span class="small soft">${done ? esc(t('onboarding.doneDetail')) : ''}${esc(state?.detail ?? '')}</span></span>
        </button>
      </li>`;
  }).join('')}</ol>`;
}

function siteStep(ctx: Context): string {
  const here = ctx.ontology.site;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const made = created
    ? `<div class="card" role="status"><p>${tHtml('onboarding.site.created', { name: `<b>${esc(created.name)}</b>` })}</p>
        <button class="btn primary" data-open-site="${esc(created.id)}">${esc(t('onboarding.site.setUpNow', { name: created.name }))}</button></div>`
    : '';
  return `<p>${tHtml('onboarding.site.current', { name: `<b>${esc(here?.name ?? '')}</b>`, slug: here ? ` (<code>${esc(here.slug)}</code>)` : '' })}</p>
    ${made}
    <h3>${esc(t('onboarding.site.new'))}</h3>
    <p class="small soft">${esc(t('onboarding.site.newBody'))}</p>
    <form class="stack gap-2_5 max-w-form" id="new-site">
      <label class="field">${esc(t('onboarding.site.name'))}<input type="text" name="name" required maxlength="120" placeholder="${esc(t('onboarding.site.namePlaceholder'))}" autocomplete="off"></label>
      <label class="field">${esc(t('onboarding.site.slug'))}<input type="text" name="slug" required pattern="[a-z0-9][a-z0-9\\-]{0,62}" placeholder="${esc(t('onboarding.site.slugPlaceholder'))}" autocomplete="off"></label>
      <label class="field">${esc(t('onboarding.site.timezone'))}<input type="text" name="timezone" required value="${esc(zone)}" autocomplete="off"></label>
      <div><button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${esc(t('onboarding.site.create'))}</button></div>
    </form>`;
}

function outlineStep(ctx: Context, data: Onboarding): string {
  const have = data.machines
    ? `<p>${tHtml('onboarding.outline.have', { count: data.machines, ontology: `<a href="#/ontology">${esc(t('onboarding.ontology'))}</a>` })}</p>`
    : `<p>${esc(t('onboarding.outline.intro'))}</p>`;
  if (!canEdit(ctx)) return `${have}<p class="small soft">${esc(t('onboarding.outline.who'))}</p>`;
  const staged = ctx.state.repo.staged.length;
  return `${have}
    ${staged ? stagedNote(staged) : ''}
    <form class="stack gap-2_5 max-w-form" id="outline">
      <label class="field">${esc(t('onboarding.outline.workcenter'))}<input type="text" name="workcenter" placeholder="${esc(t('onboarding.outline.workcenterPlaceholder'))}" autocomplete="off"></label>
      <label class="field">${esc(t('onboarding.outline.line'))}<input type="text" name="line" required placeholder="${esc(t('onboarding.outline.linePlaceholder'))}" autocomplete="off"></label>
      <label class="field">${esc(t('onboarding.outline.machines'))}<textarea name="machines" rows="4" required placeholder="${esc(t('onboarding.outline.machinesPlaceholder')).replace(/\n/g, '&#10;')}"></textarea></label>
      <label class="field">${esc(t('onboarding.outline.protocol'))}<select name="protocol">${PROTOCOLS.map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>
      <div><button class="btn primary" type="submit" ${busy || staged ? 'disabled' : ''}>${esc(t(ctx.ontology.reviewRequired ? 'onboarding.outline.sendReview' : 'onboarding.outline.add'))}</button></div>
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
    !data.agents_seen && data.agents ? `<p role="status" class="small">${esc(t('onboarding.agent.waiting'))}</p>` : '';
  const token =
    revealed?.site === siteId(ctx)
      ? `<div class="card stack gap-2" data-agent-token>
          <p>${tHtml('onboarding.agent.token', { name: `<b>${esc(revealed.name)}</b>`, token: TOKEN_PATH })}</p>
          <pre class="code-block" tabindex="0">${esc(revealed.token)}</pre>
          <p>${tHtml('onboarding.agent.thenWrite', { config: CONFIG_PATH })}</p>
          <pre class="code-block" tabindex="0">${esc(agentConfig(ctx.dataSource.apiUrl))}</pre>
          <p>${checkAndRun()}</p>
        </div>`
      : '';
  const form =
    ctx.ontology.role === 'admin'
      ? `<form class="row gap-2 wrap" id="new-agent">
          <label class="field">${esc(t('onboarding.agent.name'))}<input type="text" name="name" required maxlength="80" value="${esc(freeAgentName((list ?? []).map((a) => a.name)))}" autocomplete="off"></label>
          <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${esc(t('onboarding.agent.register'))}</button>
        </form>`
      : `<p class="small soft">${esc(t('onboarding.agent.who'))}</p>`;
  return `<p>${esc(t('onboarding.agent.intro'))}</p>
    ${rows ? `<ul class="plant-list">${rows}</ul>` : ''}
    ${waiting}${token}${form}`;
}

function mappingStep(data: Onboarding): string {
  if (!data.tags)
    return `<p>${tHtml('onboarding.mapping.none', { import: `<a href="#/import">${esc(t('onboarding.mapping.importFile'))}</a>` })}</p>`;
  return `<p>${tHtml('onboarding.mapping.count', { mapped: `<b>${esc(t('onboarding.mapping.of', { mapped: data.mapped, tags: data.tags }))}</b>` })}</p>
    <p>${tHtml('onboarding.mapping.how', { suggest: `<b>${esc(t('onboarding.suggestMappings'))}</b>` })}</p>
    <p><a class="btn primary" href="#/signals">${esc(t('onboarding.mapping.go'))}</a></p>`;
}

function dashboardStep(data: Onboarding, local: boolean): string {
  if (!data.dashboard)
    return local ? `<p>${esc(t('onboarding.dash.localNone'))}</p>` : `<p>${esc(t('onboarding.dash.none'))}</p>`;
  return `<p>${
    local
      ? tHtml('onboarding.dash.local', { machine: `<b>${esc(data.dashboard.label)}</b>` })
      : tHtml('onboarding.dash.live', { machine: `<b>${esc(data.dashboard.label)}</b>` })
  }</p>
    <p class="row gap-2 wrap">
      <a class="btn primary" href="${placeLink(data.dashboard.id)}">${esc(t('onboarding.dash.open', { machine: data.dashboard.label }))}</a>
      <a class="btn" href="#/shopfloor">${esc(t('onboarding.dash.shopfloor'))}</a>
      <a class="btn" href="#/explorer">${esc(t('onboarding.dash.explorer'))}</a>
    </p>
    ${data.next === null ? `<p role="status"><b>${esc(t('onboarding.dash.setUp'))}</b> ${esc(t('onboarding.dash.next'))}</p>` : ''}`;
}

const view: View = {
  id: 'onboarding',
  get title() {
    return t('onboarding.title');
  },
  icon: 'rocket',
  render(ctx) {
    const site = ctx.ontology.site;
    const head = pageHead({
      eyebrow: t('onboarding.eyebrow'),
      title: t('onboarding.headTitle', { site: site?.name ?? t('onboarding.aSite') }),
      lead: t('onboarding.lead'),
      actionsHtml: ctx.api ? button(t('onboarding.refresh'), { attrs: { 'data-onboarding-refresh': true } }) : '',
    });
    const local = !ctx.api;
    if (!local && ctx.ontology.status === 'loading')
      return `${head}<div class="card">${skeleton.card(t('onboarding.loadingApi'))}</div>`;
    if (!local && ctx.ontology.status !== 'ready')
      return `${head}${apiUnreachable(ctx.ontology.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })}`;
    const data = local
      ? localProgress(committed(ctx), localSetup(ctx))
      : progress?.site === siteId(ctx)
        ? progress.data
        : null;
    if (!data)
      return progress?.failed
        ? `${head}<div class="card" role="alert"><p>${esc(t('onboarding.failed'))}</p><button class="btn" data-onboarding-refresh>${esc(t('onboarding.tryAgain'))}</button></div>`
        : `${head}<div class="card">${skeleton.list(4, t('onboarding.loadingProgress'))}</div>`;
    const ui = uiState(ctx);
    const current = ui.step ?? data.next ?? 'dashboard';
    const meta = STEPS.find((s) => s.key === current) ?? STEPS[0]!;
    const body: Record<StepKey, () => string> = {
      site: () => (local ? localSiteStep(ctx) : siteStep(ctx)),
      outline: () => outlineStep(ctx, data),
      agent: () => (local ? localAgentStep(ctx) : agentStep(ctx, data)),
      mapping: () => (local ? localMappingStep(ctx) : mappingStep(data)),
      dashboard: () => dashboardStep(data, local),
    };
    const index = STEPS.findIndex((s) => s.key === current);
    const nextKey = STEPS[index + 1]?.key;
    const demo = local ? `<p class="small soft mb-3" role="note">${esc(t('onboarding.demoNote'))}</p>` : '';
    return `${head}${demo}<div class="wizard">
        <nav aria-label="${esc(t('onboarding.steps'))}">${stepList(data, current)}</nav>
        <section class="card wizard-panel" aria-labelledby="wizard-title">
          <div class="eyebrow">${esc(t('onboarding.stepOf', { n: index + 1, total: STEPS.length }))}</div>
          <h2 id="wizard-title">${esc(meta.title)}</h2>
          <p class="soft">${esc(meta.why)}</p>
          <div class="stack gap-3 mt-3">${body[current]()}</div>
          ${nextKey ? `<p class="mt-4"><button class="btn" data-step="${nextKey}">${esc(t('onboarding.next', { step: STEPS[index + 1]!.title.toLowerCase() }))}</button></p>` : ''}
        </section>
      </div>`;
  },
  bind(root, ctx) {
    const local = !ctx.api;
    if (!local && ctx.ontology.status !== 'ready') return;
    const site = siteId(ctx);
    if (!local && progress?.site !== site) void load(ctx, { withOntology: true });
    const data = progress?.site === site ? progress.data : null;
    // While an agent is registered but hasn't called in, check every few seconds.
    const waiting = !local && data !== null && data.agents > 0 && data.agents_seen === 0;
    if (waiting && timer === null)
      timer = setInterval(() => !document.hidden && void load(ctx, { quiet: true }), POLL_MS);
    if (!waiting && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    const ui = uiState(ctx);
    onAll(root, '[data-step]', 'click', (el) => {
      ui.step = (el.dataset.step as StepKey | undefined) ?? null;
      ctx.rerender();
    });
    onAll(root, '[data-onboarding-refresh]', 'click', () => void load(ctx, { withOntology: true }));

    // The slug follows the name until it is edited.
    const form = root.querySelector<HTMLFormElement>('#new-site');
    const slug = form?.querySelector<HTMLInputElement>('[name=slug]');
    slug?.addEventListener('input', () => slugEdited.add(slug), { signal: bound() });
    form?.querySelector<HTMLInputElement>('[name=name]')?.addEventListener(
      'input',
      (e) => {
        if (slug && !slugEdited.has(slug)) slug.value = slugFrom((e.target as HTMLInputElement).value);
      },
      { signal: bound() },
    );
    onSubmit(root, '#new-site', (form) =>
      (async () => {
        if (!ctx.api || busy) return;
        busy = true;
        try {
          const made = await ctx.api.createSite({
            name: field(form, 'name'),
            slug: field(form, 'slug'),
            timezone: field(form, 'timezone'),
          });
          created = { id: made.id, name: made.name };
          ctx.toast(t('onboarding.createdToast', { name: made.name }));
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

    onSubmit(root, '#outline', (outline) =>
      (async () => {
        if (busy) return;
        const o = {
          site: ctx.ontology.site?.name ?? t('onboarding.siteFallback'),
          workcenter: field(outline, 'workcenter'),
          line: field(outline, 'line'),
          machines: names(field(outline, 'machines')),
          protocol: field(outline, 'protocol'),
        };
        const problem = outlineProblem(o);
        if (problem) return ctx.toast(problem);
        busy = true;
        const review = ctx.ontology.reviewRequired;
        const message = t('onboarding.outline.message', { line: o.line.trim(), count: o.machines.length });
        const ok = await ctx.ontology.act(
          async (store, repo) => {
            if (repo.staged.length) throw new Error(t('onboarding.stagedFirst'));
            const staged = await store.stage(repo, outlineOps(ctx.graph, o));
            return review
              ? store.requestReview(staged, { message })
              : store.commit(staged, message, ctx.state.user.name);
          },
          review ? t('onboarding.outline.sent') : t('onboarding.outline.added', { line: o.line.trim() }),
        );
        busy = false;
        if (!ok) return ctx.rerender();
        ui.step = null; // done: on to the first step left
        if (local) ctx.rerender();
        else await load(ctx, { withOntology: true });
      })(),
    );

    // In local mode (U4.10): the demo agent, and the demo's tags mapped as suggested.
    onAll(root, '[data-demo-agent]', 'click', () => {
      ui.demoAgent = true;
      save(LOCAL_KEY, { ...localSetup(ctx), agent: true });
      ctx.toast(t('onboarding.demoCalledIn', { agent: DEMO_AGENT }), {
        type: 'success',
        description: t('onboarding.demoSent', { count: DEMO_TAGS.length }),
      });
      ui.step = null;
      ctx.rerender();
    });
    const mapTags = async (tags: readonly DemoTag[]): Promise<void> => {
      if (busy) return;
      busy = true;
      const message =
        tags.length === 1
          ? t('onboarding.mapOne', { tag: tags[0]!.tag })
          : t('onboarding.mapMany', { count: tags.length });
      await ctx.ontology.act(
        async (store, repo) => {
          if (repo.staged.length) throw new Error(t('onboarding.stagedFirst'));
          const ops = mappingOps(repo.head, tags);
          if (!ops.length) throw new Error(t('onboarding.nothingLeft'));
          return store.commit(await store.stage(repo, ops), message, ctx.state.user.name);
        },
        tags.length === 1 ? t('onboarding.tagMapped', { tag: tags[0]!.tag }) : t('onboarding.tagsMapped'),
      );
      busy = false;
      ui.step = 'mapping'; // stays on the tags, with the rest to map, until Next
      ctx.rerender();
    };
    onAction(root, '[data-map-tag]', (el) => mapTags(DEMO_TAGS.filter((d) => d.tag === el.dataset.mapTag)));
    onAction(root, '[data-map-all]', () => mapTags(DEMO_TAGS));

    onSubmit(root, '#new-agent', (agent) =>
      (async () => {
        if (!ctx.api || !site || busy) return;
        busy = true;
        try {
          const out = await ctx.api.agents.register(site, field(agent, 'name'));
          revealed = { site, name: out.agent.name, token: out.token };
          ctx.toast(t('onboarding.registered', { name: out.agent.name }));
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
