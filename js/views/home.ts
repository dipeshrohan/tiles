import { graphHealth } from '../lib/ontology.ts';
import { MODELS } from '../lib/design.ts';
import { esc, fmt, timeAgo } from '../lib/dom.ts';
import type { WarningInfo } from '../lib/api.ts';
import { icon } from '../lib/icons.ts';
import type { Context, View } from './types.ts';
import { apiUnreachable, button, emptyState, loadFailed, pageHead, skeleton } from '../lib/ui.ts';
import {
  agentProblems,
  CARDS,
  cardOf,
  homeRole,
  machinesOut,
  moveCard,
  myWarnings,
  needsOf,
  qualityProblems,
  recentInsights,
  reviewsForMe,
  ROLE_CARDS,
  ROLE_LABELS,
  shiftStart,
  shiftSummary,
  staleSignals,
  type CardId,
} from '../lib/home-cards.ts';
import { ensureHome, homeLayout, keepCards, slot, SIGNALS_PAGE } from './home-data.ts';
import { machineBoard, placeWarning } from '../lib/shopfloor.ts';
import { when } from '../lib/warnings.ts';
import { placeLink } from '../lib/plant.ts';
import { onAll } from '../lib/dom.ts';
import { ux } from '../lib/analytics.ts';

// Home (U5.01): in local mode, the demo's hero and figures; with the Tiles API, cards set by your
// role that each answer "what needs me now?", which you can add, remove and order (Customize).

interface Ui {
  editing: boolean;
}
const uiState = (ctx: Context) => ctx.ui<Ui>('home', { editing: false });

const MAX_ROWS = 5;

// A card's figure: the number that answers it, and what it counts.
const figure = (n: number, what: string, tone: '' | 'bad' | 'warn' | 'good' = ''): string =>
  `<p class="home-figure ${tone}"><span class="value" data-tick>${fmt(n)}</span> <span>${esc(what)}</span></p>`;

const more = (n: number, href: string, what: string): string =>
  n > MAX_ROWS ? `<p class="small"><a href="${esc(href)}">${fmt(n - MAX_ROWS)} more ${esc(what)}</a></p>` : '';

const rows = (items: readonly string[]): string =>
  `<ul class="home-list">${items
    .slice(0, MAX_ROWS)
    .map((i) => `<li>${i}</li>`)
    .join('')}</ul>`;

const nothing = (title: string, body: string): string => emptyState({ compact: true, level: 3, title, body });

const warningRow = (w: WarningInfo, now: number): string =>
  `<a href="#/warnings?show=all&amp;warning=${encodeURIComponent(w.id)}">${esc(w.signal_tag)}</a><span class="small soft">${esc(
    w.ended_at === null ? 'Still out' : 'Back in range',
  )} · ${esc(when(w.started_at, now))}</span>`;

// Each card's body from its data; null while it loads.
function cardBody(ctx: Context, id: CardId, now: number): string | null {
  const me = ctx.ontology.userId;
  switch (id) {
    case 'my-warnings': {
      const all = slot(ctx, 'my-warnings').value;
      if (!all) return null;
      const mine = myWarnings(all, me);
      if (!mine.length) return nothing('Nothing assigned to you', 'Warnings someone assigns you show here.');
      return `${figure(mine.length, mine.length === 1 ? 'warning assigned to you' : 'warnings assigned to you', 'bad')}
        ${rows(mine.map((w) => warningRow(w, now)))}${more(mine.length, '#/warnings?who=me', 'on the Warnings page')}`;
    }
    case 'machines-out': {
      const all = slot(ctx, 'open-warnings').value;
      const signals = slot(ctx, 'signals').value;
      if (!all || !signals) return null;
      const links = new Map(signals.flatMap((s) => (s.node_id ? [[s.tag, s.node_id] as const] : [])));
      const out = machinesOut(
        machineBoard(
          ctx.graph,
          all.map((w) => placeWarning(ctx.graph, w, links, '')),
        ),
      );
      if (!out.length)
        return nothing('No machine is out of range', 'A machine shows here while one of its signals is out.');
      return `${figure(out.length, out.length === 1 ? 'machine with a signal still out' : 'machines with a signal still out', 'bad')}
        ${rows(
          out.map(
            (m) =>
              `<a href="${esc(placeLink(m.id))}">${esc(m.label)}</a><span class="small soft">${esc(
                [...m.path.slice(-1), `${m.warnings} open warning${m.warnings === 1 ? '' : 's'}`].join(' · '),
              )}</span>`,
          ),
        )}${more(out.length, '#/shopfloor', 'on the Shopfloor')}`;
    }
    case 'shift': {
      const all = slot(ctx, 'recent-warnings').value;
      if (!all) return null;
      const start = shiftStart(new Date(now));
      const s = shiftSummary(all, start);
      const since = start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      if (!s.raised.length) return nothing(`No warnings since ${since}`, 'Warnings raised this shift show here.');
      return `${figure(s.waiting.length, `of ${s.raised.length} raised since ${since} not acknowledged`, s.waiting.length ? 'bad' : 'good')}
        <p class="small soft">${fmt(s.acknowledged)} acknowledged.</p>
        ${s.waiting.length ? rows(s.waiting.map((w) => warningRow(w, now))) : ''}${more(s.waiting.length, '#/warnings?show=raised', 'on the Warnings page')}`;
    }
    case 'reviews': {
      const all = slot(ctx, 'reviews').value;
      if (!all) return null;
      const mine = reviewsForMe(all, me);
      if (!mine.length) return nothing('No review waits for you', 'Change requests you may approve show here.');
      return `${figure(mine.length, mine.length === 1 ? 'change request waiting' : 'change requests waiting', 'warn')}
        ${rows(
          mine.map(
            (r) =>
              `<a href="#/reviews/${r.number}">#${r.number} ${esc(r.message || 'Untitled change')}</a><span class="small soft">${esc(r.author)} · ${esc(when(r.created_at, now))}</span>`,
          ),
        )}${more(mine.length, '#/reviews', 'on the Change reviews page')}`;
    }
    case 'insights': {
      const all = slot(ctx, 'insights').value;
      if (!all) return null;
      if (!all.length)
        return nothing('No insights yet', 'Findings saved from the correlation finder or the Data explorer show here.');
      return rows(
        recentInsights(all).map(
          (i) =>
            `<a href="#/insights/${i.number}">${esc(i.title)}</a><span class="small soft">${esc(i.author)} · ${esc(when(i.updated_at, now))}</span>`,
        ),
      );
    }
    case 'freshness': {
      const all = slot(ctx, 'signals').value;
      if (!all) return null;
      const stale = staleSignals(all, now);
      const counted =
        all.length === SIGNALS_PAGE
          ? `of the first ${fmt(SIGNALS_PAGE)} signals`
          : `of ${fmt(all.length)} signal${all.length === 1 ? '' : 's'}`;
      if (!all.length) return nothing('No signals yet', 'Signals arrive from edge agents and imports.');
      if (!stale.length)
        return `${figure(0, `${counted} stale`, 'good')}<p class="small soft">Every signal has sent a reading in the last 15 min.</p>`;
      return `${figure(stale.length, `${counted} stale`, 'warn')}
        ${rows(
          stale.map(
            (s) =>
              `<a href="#/signals?q=${encodeURIComponent(s.tag)}">${esc(s.tag)}</a><span class="small soft">${esc(s.last_at ? `Last reading ${when(s.last_at, now)}` : 'No reading yet')}</span>`,
          ),
        )}${more(stale.length, '#/signals', 'on the Signals page')}`;
    }
    case 'agents': {
      const all = slot(ctx, 'agents').value;
      if (!all) return null;
      if (!all.length) return nothing('No edge agents', 'Register one on Set up a site.');
      const problems = agentProblems(all);
      if (!problems.length)
        return `${figure(all.length, all.length === 1 ? 'agent, online' : 'agents, all online', 'good')}`;
      return `${figure(problems.length, `of ${all.length} agent${all.length === 1 ? '' : 's'} not online`, 'bad')}
        ${rows(
          problems.map(
            (a) =>
              `<a href="#/settings">${esc(a.name)}</a><span class="small soft">${esc(a.status === 'offline' ? `Offline, last seen ${when(a.last_seen_at ?? '', now)}` : 'Never called in')}</span>`,
          ),
        )}`;
    }
    case 'quality': {
      const all = slot(ctx, 'quality').value;
      if (!all) return null;
      const problems = qualityProblems(all);
      if (!problems.length)
        return nothing(
          'No quality problems',
          'Signals whose last check found gaps, stuck or out-of-range values show here.',
        );
      return `${figure(problems.length, problems.length === 1 ? 'signal with problems' : 'signals with problems', 'warn')}
        ${rows(
          problems.map(
            (s) =>
              `<a href="#/signals?q=${encodeURIComponent(s.tag)}&amp;quality=${s.quality.badge}">${esc(s.tag)}</a><span class="small soft">${esc(s.quality.badge === 'bad' ? 'Bad' : 'Needs a look')}</span>`,
          ),
        )}${more(problems.length, '#/signals?quality=bad', 'on the Signals page')}`;
    }
  }
}

const CARD_LINKS: Record<CardId, [string, string]> = {
  'my-warnings': ['#/warnings?who=me', 'Warnings'],
  'machines-out': ['#/shopfloor', 'Shopfloor'],
  shift: ['#/warnings', 'Warnings'],
  reviews: ['#/reviews', 'Change reviews'],
  insights: ['#/insights', 'Insights'],
  freshness: ['#/signals', 'Signals'],
  agents: ['#/settings', 'Settings'],
  quality: ['#/signals?quality=bad', 'Signals'],
};

function cardHtml(ctx: Context, id: CardId, at: number, count: number, editing: boolean, now: number): string {
  const def = cardOf(id)!;
  const failed = def.needs.some((n) => slot(ctx, n).failed);
  const body = failed
    ? loadFailed(def.title, 3)
    : (cardBody(ctx, id, now) ?? skeleton.list(3, `Loading ${def.title.toLowerCase()}…`));
  const [href, page] = CARD_LINKS[id];
  const controls = editing
    ? `<div class="home-card-edit row gap-1 wrap">
        ${button('Move up', { size: 'sm', variant: 'ghost', disabled: at === 0, attrs: { 'data-card-up': id, 'aria-label': `Move ${def.title} up` } })}
        ${button('Move down', { size: 'sm', variant: 'ghost', disabled: at === count - 1, attrs: { 'data-card-down': id, 'aria-label': `Move ${def.title} down` } })}
        ${button('Remove', { size: 'sm', variant: 'ghost', attrs: { 'data-card-remove': id, 'aria-label': `Remove ${def.title}` } })}
      </div>`
    : '';
  return `<section class="card home-card" data-key="card-${id}" data-card="${id}" aria-labelledby="home-${id}">
      <div class="card-head row justify-between gap-2"><h2 id="home-${id}">${esc(def.title)}</h2><a class="small" href="${esc(href)}">Open ${esc(page)}</a></div>
      ${body}
      ${controls}
    </section>`;
}

function roleHome(ctx: Context): string {
  const site = ctx.ontology.site;
  const lead = 'What needs you now.';
  if (ctx.ontology.status === 'loading' || !site)
    return `${pageHead({ title: 'Home', lead })}${skeleton.card('Loading from the Tiles API…')}`;
  if (ctx.ontology.status !== 'ready')
    return `${pageHead({ title: 'Home', lead })}${apiUnreachable(ctx.ontology.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })}`;
  const role = homeRole(ctx.workRole, ctx.ontology.role);
  const { cards: kept } = homeLayout(ctx);
  const cards = kept ?? [...ROLE_CARDS[role]];
  const editing = uiState(ctx).editing;
  const now = Date.now();
  const head = pageHead({
    title: 'Home',
    lead: `What needs you now on ${site.name}. ${kept ? 'Your cards' : `The cards for ${ROLE_LABELS[role]}`}: Customize changes them.`,
    actionsHtml: editing
      ? button('Done', { variant: 'primary', attrs: { 'data-home-done': true } })
      : button('Customize', { attrs: { 'data-home-edit': true } }),
  });
  const absent = CARDS.filter((c) => !cards.includes(c.id));
  const edit = editing
    ? `<div class="card home-edit stack gap-2" aria-label="Customize your home">
        <form class="row gap-2 wrap items-end" data-card-add-form>
          <label class="field">Add a card<select name="card"${absent.length ? '' : ' disabled'}>${
            absent.map((c) => `<option value="${c.id}">${esc(c.title)}: ${esc(c.summary)}</option>`).join('') ||
            '<option>Every card is on your home</option>'
          }</select></label>
          ${button('Add', { type: 'submit', disabled: !absent.length })}
        </form>
        <p class="small soft">${kept ? `${button(`Use the cards for ${ROLE_LABELS[role]}`, { size: 'sm', variant: 'ghost', attrs: { 'data-home-reset': true } })}` : `These are the cards for ${esc(ROLE_LABELS[role])}. Your changes are kept for you on this site.`}</p>
      </div>`
    : '';
  const grid = cards.length
    ? `<div class="home-cards">${cards.map((id, i) => cardHtml(ctx, id, i, cards.length, editing, now)).join('')}</div>`
    : `<div class="card">${nothing('No cards on your home', 'Customize adds the cards you want here.')}</div>`;
  return `${head}${edit}${grid}`;
}

function demoHome(ctx: Context): string {
  const { state } = ctx;
  const health = graphHealth(ctx.graph);
  const ng = state.batches.filter((b) => b.ng).length;
  // The demo shots are worked out after the first paint (U3.07): until then, the card waits.
  const friction = ctx.demoReady
    ? (() => {
        const predicted = state.scored.filter((s) => s.predicted);
        const lead = predicted.reduce((a, s) => a + s.leadHours, 0) / (predicted.length || 1);
        return {
          value: String(state.detection.alerts.length),
          note: `${predicted.length}/${state.scored.length} stops predicted, ${fmt(lead, 1)} h avg lead`,
        };
      })()
    : null;

  const feed = [
    ...state.repo.history.map((c) => ({
      date: c.date,
      icon: 'git-commit-horizontal' as const,
      text: `<b>${esc(c.message)}</b> <span class="muted">· ${esc(c.author)}</span>`,
      href: '#/ontology',
    })),
    ...state.runs.map((r) => ({
      date: r.date,
      icon: 'drafting-compass' as const,
      text: `<b>${esc(MODELS[r.modelId]?.name ?? r.modelId)} v${esc(r.version)}</b> run ${r.note ? `— ${esc(r.note)}` : ''} <span class="muted">· ${esc(r.author)}</span>`,
      href: '#/design',
    })),
  ]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 6);

  return `
      <section class="hero">
        <div>
          <div class="eyebrow">Tiles</div>
          <h1 tabindex="-1">Physics and plant data, in one place.</h1>
          <p>Tiles combines physics models with machine data to help design teams iterate faster and help production teams cut downtime and scrap. Every answer shows the data, model version and change behind it.</p>
          <div class="row mt-4">
            <a class="btn primary" href="#/chat">Ask the copilot</a>
            <a class="btn" href="#/physics">See live warnings</a>
          </div>
        </div>
        <div class="engine" aria-label="How it works">
          <div class="k">HOW IT WORKS</div>
          <div class="pill">Physics models</div>
          <div class="op">+</div>
          <div class="pill">Live data</div>
          <div class="op">↓</div>
          <div class="pill">Answers and warnings</div>
        </div>
      </section>

      <div class="grid g4 mb-4">
        <a class="card kpi bad text-inherit no-underline" href="#/physics"${friction ? '' : ' aria-busy="true"'}>
          <div class="label">Friction warnings · DC-02</div>
          ${
            friction
              ? `<div class="value">${friction.value}</div><div class="note">${friction.note}</div>`
              : `<div class="value"><span class="skeleton kpi-wait"></span><span class="sr-only">Working out the warnings</span></div><div class="note"><span class="skeleton kpi-wait wide"></span></div>`
          }
        </a>
        <a class="card kpi text-inherit no-underline" href="#/quality">
          <div class="label">Cutter NG rate</div>
          <div class="value">${fmt((100 * ng) / state.batches.length, 1)}%</div>
          <div class="note">${ng} of ${state.batches.length} batches · root cause found</div>
        </a>
        <a class="card kpi text-inherit no-underline ${health.score < 100 ? '' : 'good'}" href="#/ontology">
          <div class="label">Ontology health</div>
          <div class="value">${health.score}</div>
          <div class="note">${health.counts.nodes} nodes · ${health.counts.edges} relationships · ${health.issues.length} issue(s)</div>
        </a>
        <a class="card kpi text-inherit no-underline" href="#/design">
          <div class="label">Design runs logged</div>
          <div class="value">${state.runs.length}</div>
          <div class="note">${Object.keys(MODELS).length} physics models in library</div>
        </a>
      </div>

      <div class="grid g3">
        <div class="card product">
          <span class="badge accent tag">for Design</span>
          <h2>Tiles Design</h2>
          <p class="soft">Design, simulate and optimise physical systems from first principles, with every run versioned and auditable.</p>
          <ul>
            <li>Versioned physics model library</li>
            <li>Parameter sweeps &amp; sensitivity</li>
            <li>Run lineage and one-click audit export</li>
          </ul>
          <a href="#/design">Open design studio →</a>
        </div>
        <div class="card product">
          <span class="badge accent tag">for Operations</span>
          <h2>Tiles Operations</h2>
          <p class="soft">Real-time troubleshooting and process control on live machines, grounded in a factory ontology.</p>
          <ul>
            <li>Virtual sensors that warn before downtime</li>
            <li>Correlation finder for quality root cause</li>
            <li>Versioned ontology with health checks</li>
          </ul>
          <a href="#/quality">Open process &amp; quality →</a>
        </div>
        <div class="card">
          <div class="card-head"><h2>Recent activity</h2></div>
          <div class="feed">
            ${
              feed
                .map(
                  (f) =>
                    `<a class="feed-item text-inherit no-underline" href="${f.href}"><span class="muted">${icon(f.icon)}</span><span>${f.text}</span><span class="when">${timeAgo(f.date)}</span></a>`,
                )
                .join('') ||
              emptyState({
                compact: true,
                level: 3,
                title: 'No activity yet',
                bodyHtml:
                  'Commits, design runs and warnings appear here as they happen. Start on the <a href="#/ontology">Ontology</a> page.',
              })
            }
          </div>
        </div>
      </div>`;
}

const view: View = {
  id: 'home',
  title: 'Home',
  icon: 'house',
  render(ctx) {
    return ctx.api ? roleHome(ctx) : demoHome(ctx);
  },
  bind(root, ctx) {
    if (!ctx.api) return;
    const role = homeRole(ctx.workRole, ctx.ontology.role);
    const cards = (): CardId[] => homeLayout(ctx).cards ?? [...ROLE_CARDS[role]];
    ensureHome(ctx, needsOf(cards()));
    const ui = uiState(ctx);
    const keep = (next: CardId[] | null, focus?: string): void => {
      void keepCards(ctx, next).then(() => {
        if (focus) root.querySelector<HTMLElement>(focus)?.focus();
      });
    };
    onAll(root, '[data-home-edit]', 'click', () => {
      ui.editing = true;
      ctx.rerender();
      root.querySelector<HTMLElement>('[data-home-done]')?.focus();
    });
    onAll(root, '[data-home-done]', 'click', () => {
      ui.editing = false;
      ctx.rerender();
      root.querySelector<HTMLElement>('[data-home-edit]')?.focus();
    });
    onAll(root, '[data-card-up]', 'click', (el) => {
      const id = el.dataset.cardUp as CardId;
      keep(moveCard(cards(), id, -1), `[data-card-up="${id}"]:not(:disabled), [data-card-down="${id}"]`);
    });
    onAll(root, '[data-card-down]', 'click', (el) => {
      const id = el.dataset.cardDown as CardId;
      keep(moveCard(cards(), id, 1), `[data-card-down="${id}"]:not(:disabled), [data-card-up="${id}"]`);
    });
    onAll(root, '[data-card-remove]', 'click', (el) => {
      const id = el.dataset.cardRemove as CardId;
      const before = cards();
      keep(
        before.filter((c) => c !== id),
        '[data-card-add-form] select',
      );
      ux('task', 'home.card-removed');
      ctx.toast(`${cardOf(id)?.title ?? 'Card'} removed`, {
        type: 'success',
        action: { label: 'Undo', run: () => keep(before) },
      });
    });
    onAll(root, '[data-card-add-form]', 'submit', (form, e) => {
      e.preventDefault();
      const id = (form.querySelector('select')?.value ?? '') as CardId;
      if (!cardOf(id) || cards().includes(id)) return;
      keep([...cards(), id], `[data-card-remove="${id}"]`);
      ux('task', 'home.card-added');
    });
    onAll(root, '[data-home-reset]', 'click', () => keep(null, '[data-home-done]'));
  },
};

export default view;
