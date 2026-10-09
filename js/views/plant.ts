import { esc, fmt, onAll } from '../lib/dom.ts';
import type { SignalInfo } from '../lib/api.ts';
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
import type { Context, View } from './types.ts';
import { openWarning } from './warnings.ts';

// The plant navigator (T5.17): the ontology's hierarchy as places to drill into, site → workcenter
// → line or cell → machine, each with its open warnings rolled up; a machine shows what it has
// (its signals with their latest readings, controllers, processes, documents, models) and the
// machines next to it on the line. `#/plant/<node id>` opens a place.

interface Ui {
  query: string;
}

const uiState = (ctx: Context) => ctx.ui<Ui>('plant', { query: '' });

const crumbs = (graph: Graph, id: string | null): string => {
  const path = id ? trail(graph, id) : [];
  const links = [
    `<a href="#/plant">Plant</a>`,
    ...path.map((n, i) =>
      i === path.length - 1
        ? `<b aria-current="page">${esc(n.label)}</b>`
        : `<a href="${placeLink(n.id)}">${esc(n.label)}</a>`,
    ),
  ];
  return `<nav class="plant-trail" aria-label="Where you are">${links.join('<span aria-hidden="true">›</span>')}</nav>`;
};

const badge = (state: FloorItem['state'], count: number): string => {
  if (!count) return '<span class="badge good">OK</span>';
  const [cls, label] = STATE_LABEL[state];
  return `<span class="badge ${cls}">${count} warning${count === 1 ? '' : 's'}: ${label.toLowerCase()}</span>`;
};

function placeCard(graph: Graph, node: OntologyNode, items: FloorItem[] | null): string {
  const machines = machinesUnder(graph, node.id).length;
  const what =
    node.type === 'Machine'
      ? 'Machine'
      : `${node.type} · ${machines ? `${machines} machine${machines === 1 ? '' : 's'}` : 'no machines'}`;
  const { state, warnings } = items ? rollUp(graph, items, node.id) : { state: 'ok' as const, warnings: [] };
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
        i.assignee ? `${esc(i.assignee)} has it` : '',
      ].filter(Boolean);
      return `<li class="plant-warning">
          <span><span class="badge ${cls}">${label}</span> <b class="mono">${esc(i.tag)}</b> <span class="small soft">${about.join(' · ')}</span></span>
          ${i.id.startsWith('demo-') ? '' : `<button class="btn sm" data-open-warning="${esc(i.id)}">Details</button>`}
        </li>`;
    })
    .join('');
  return `<div class="card"><div class="card-head"><h2>Open warnings</h2><a class="btn sm" href="#/shopfloor">Shopfloor</a></div><ul class="plant-list">${rows}</ul></div>`;
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
  const byTag = new Map(catalogue.map((s) => [s.tag, s] as const));
  const shown = signals.map((n) => {
    const own = n.props['tag'];
    const s = byNode.get(n.id) ?? (typeof own === 'string' ? byTag.get(own) : undefined);
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
          <td>${s ? `<a class="btn sm" href="#/explorer?signal=${encodeURIComponent(s.id)}">Plot</a>` : ''}</td>
        </tr>`,
    )
    .join('');
  const head = ctx.api ? 'Latest reading' : 'Unit';
  return `<div class="card"><div class="card-head"><h2>Signals</h2></div>
      <div class="table-wrap"><table><thead><tr><th>Signal</th>${tags ? '<th>Tag</th>' : ''}<th>${head}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${ctx.api ? '<p class="small soft">A signal shows its reading once a tag is linked to it on the Signals page.</p>' : ''}
    </div>`;
}

const list = (title: string, entries: string[]): string =>
  entries.length
    ? `<div class="card"><div class="card-head"><h2>${title}</h2></div><ul class="plant-list">${entries.join('')}</ul></div>`
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
  const signals = [...sheet.plcs.flatMap((p) => p.signals), ...sheet.signals];
  const prop = (n: OntologyNode, key: string) => {
    const v = n.props[key];
    return v === undefined ? '' : ` <span class="small soft">${esc(v)}</span>`;
  };
  return `${warningsCard(warnings, now, true)}
    <div class="plant-sheet">
      ${facts ? `<div class="card"><div class="card-head"><h2>About</h2></div>${facts}</div>` : ''}
      ${signalsCard(ctx, signals, now)}
      ${list(
        'Controlled by',
        sheet.plcs.map((p) =>
          item(p.plc, `${prop(p.plc, 'protocol')} · ${p.signals.length} signal${p.signals.length === 1 ? '' : 's'}`),
        ),
      )}
      ${list(
        'Runs',
        sheet.processes.map((p) =>
          item(
            p.process,
            p.materials.length
              ? ` <span class="small soft">consumes ${esc(p.materials.map((m) => m.label).join(', '))}</span>`
              : '',
          ),
        ),
      )}
      ${list(
        'Fed by',
        sheet.feedsFrom.map((n) => placeItem(n)),
      )}
      ${list(
        'Feeds',
        sheet.feedsTo.map((n) => placeItem(n)),
      )}
      ${list(
        'Watched by models',
        sheet.models.map((n) => item(n, prop(n, 'version'))),
      )}
      ${list(
        'Documents',
        sheet.documents.map((n) => item(n)),
      )}
      ${list(
        'Parts',
        sheet.parts.map((n) => placeItem(n)),
      )}
    </div>`;
}

function placePage(graph: Graph, id: string, items: FloorItem[] | null, now: number): string {
  const inside = placesIn(graph, id);
  const warnings = items ? rollUp(graph, items, id).warnings : [];
  const cards = inside.length
    ? `<div class="place-grid">${inside.map((c) => placeCard(graph, graph.nodes[c] as OntologyNode, items)).join('')}</div>`
    : '<div class="card"><p>Nothing is inside this place yet. Add lines and machines under it on the Ontology page.</p></div>';
  return `${cards}${warningsCard(warnings, now)}`;
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
  return `<div class="card" data-plant-results>${rows ? `<ul class="plant-list">${rows}</ul>` : `<p class="small">No place is called “${esc(query)}”.</p>`}</div>`;
}

const view: View = {
  id: 'plant',
  title: 'Plant',
  icon: '⌗',
  render(ctx) {
    const ui = uiState(ctx);
    const graph = ctx.graph; // made afresh at each read: once for the whole page
    const tops = topPlaces(graph);
    // One site: the page opens on it.
    const asked = placeFromHash(location.hash);
    const id = asked ?? (tops.length === 1 ? (tops[0] ?? null) : null);
    const node = id ? graph.nodes[id] : undefined;
    const title = node?.label ?? 'Plant';
    const kind = node ? node.type : 'Site → line → machine';
    const search = `<form class="plant-search" data-plant-search role="search">
        <input name="q" type="search" placeholder="Find a line or machine" aria-label="Find a place" value="${esc(ui.query)}" autocomplete="off">
      </form>`;
    const head = `<div class="page-head"><div><div class="eyebrow">Operations · ${esc(kind)}</div><h1>${esc(title)}</h1>
        ${crumbs(graph, node ? node.id : null)}</div>
        <div class="row" style="gap:8px">${search}${ctx.api ? '<button class="btn" data-plant-refresh>Refresh</button>' : ''}</div></div>`;
    if (ctx.api && ctx.ontology.status === 'loading')
      return `${head}<div class="card">Loading from the Tiles API…</div>`;
    if (ctx.api && ctx.ontology.status !== 'ready')
      return `${head}<div class="card" role="alert">Can't reach the Tiles API: ${esc(ctx.ontology.error)}</div>`;
    const results = searchResults(graph, ui.query);
    if (!tops.length)
      return `${head}${results}<div class="card"><p>The ontology has no sites, lines or machines yet. Build the hierarchy on the <a href="#/ontology">Ontology</a> page: a site contains workcenters, which contain lines and cells, which contain machines.</p></div>`;
    const items = floorItems(ctx, graph);
    const now = Date.now();
    if (asked && !node)
      return `${head}${results}<div class="card" role="alert"><p>This place isn’t in the ontology any more. <a href="#/plant">Start from the top</a>.</p></div>`;
    if (!node) {
      const cards = tops.map((t) => placeCard(graph, graph.nodes[t] as OntologyNode, items)).join('');
      return `${head}${results}<div class="place-grid">${cards}</div>`;
    }
    const body =
      node.type === 'Machine' ? machinePage(ctx, graph, node, items, now) : placePage(graph, node.id, items, now);
    return `${head}${results}${body}`;
  },
  bind(root, ctx) {
    const ui = uiState(ctx);
    ensureFloor(ctx);
    const form = root.querySelector<HTMLFormElement>('[data-plant-search]');
    const input = form?.querySelector<HTMLInputElement>('input');
    let typing: ReturnType<typeof setTimeout> | undefined;
    input?.addEventListener('input', () => {
      clearTimeout(typing);
      typing = setTimeout(() => {
        ui.query = input.value;
        ctx.rerender();
        const again = document.querySelector<HTMLInputElement>('[data-plant-search] input');
        again?.focus();
        again?.setSelectionRange(again.value.length, again.value.length);
      }, 200);
    });
    // Enter goes to the best match, without waiting for the list.
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      clearTimeout(typing);
      const best = findPlaces(ctx.graph, input?.value ?? '', 1)[0];
      ui.query = best ? '' : (input?.value ?? '');
      if (best) location.hash = placeLink(best.id);
      else ctx.rerender();
    });
    // Going to a place leaves the search behind.
    onAll(root, '[data-place]', 'click', () => {
      ui.query = '';
    });
    onAll(root, '[data-plant-refresh]', 'click', () => refreshFloor(ctx));
    onAll(root, '[data-open-warning]', 'click', (el) => openWarning(ctx, el.dataset.openWarning ?? ''));
  },
};

export default view;
