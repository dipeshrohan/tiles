import { graphHealth } from '../lib/ontology.ts';
import { MODELS } from '../lib/design.ts';
import { esc, fmt, timeAgo } from '../lib/dom.ts';
import type { WarningInfo } from '../lib/api.ts';
import { icon } from '../lib/icons.ts';
import type { Context, View } from './types.ts';
import { apiUnreachable, button, emptyState, field, loadFailed, pageHead, select, skeleton } from '../lib/ui.ts';
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
import { ensureLayout, ensureNeeds, homeLayout, keepCards, slot, SIGNALS_PAGE, WARNINGS_PAGE } from './home-data.ts';
import { machineBoard, placeWarning } from '../lib/shopfloor.ts';
import { when } from '../lib/warnings.ts';
import { placeLink } from '../lib/plant.ts';
import { onAll } from '../lib/dom.ts';
import { ux } from '../lib/analytics.ts';
import { t, tHtml, type MessageKey } from '../lib/i18n.ts';
import { time } from '../lib/format.ts';

// Home (U5.01): in local mode, the demo's hero and figures; with the Tiles API, cards set by your
// role that each answer "what needs me now?", which you can add, remove and order (Customise).

interface Ui {
  editing: boolean;
}
const uiState = (ctx: Context) => ctx.ui<Ui>('home', { editing: false });

const MAX_ROWS = 5;
const DEMO_MACHINE = 'DC-02'; // i18n-ok

// A card's figure: the number that answers it, and what it counts. `atLeast`: counted from a full
// page of a list, so there may be more (shown as 200+).
const figure = (n: number, what: string, tone: '' | 'bad' | 'warn' | 'good' = '', atLeast = false): string =>
  `<p class="home-figure ${tone}"><span class="value" data-tick>${fmt(n)}${atLeast ? '+' : ''}</span> <span>${esc(what)}</span></p>`;

const more = (n: number, href: string, what: string, atLeast = false): string =>
  n > MAX_ROWS
    ? `<p class="small"><a href="${esc(href)}">${esc(atLeast ? t('home.more', { what }) : t('home.moreN', { n: fmt(n - MAX_ROWS), what }))}</a></p>`
    : '';

const rows = (items: readonly string[]): string =>
  `<ul class="home-list">${items
    .slice(0, MAX_ROWS)
    .map((i) => `<li>${i}</li>`)
    .join('')}</ul>`;

const nothing = (title: string, body: string): string => emptyState({ compact: true, level: 3, title, body });

const warningRow = (w: WarningInfo, now: number): string =>
  `<a href="#/warnings?show=all&amp;warning=${encodeURIComponent(w.id)}">${esc(w.signal_tag)}</a><span class="small soft">${esc(
    w.ended_at === null ? t('home.stillOut') : t('home.backInRange'),
  )} · ${esc(when(w.started_at, now))}</span>`;

// Each card's body from its data; null while it loads.
function cardBody(ctx: Context, id: CardId, now: number): string | null {
  const me = ctx.ontology.userId;
  switch (id) {
    case 'my-warnings': {
      const all = slot(ctx, 'my-warnings').value;
      if (!all) return null;
      const mine = myWarnings(all, me);
      const full = all.length === WARNINGS_PAGE;
      if (!mine.length) return nothing(t('home.mine.none'), t('home.mine.noneBody'));
      return `${figure(mine.length, t('home.mine.figure', { count: mine.length }), 'bad', full)}
        ${rows(mine.map((w) => warningRow(w, now)))}${more(mine.length, '#/warnings?who=me', t('home.onWarnings'), full)}`;
    }
    case 'machines-out': {
      const all = slot(ctx, 'open-warnings').value;
      const signals = slot(ctx, 'links').value;
      if (!all || !signals) return null;
      const links = new Map(signals.flatMap((s) => (s.node_id ? [[s.tag, s.node_id] as const] : [])));
      const out = machinesOut(
        machineBoard(
          ctx.graph,
          all.map((w) => placeWarning(ctx.graph, w, links, '')),
        ),
      );
      if (!out.length) return nothing(t('home.out.none'), t('home.out.noneBody'));
      return `${figure(out.length, t('home.out.figure', { count: out.length }), 'bad')}
        ${rows(
          out.map(
            (m) =>
              `<a href="${esc(placeLink(m.id))}">${esc(m.label)}</a><span class="small soft">${esc(
                [...m.path.slice(-1), t('home.out.openWarnings', { count: m.warnings })].join(' · '),
              )}</span>`,
          ),
        )}${more(out.length, '#/shopfloor', t('home.onShopfloor'))}${
          all.length === WARNINGS_PAGE
            ? `<p class="small soft">${esc(t('home.out.newest', { n: fmt(WARNINGS_PAGE) }))}</p>`
            : ''
        }`;
    }
    case 'shift': {
      const all = slot(ctx, 'recent-warnings').value;
      if (!all) return null;
      const start = shiftStart(new Date(now));
      const s = shiftSummary(all, start);
      // A full page that doesn't reach back to the shift's start: there may be more.
      const atLeast = all.length === WARNINGS_PAGE && all.every((w) => Date.parse(w.started_at) >= start.getTime());
      const since = time(start);
      if (!s.raised.length) return nothing(t('home.shift.none', { since }), t('home.shift.noneBody'));
      return `${figure(s.waiting.length, t('home.shift.figure', { raised: `${fmt(s.raised.length)}${atLeast ? '+' : ''}`, since }), s.waiting.length ? 'bad' : 'good', atLeast)}
        <p class="small soft">${esc(t('home.shift.acknowledged', { n: fmt(s.acknowledged) }))}</p>
        ${s.waiting.length ? rows(s.waiting.map((w) => warningRow(w, now))) : ''}${more(s.waiting.length, '#/warnings?show=raised', t('home.onWarnings'), atLeast)}`;
    }
    case 'reviews': {
      const all = slot(ctx, 'reviews').value;
      if (!all) return null;
      const mine = reviewsForMe(all.list, me);
      // The menu's count is exact; the list is the newest open requests.
      const n = Math.max(all.waiting ?? 0, mine.length);
      if (!n) return nothing(t('home.reviews.none'), t('home.reviews.noneBody'));
      return `${figure(n, t('home.reviews.figure', { count: n }), 'warn')}
        ${rows(
          mine.map(
            (r) =>
              `<a href="#/reviews/${r.number}">#${r.number} ${esc(r.message || t('home.reviews.untitled'))}</a><span class="small soft">${esc(r.author)} · ${esc(when(r.created_at, now))}</span>`,
          ),
        )}${more(n, '#/reviews', t('home.onReviews'))}`;
    }
    case 'insights': {
      const all = slot(ctx, 'insights').value;
      if (!all) return null;
      if (!all.length) return nothing(t('home.insights.none'), t('home.insights.noneBody'));
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
          ? t('home.fresh.ofFirst', { n: fmt(SIGNALS_PAGE) })
          : t('home.fresh.of', { n: fmt(all.length), count: all.length });
      if (!all.length) return nothing(t('home.fresh.none'), t('home.fresh.noneBody'));
      if (!stale.length)
        return `${figure(0, t('home.fresh.stale', { counted }), 'good')}<p class="small soft">${esc(t('home.fresh.allFresh'))}</p>`;
      return `${figure(stale.length, t('home.fresh.stale', { counted }), 'warn')}
        ${rows(
          stale.map(
            (s) =>
              `<a href="#/signals?q=${encodeURIComponent(s.tag)}">${esc(s.tag)}</a><span class="small soft">${esc(s.last_at ? t('home.fresh.last', { when: when(s.last_at, now) }) : t('home.fresh.noReading'))}</span>`,
          ),
        )}${more(stale.length, '#/signals', t('home.onSignals'))}`;
    }
    case 'agents': {
      const all = slot(ctx, 'agents').value;
      if (!all) return null;
      if (!all.length) return nothing(t('home.agents.none'), t('home.agents.noneBody'));
      const problems = agentProblems(all);
      if (!problems.length) return `${figure(all.length, t('home.agents.online', { count: all.length }), 'good')}`;
      return `${figure(problems.length, t('home.agents.notOnline', { count: all.length }), 'bad')}
        ${rows(
          problems.map(
            (a) =>
              `<a href="#/settings">${esc(a.name)}</a><span class="small soft">${esc(a.status === 'offline' ? t('home.agents.offline', { when: when(a.last_seen_at ?? '', now) }) : t('home.agents.never'))}</span>`,
          ),
        )}`;
    }
    case 'quality': {
      const all = slot(ctx, 'quality').value;
      if (!all) return null;
      const problems = qualityProblems(all);
      if (!problems.length) return nothing(t('home.quality.none'), t('home.quality.noneBody'));
      return `${figure(problems.length, t('home.quality.figure', { count: problems.length }), 'warn')}
        ${rows(
          problems.map(
            (s) =>
              `<a href="#/signals?q=${encodeURIComponent(s.tag)}&amp;quality=${s.quality.badge}">${esc(s.tag)}</a><span class="small soft">${esc(s.quality.badge === 'bad' ? t('home.quality.bad') : t('home.quality.look'))}</span>`,
          ),
        )}${more(problems.length, '#/signals?quality=bad', t('home.onSignals'))}`;
    }
  }
}

const CARD_LINKS: Record<CardId, [string, MessageKey]> = {
  'my-warnings': ['#/warnings?who=me', 'home.link.warnings'],
  'machines-out': ['#/shopfloor', 'home.link.shopfloor'],
  shift: ['#/warnings', 'home.link.warnings'],
  reviews: ['#/reviews', 'home.link.reviews'],
  insights: ['#/insights', 'home.link.insights'],
  freshness: ['#/signals', 'home.link.signals'],
  agents: ['#/settings', 'home.link.settings'],
  quality: ['#/signals?quality=bad', 'home.link.signals'],
};

function cardHtml(ctx: Context, id: CardId, at: number, count: number, editing: boolean, now: number): string {
  const def = cardOf(id)!;
  const failed = def.needs.some((n) => slot(ctx, n).failed);
  const body = failed
    ? loadFailed(def.title, 3)
    : (cardBody(ctx, id, now) ?? skeleton.list(3, t('home.loadingCard', { card: def.title.toLowerCase() })));
  const [href, page] = CARD_LINKS[id];
  const controls = editing
    ? `<div class="home-card-edit row gap-1 wrap">
        ${button(t('home.moveUp'), { size: 'sm', variant: 'ghost', disabled: at === 0, attrs: { 'data-card-up': id, 'aria-label': t('home.moveUpNamed', { card: def.title }) } })}
        ${button(t('home.moveDown'), { size: 'sm', variant: 'ghost', disabled: at === count - 1, attrs: { 'data-card-down': id, 'aria-label': t('home.moveDownNamed', { card: def.title }) } })}
        ${button(t('home.remove'), { size: 'sm', variant: 'ghost', attrs: { 'data-card-remove': id, 'aria-label': t('home.removeNamed', { card: def.title }) } })}
      </div>`
    : '';
  return `<section class="card home-card" data-key="card-${id}" data-card="${id}" aria-labelledby="home-${id}">
      <div class="card-head row justify-between gap-2"><h2 id="home-${id}">${esc(def.title)}</h2><a class="small" href="${esc(href)}">${esc(t('home.openPage', { page: t(page) }))}</a></div>
      ${body}
      ${controls}
    </section>`;
}

function roleHome(ctx: Context): string {
  const site = ctx.ontology.site;
  const lead = t('home.leadShort');
  if (ctx.ontology.status === 'loading' || !site)
    return `${pageHead({ title: t('home.title'), lead })}${skeleton.card(t('home.loadingApi'))}`;
  if (ctx.ontology.status !== 'ready')
    return `${pageHead({ title: t('home.title'), lead })}${apiUnreachable(ctx.ontology.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })}`;
  const role = homeRole(ctx.workRole, ctx.ontology.role);
  const { cards: kept, loaded } = homeLayout(ctx);
  // Your cards are asked for first: until they come, nothing is fetched for the wrong ones.
  if (!loaded)
    return `${pageHead({ title: t('home.title'), lead })}<div class="home-cards">${skeleton.card(t('home.loadingHome'))}${skeleton.card()}</div>`;
  const cards = kept ?? [...ROLE_CARDS[role]];
  const editing = uiState(ctx).editing;
  const now = Date.now();
  const head = pageHead({
    title: t('home.title'),
    lead: t('home.lead', { site: site.name, kept: kept ? 'yes' : 'no', role: ROLE_LABELS[role] }),
    actionsHtml: editing
      ? button(t('home.done'), { variant: 'primary', attrs: { 'data-home-done': true } })
      : button(t('home.customise'), { attrs: { 'data-home-edit': true } }),
  });
  const absent = CARDS.filter((c) => !cards.includes(c.id));
  const edit = editing
    ? `<div class="card home-edit stack gap-2">
        ${
          absent.length
            ? `<form class="row gap-2 wrap items-end" data-card-add-form>
          ${field(
            t('home.addCard'),
            select(
              'card',
              absent.map((c) => [c.id, `${c.title}: ${c.summary}`] as const),
              absent[0]!.id,
            ),
          )}
          ${button(t('home.add'), { type: 'submit' })}
        </form>`
            : `<p class="small">${esc(t('home.allCards'))}</p>`
        }
        <p class="small soft">${kept ? `${button(t('home.useCards', { role: ROLE_LABELS[role] }), { size: 'sm', variant: 'ghost', attrs: { 'data-home-reset': true } })}` : esc(t('home.theseCards', { role: ROLE_LABELS[role] }))}</p>
      </div>`
    : '';
  const grid = cards.length
    ? `<div class="home-cards">${cards.map((id, i) => cardHtml(ctx, id, i, cards.length, editing, now)).join('')}</div>`
    : `<div class="card">${nothing(t('home.noCards'), t('home.noCardsBody'))}</div>`;
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
          note: esc(
            t('home.demo.frictionNote', {
              predicted: predicted.length,
              scored: state.scored.length,
              lead: fmt(lead, 1),
            }),
          ),
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
      text: `<b>${esc(MODELS[r.modelId]?.name ?? r.modelId)} v${esc(r.version)}</b> ${esc(t('home.demo.run'))} ${r.note ? `— ${esc(r.note)}` : ''} <span class="muted">· ${esc(r.author)}</span>`,
      href: '#/design',
    })),
  ]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 6);

  return `
      <section class="hero">
        <div>
          <div class="eyebrow">${esc(t('home.demo.eyebrow'))}</div>
          <h1 tabindex="-1">${esc(t('home.demo.heroTitle'))}</h1>
          <p>${esc(t('home.demo.heroBody'))}</p>
          <div class="row mt-4">
            <a class="btn primary" href="#/chat">${esc(t('home.demo.askCopilot'))}</a>
            <a class="btn" href="#/physics">${esc(t('home.demo.seeWarnings'))}</a>
          </div>
        </div>
        <div class="engine" aria-label="${esc(t('home.demo.howItWorks'))}">
          <div class="k">${esc(t('home.demo.howItWorks'))}</div>
          <div class="pill">${esc(t('home.demo.physicsModels'))}</div>
          <div class="op">+</div>
          <div class="pill">${esc(t('home.demo.liveData'))}</div>
          <div class="op">↓</div>
          <div class="pill">${esc(t('home.demo.answers'))}</div>
        </div>
      </section>

      <div class="grid g4 mb-4">
        <a class="card kpi bad text-inherit no-underline" href="#/physics"${friction ? '' : ' aria-busy="true"'}>
          <div class="label">${esc(t('home.demo.friction', { machine: DEMO_MACHINE }))}</div>
          ${
            friction
              ? `<div class="value">${friction.value}</div><div class="note">${friction.note}</div>`
              : `<div class="value"><span class="skeleton kpi-wait"></span><span class="sr-only">${esc(t('home.demo.working'))}</span></div><div class="note"><span class="skeleton kpi-wait wide"></span></div>`
          }
        </a>
        <a class="card kpi text-inherit no-underline" href="#/quality">
          <div class="label">${esc(t('home.demo.ngRate'))}</div>
          <div class="value">${fmt((100 * ng) / state.batches.length, 1)}%</div>
          <div class="note">${esc(t('home.demo.batches', { ng, total: state.batches.length }))}</div>
        </a>
        <a class="card kpi text-inherit no-underline ${health.score < 100 ? '' : 'good'}" href="#/ontology">
          <div class="label">${esc(t('home.demo.health'))}</div>
          <div class="value">${health.score}</div>
          <div class="note">${esc(t('home.demo.healthNote', { nodes: health.counts.nodes, edges: health.counts.edges, count: health.issues.length }))}</div>
        </a>
        <a class="card kpi text-inherit no-underline" href="#/design">
          <div class="label">${esc(t('home.demo.runsLogged'))}</div>
          <div class="value">${state.runs.length}</div>
          <div class="note">${esc(t('home.demo.models', { n: Object.keys(MODELS).length }))}</div>
        </a>
      </div>

      <div class="grid g3">
        <div class="card product">
          <span class="badge accent tag">${esc(t('home.demo.forDesign'))}</span>
          <h2>${esc(t('home.demo.designTitle'))}</h2>
          <p class="soft">${esc(t('home.demo.designBody'))}</p>
          <ul>
            <li>${esc(t('home.demo.designLibrary'))}</li>
            <li>${esc(t('home.demo.designSweeps'))}</li>
            <li>${esc(t('home.demo.designAudit'))}</li>
          </ul>
          <a href="#/design">${esc(t('home.demo.openDesign'))}</a>
        </div>
        <div class="card product">
          <span class="badge accent tag">${esc(t('home.demo.forOps'))}</span>
          <h2>${esc(t('home.demo.opsTitle'))}</h2>
          <p class="soft">${esc(t('home.demo.opsBody'))}</p>
          <ul>
            <li>${esc(t('home.demo.opsSensors'))}</li>
            <li>${esc(t('home.demo.opsCorrelation'))}</li>
            <li>${esc(t('home.demo.opsOntology'))}</li>
          </ul>
          <a href="#/quality">${esc(t('home.demo.openQuality'))}</a>
        </div>
        <div class="card">
          <div class="card-head"><h2>${esc(t('home.demo.recent'))}</h2></div>
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
                title: t('home.demo.noActivity'),
                bodyHtml: tHtml('home.demo.noActivityBody', {
                  link: `<a href="#/ontology">${esc(t('home.demo.ontology'))}</a>`,
                }),
              })
            }
          </div>
        </div>
      </div>`;
}

const view: View = {
  id: 'home',
  get title() {
    return t('home.title');
  },
  icon: 'house',
  render(ctx) {
    return ctx.api ? roleHome(ctx) : demoHome(ctx);
  },
  bind(root, ctx) {
    if (!ctx.api) return;
    const role = homeRole(ctx.workRole, ctx.ontology.role);
    const cards = (): CardId[] => homeLayout(ctx).cards ?? [...ROLE_CARDS[role]];
    ensureLayout(ctx);
    if (homeLayout(ctx).loaded) ensureNeeds(ctx, needsOf(cards()));
    const ui = uiState(ctx);
    // Shown at once (the page is drawn again before this returns), then kept by the API.
    const keep = (next: CardId[] | null, focus?: string): void => {
      void keepCards(ctx, next);
      if (focus) root.querySelector<HTMLElement>(focus)?.focus();
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
      const at = cards().indexOf(id);
      keep(
        cards().filter((c) => c !== id),
        '[data-card-add-form] select',
      );
      ux('task', 'home.card-removed');
      // Undo puts it back where it was, keeping whatever else changed since.
      ctx.toast(t('home.removed', { card: cardOf(id)?.title ?? t('home.card') }), {
        type: 'success',
        action: {
          label: t('home.undo'),
          run: () => {
            const now = cards();
            if (now.includes(id)) return;
            keep([...now.slice(0, at), id, ...now.slice(at)], `[data-card-remove="${id}"]`);
          },
        },
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
