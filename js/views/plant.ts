import { esc, fmt, onAll, bound } from '../lib/dom.ts';
import type { Coverage, CoverageGap, SignalInfo } from '../lib/api.ts';
import {
  findPlaces,
  machineSheet,
  machinesUnder,
  placeFromHash,
  placeLink,
  placesIn,
  rollUp,
  topPlaces,
  trail,
} from '../lib/plant.ts';
import { HIERARCHY } from '../lib/ontology.ts';
import type { FloorItem } from '../lib/shopfloor.ts';
import type { Graph, OntologyNode } from '../lib/types.ts';
import { when } from '../lib/warnings.ts';
import { ensureFloor, floorItems, linkedSignals, refreshFloor, STATE_LABEL } from './floor-data.ts';
import type { Context, Crumb, View } from './types.ts';
import {
  button,
  card,
  emptyState,
  linkButton,
  pageHead,
  skeleton,
  apiUnreachable,
  loadFailed,
  table,
} from '../lib/ui.ts';
import { openWarning } from './warnings.ts';
import { keyAttr } from '../lib/shortcuts.ts';
import { t, tHtml } from '../lib/i18n.ts';

// The plant navigator (T5.17): the ontology's hierarchy as places to drill into, site → workcenter
// → line or cell → machine, each with its open warnings rolled up; a machine shows what it has
// (its signals with their latest readings, controllers, processes, documents, models) and the
// machines next to it on the line. `#/plant/<node id>` opens a place.

interface Ui {
  query: string;
}

const uiState = (ctx: Context) => ctx.ui<Ui>('plant', { query: '' });

let searching = false; // the search box has the focus
let typing: ReturnType<typeof setTimeout> | undefined;

// The trail to the place the page last showed, for the breadcrumbs (worked out once, in render).
let shownTrail: Crumb[] = [];

// The coverage of the place shown (T7.01): asked once per place, again on Refresh. null: loading.
let coverage: { key: string; data: Coverage | null | 'failed' } | null = null;
const coverageKey = (ctx: Context, place: string): string => `${ctx.ontology.site?.id ?? ''}|${place}`;

async function loadCoverage(ctx: Context, place: string): Promise<void> {
  const site = ctx.ontology.site?.id;
  if (!ctx.api || !site) return;
  const key = coverageKey(ctx, place);
  coverage = { key, data: null };
  let data: Coverage | 'failed';
  try {
    data = await ctx.api.coverage(site, place);
  } catch {
    data = 'failed'; // the client showed why
  }
  if (coverage?.key === key) {
    coverage = { key, data };
    ctx.rerender();
  }
}

const GAP_LABEL: Record<CoverageGap, () => string> = {
  signal_nodes: () => t('plant.coverage.gap.signalNodes'),
  linked_tags: () => t('plant.coverage.gap.linkedTags'),
  detector: () => t('plant.coverage.gap.detector'),
  event_stream: () => t('plant.coverage.gap.eventStream'),
};

function coverageCard(ctx: Context, place: string): string {
  const shown = coverage?.key === coverageKey(ctx, place) ? coverage.data : null;
  const title = `<div class="card-head"><h2>${esc(t('plant.coverage.title'))}</h2></div>`;
  if (shown === 'failed')
    return card(`${title}${loadFailed(t('plant.coverage.title'), 3)}`, { attrs: { 'data-coverage': '' } });
  if (!shown)
    return card(`${title}${skeleton.table(3, 6, t('plant.coverage.loading'))}`, { attrs: { 'data-coverage': '' } });
  if (!shown.machines.length) return '';
  const rows = shown.machines
    .map((m) => {
      const gaps = m.missing.length
        ? m.missing.map((g) => `<span class="badge warn">${esc(GAP_LABEL[g]())}</span>`).join(' ')
        : `<span class="badge good">${esc(t('plant.coverage.complete'))}</span>`;
      const events = m.event_streams.length
        ? esc(m.event_streams.map((e) => e.tag).join(', '))
        : `<span class="soft">${esc(t('plant.coverage.noEvents', { asset: m.asset }))}</span>`;
      return `<tr data-key="${esc(m.id)}">
          <td><a href="${placeLink(m.id)}" data-place="${esc(m.id)}">${esc(m.label)}</a></td>
          <td>${esc(t('plant.coverage.signalsOf', { linked: m.signals, nodes: m.signal_nodes }))}</td>
          <td>${esc(fmt(m.detectors))}</td>
          <td>${esc(fmt(m.models))}</td>
          <td class="small">${events}</td>
          <td>${gaps}</td>
        </tr>`;
    })
    .join('');
  const s = shown.totals;
  return card(
    `${title}
      <p class="small soft" data-coverage-summary>${esc(t('plant.coverage.summary', { covered: s.covered, machines: s.machines }))}</p>
      ${table({
        headers: [
          t('plant.coverage.machine'),
          t('plant.coverage.signals'),
          t('plant.coverage.detectors'),
          t('plant.coverage.models'),
          t('plant.coverage.events'),
          t('plant.coverage.missing'),
        ],
        rowsHtml: rows,
      })}
      <p class="small soft">${esc(t('plant.coverage.hint'))}</p>`,
    { attrs: { 'data-coverage': '' } },
  );
}

const badge = (state: FloorItem['state'], count: number): string => {
  if (!count) return `<span class="badge good">${esc(t('plant.ok'))}</span>`;
  const [cls, label] = STATE_LABEL[state];
  return `<span class="badge ${cls}">${esc(t('plant.badge', { count, state: label.toLowerCase() }))}</span>`;
};

function placeCard(graph: Graph, node: OntologyNode, items: FloorItem[] | null): string {
  const under = machinesUnder(graph, node.id);
  const machines = under.length;
  const what =
    node.type === 'Machine'
      ? 'Machine'
      : `${node.type} · ${machines ? t('plant.machines', { count: machines }) : t('plant.noMachines')}`;
  const { state, warnings } = items ? rollUp(graph, items, node.id, under) : { state: 'ok' as const, warnings: [] };
  return `<a class="place-card s-${items ? state : 'none'}" href="${placeLink(node.id)}" data-place="${esc(node.id)}">
      <span class="small soft">${esc(what)}</span>
      <b>${esc(node.label)}</b>
      ${items ? badge(state, warnings.length) : ''}
    </a>`;
}

function warningsCard(items: FloorItem[], now: number, onMachine = false): string {
  if (!items.length) return '';
  const rows = items
    .map((i) => {
      const [cls, label] = STATE_LABEL[i.state];
      const about = [
        onMachine ? '' : esc(i.machine),
        i.startedAt ? esc(when(i.startedAt, now)) : '',
        i.assignee ? esc(t('plant.hasIt', { name: i.assignee })) : '',
      ].filter(Boolean);
      return `<li class="plant-warning">
          <span><span class="badge ${cls}">${label}</span> <b class="mono">${esc(i.tag)}</b> <span class="small soft">${about.join(' · ')}</span></span>
          ${i.id.startsWith('demo-') ? '' : `<button class="btn sm" data-open-warning="${esc(i.id)}">${esc(t('plant.details'))}</button>`}
        </li>`;
    })
    .join('');
  return `<div class="card"><div class="card-head"><h2>${esc(t('plant.openWarnings'))}</h2><a class="btn sm" href="#/shopfloor">${esc(t('plant.shopfloor'))}</a></div><ul class="plant-list">${rows}</ul></div>`;
}

const reading = (s: SignalInfo | undefined, now: number): string => {
  if (!s || s.last_value === null || !s.last_at) return '<span class="soft">—</span>';
  const v =
    typeof s.last_value === 'number' ? fmt(s.last_value, Math.abs(s.last_value) < 10 ? 2 : 1) : String(s.last_value);
  return `${esc(v)}${s.unit ? ` ${esc(s.unit)}` : ''} <span class="small soft">${esc(when(s.last_at, now))}</span>`;
};

function signalsCard(ctx: Context, signals: OntologyNode[], now: number): string {
  if (!signals.length) return '';
  const catalogue = linkedSignals(ctx);
  const byNode = new Map(catalogue.flatMap((s) => (s.node_id ? [[s.node_id, s] as const] : [])));
  const shown = signals.map((n) => {
    const own = n.props['tag'];
    const s = byNode.get(n.id); // only a tag linked to this node: its own `tag` may be linked elsewhere
    const unit = n.props['unit'];
    return { n, s, tag: s?.tag ?? (typeof own === 'string' ? own : ''), unit: typeof unit === 'string' ? unit : '' };
  });
  const tags = shown.some((r) => r.tag); // no column of blanks
  const rows = shown
    .map(
      ({ n, s, tag, unit }) => `<tr>
          <td>${esc(n.label)}</td>
          ${tags ? `<td class="mono small">${esc(tag)}</td>` : ''}
          <td>${ctx.api ? reading(s, now) : esc(unit)}</td>
          <td class="no-print">${s ? `<a class="btn sm" href="#/explorer?signal=${encodeURIComponent(s.id)}">${esc(t('plant.plot'))}</a>` : ''}</td>
        </tr>`,
    )
    .join('');
  const head = ctx.api ? t('plant.latestReading') : t('plant.unit');
  return `<div class="card"><div class="card-head"><h2>${esc(t('plant.signals'))}</h2></div>
      <div class="table-wrap"><table><thead><tr><th>${esc(t('plant.signal'))}</th>${tags ? `<th>${esc(t('plant.tag'))}</th>` : ''}<th>${esc(head)}</th><th class="no-print"><span class="sr-only">${esc(t('plant.plot'))}</span></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${ctx.api ? `<p class="small soft">${esc(t('plant.linkHint'))}</p>` : ''}
    </div>`;
}

const list = (title: string, entries: string[]): string =>
  entries.length
    ? `<div class="card"><div class="card-head"><h2>${esc(title)}</h2></div><ul class="plant-list">${entries.join('')}</ul></div>`
    : '';

const item = (n: OntologyNode, extra = ''): string => `<li><span>${esc(n.label)}${extra}</span></li>`;

const placeItem = (n: OntologyNode): string =>
  HIERARCHY.includes(n.type)
    ? `<li><a href="${placeLink(n.id)}">${esc(n.label)}</a> <span class="small soft">${esc(n.type)}</span></li>`
    : item(n, ` <span class="small soft">${esc(n.type)}</span>`);

function machinePage(ctx: Context, graph: Graph, node: OntologyNode, items: FloorItem[] | null, now: number): string {
  const sheet = machineSheet(graph, node.id);
  const props = Object.entries(node.props);
  const facts = props.length
    ? `<dl class="plant-facts">${props.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
    : '';
  const warnings = items ? rollUp(graph, items, node.id).warnings : [];
  // Each signal once, though two PLCs emit it or the machine also contains it.
  const signals = [
    ...new Map([...sheet.plcs.flatMap((p) => p.signals), ...sheet.signals].map((n) => [n.id, n])).values(),
  ];
  const prop = (n: OntologyNode, key: string) => {
    const v = n.props[key];
    return v === undefined ? '' : ` <span class="small soft">${esc(v)}</span>`;
  };
  return `${warningsCard(warnings, now, true)}
    <div class="plant-sheet">
      ${facts ? `<div class="card"><div class="card-head"><h2>${esc(t('plant.about'))}</h2></div>${facts}</div>` : ''}
      ${signalsCard(ctx, signals, now)}
      ${list(
        t('plant.controlledBy'),
        sheet.plcs.map((p) =>
          item(p.plc, `${prop(p.plc, 'protocol')} · ${esc(t('plant.plcSignals', { count: p.signals.length }))}`),
        ),
      )}
      ${list(
        t('plant.runs'),
        sheet.processes.map((p) =>
          item(
            p.process,
            p.materials.length
              ? ` <span class="small soft">${esc(t('plant.consumes', { materials: p.materials.map((m) => m.label).join(', ') }))}</span>`
              : '',
          ),
        ),
      )}
      ${list(
        t('plant.fedBy'),
        sheet.feedsFrom.map((n) => placeItem(n)),
      )}
      ${list(
        t('plant.feeds'),
        sheet.feedsTo.map((n) => placeItem(n)),
      )}
      ${list(
        t('plant.watchedBy'),
        sheet.models.map((n) => item(n, prop(n, 'version'))),
      )}
      ${list(
        t('plant.documents'),
        sheet.documents.map((n) => item(n)),
      )}
      ${list(
        t('plant.parts'),
        sheet.parts.map((n) => placeItem(n)),
      )}
    </div>`;
}

function placePage(ctx: Context, graph: Graph, id: string, items: FloorItem[] | null, now: number): string {
  const inside = placesIn(graph, id);
  const warnings = items ? rollUp(graph, items, id).warnings : [];
  const cards = inside.length
    ? `<div class="place-grid">${inside.map((c) => placeCard(graph, graph.nodes[c] as OntologyNode, items)).join('')}</div>`
    : card(
        emptyState({
          illustration: 'launch',
          compact: true,
          title: t('plant.emptyTitle'),
          body: t('plant.emptyBody'),
          action: linkButton(t('plant.openOntology'), '#/ontology', { size: 'sm', icon: 'network' }),
        }),
      );
  return `${cards}${warningsCard(warnings, now)}${ctx.api && inside.length ? coverageCard(ctx, id) : ''}`;
}

function searchResults(graph: Graph, query: string): string {
  if (!query.trim()) return '';
  const hits = findPlaces(graph, query);
  const rows = hits
    .map(
      (h) =>
        `<li><a href="${placeLink(h.id)}" data-place="${esc(h.id)}">${esc(h.label)}</a> <span class="small soft">${esc(h.type)}${h.path.length ? ` · ${esc(h.path.join(' › '))}` : ''}</span></li>`,
    )
    .join('');
  return `<div class="card" data-plant-results>${
    rows
      ? `<ul class="plant-list">${rows}</ul>`
      : emptyState({
          illustration: 'search',
          compact: true,
          title: t('plant.noMatch', { query: query.trim() }),
          body: t('plant.noMatchBody'),
        })
  }</div>`;
}

// The place the address names, or the only top place.
function shownPlace(ctx: Context): string | null {
  const tops = topPlaces(ctx.graph);
  return placeFromHash(location.hash) ?? (tops.length === 1 ? (tops[0] ?? null) : null);
}

const view: View = {
  id: 'plant',
  get title() {
    return t('plant.title');
  },
  icon: 'factory',
  crumbs: () => shownTrail,
  render(ctx) {
    const ui = uiState(ctx);
    const graph = ctx.graph; // made afresh at each read: once for the whole page
    const tops = topPlaces(graph);
    // The place the URL names; with one site, the page opens on it.
    const asked = placeFromHash(location.hash);
    const id = asked ?? (tops.length === 1 ? (tops[0] ?? null) : null);
    const node = id ? graph.nodes[id] : undefined;
    shownTrail = node ? trail(graph, node.id).map((n) => ({ label: n.label, href: placeLink(n.id) })) : [];
    const title = node?.label ?? t('plant.title');
    const kind = node ? node.type : t('plant.hierarchy');
    const search = `<form class="plant-search" data-plant-search role="search">
        <input name="q" type="search" placeholder="${esc(t('plant.searchPlaceholder'))}" aria-label="${esc(t('plant.searchLabel'))}" value="${esc(ui.query)}" autocomplete="off"${keyAttr('/')}>
      </form>`;
    const head = pageHead({
      eyebrow: t('plant.eyebrow', { kind }),
      title,
      actionsHtml: `<div class="row gap-2">${search}${ctx.api ? button(t('plant.refresh'), { attrs: { 'data-plant-refresh': true } }) : ''}</div>`,
    });
    if (ctx.api && ctx.ontology.status === 'loading')
      return `${head}<div class="card">${skeleton.card(t('plant.loading'))}</div>`;
    if (ctx.api && ctx.ontology.status !== 'ready')
      return `${head}${apiUnreachable(ctx.ontology.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })}`;
    const results = searchResults(graph, ui.query);
    if (!tops.length)
      return `${head}${results}<div class="card"><p>${tHtml('plant.noPlaces', { link: `<a href="#/ontology">${esc(t('plant.ontology'))}</a>` })}</p></div>`;
    const items = floorItems(ctx, graph);
    const now = Date.now();
    if (asked && !node)
      return `${head}${results}<div class="card" role="alert"><p>${tHtml('plant.gone', { link: `<a href="#/plant">${esc(t('plant.startFromTop'))}</a>` })}</p></div>`;
    if (!node) {
      const cards = tops.map((top) => placeCard(graph, graph.nodes[top] as OntologyNode, items)).join('');
      return `${head}${results}<div class="place-grid">${cards}</div>`;
    }
    const body =
      node.type === 'Machine' ? machinePage(ctx, graph, node, items, now) : placePage(ctx, graph, node.id, items, now);
    return `${head}${results}${body}`;
  },
  bind(root, ctx) {
    const ui = uiState(ctx);
    ensureFloor(ctx);
    const form = root.querySelector<HTMLFormElement>('[data-plant-search]');
    const input = form?.querySelector<HTMLInputElement>('input');
    // The page renders again when the warnings or readings arrive: typing carries on in the new box.
    if (input && searching) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    input?.addEventListener('focus', () => (searching = true), { signal: bound() });
    // A box taken away by a render keeps the search going; leaving it for elsewhere ends it.
    // (A render blurs the box while still taking it away: whether it went is known just after.)
    input?.addEventListener(
      'blur',
      () =>
        queueMicrotask(() => {
          if (input.isConnected) searching = false;
        }),
      { signal: bound() },
    );
    input?.addEventListener(
      'input',
      () => {
        ui.query = input.value; // kept at once, so any render shows what is typed
        clearTimeout(typing);
        typing = setTimeout(() => ctx.rerender(), 200);
      },
      { signal: bound() },
    );
    // Enter goes to the best match, without waiting for the list.
    form?.addEventListener(
      'submit',
      (e) => {
        e.preventDefault();
        clearTimeout(typing);
        const best = findPlaces(ctx.graph, input?.value ?? '', 1)[0];
        if (!best) return ctx.rerender();
        ui.query = '';
        searching = false;
        const to = placeLink(best.id);
        if (location.hash === to)
          ctx.rerender(); // already there: no hashchange to render it
        else location.hash = to;
      },
      { signal: bound() },
    );
    // Going to a place leaves the search behind.
    onAll(root, '[data-place]', 'click', () => {
      ui.query = '';
    });
    // The coverage of a place (not a machine), asked once per place.
    const place = root.querySelector<HTMLElement>('[data-coverage]') ? shownPlace(ctx) : null;
    if (place && coverage?.key !== coverageKey(ctx, place)) void loadCoverage(ctx, place);
    onAll(root, '[data-plant-refresh]', 'click', () => {
      refreshFloor(ctx);
      if (place) void loadCoverage(ctx, place);
    });
    onAll(root, '[data-open-warning]', 'click', (el) => openWarning(ctx, el.dataset.openWarning ?? ''));
  },
};

export default view;
