import { ux } from '../lib/analytics.ts';
import { NODE_TYPES, graphHealth, neighbors, pathTo, diffStats } from '../lib/ontology.ts';
import {
  BOX,
  MAX_FIT_SCALE,
  canvasHeight,
  centerOn,
  collapsible,
  fitView,
  focusView,
  inBox,
  likelyRel,
  minimapPath,
  stepFrom,
  type Direction,
  foldedCounts,
  hiddenByCollapse,
  hiddenUnder,
  hierarchy,
  layout,
  panBy,
  revealPath,
  searchNodes,
  zoomAt,
  type Hierarchy,
  type Layout,
  type View as ViewBox,
} from '../lib/canvas.ts';
import { historyOps, safeWorkingGraph, sameOps, type RemoteStore } from '../lib/ontology-store.ts';
import { seedOntology } from '../lib/data.ts';
import {
  download,
  esc,
  fmt,
  field,
  need,
  onAll,
  onNavigate,
  onSubmit,
  routeOf,
  scrollBehavior,
  timeAgo,
  bound,
} from '../lib/dom.ts';
import { describeChanges } from '../lib/review.ts';
import type { OntologyImport } from '../lib/api.ts';
import type { DiffStats, Graph, HealthIssue, HealthReport, NodeType, Op } from '../lib/types.ts';
import type { Context, View } from './types.ts';
import { pageHead } from '../lib/ui.ts';
import { keyAttr, typing } from '../lib/shortcuts.ts';
import { t, tHtml, type MessageKey } from '../lib/i18n.ts';

interface OntologyUi {
  tab: 'canvas' | 'history' | 'health';
  selected: string | null; // the node inspected, or last picked of several
  selection: string[]; // several picked (shift-click, a box): with `selected`, the nodes selected
  linking: { from: string; to: string } | null; // a drag from one node to another: the relationship to add
  hidden: NodeType[];
  collapsed: string[] | null; // null: automatic (signals folded away on large ontologies)
  view: ViewBox | null; // the part of the canvas shown; null: all of it
  viewFor: string; // the drawing's size `view` was set on: another size (a fold, a new node) drops it
  search: string;
  match: number; // the search result last gone to
}

const uiState = (ctx: Context) =>
  ctx.ui<OntologyUi>('ontology', {
    tab: 'canvas',
    selected: null,
    selection: [],
    linking: null,
    hidden: [],
    collapsed: null,
    view: null,
    viewFor: '',
    search: '',
    match: -1,
  });

// Opens the History tab next time the page shows (the Reviews page links to a commit).
export function showHistory(ctx: Context): void {
  uiState(ctx).tab = 'history';
}

// The nodes selected (U5.05): those picked, and the one inspected, that are still in the graph.
function selectedIds(ui: OntologyUi, graph: Graph): string[] {
  const all = new Set(ui.selection);
  if (ui.selected) all.add(ui.selected);
  return [...all].filter((id) => graph.nodes[id]);
}
function selectOnly(ui: OntologyUi, id: string | null): void {
  ui.selected = id;
  ui.selection = [];
  ui.linking = null;
}
// Shift-click: adds a node to the selection, or takes it out.
function toggleSelected(ui: OntologyUi, graph: Graph, id: string): void {
  const all = new Set(selectedIds(ui, graph));
  if (all.has(id)) all.delete(id);
  else all.add(id);
  ui.selection = [...all];
  ui.selected = all.has(id) ? id : (ui.selection.at(-1) ?? null);
  ui.linking = null;
}

// Undo and redo of staged ops (U5.05), for the site they were staged on: each step is what one
// action staged (a node and its relationship are one step). Steps from before a reload are gone:
// undo then takes back one op at a time.
let undoSteps: Op[][] = [];
let redoSteps: Op[][] = [];
let redoAt = -1; // how many ops were staged after the last undo or redo: more or fewer since drops redo
let stepsFor = '';
let undoNote = ''; // what the last undo or redo did, for screen readers
function stepsOf(ctx: Context): void {
  const where = ctx.ontology.site?.id ?? 'local';
  if (where === stepsFor) return;
  stepsFor = where;
  undoSteps = [];
  redoSteps = [];
}
let undoing = false; // one undo or redo at a time, across renders: a key held down waits for each
// The most one step stages (the API's batch limit): a larger selection is changed in parts.
export const MOST_OPS = 2000;
// A property value as typed: a number when it reads as one.
const parseValue = (raw: string): string | number => (raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw);
// A relationship's id, unique in the graph.
function edgeId(graph: Graph, from: string, rel: string, to: string): string {
  let id = `${from}-${rel}-${to}`;
  for (let k = 2; graph.edges[id]; k++) id = `${from}-${rel}-${to}-${k}`;
  return id;
}
// What undo takes back: the last step while the staged ops still end with it, else the last op.
function undoable(ctx: Context): Op[] {
  stepsOf(ctx);
  const staged = ctx.state.repo.staged;
  const top = undoSteps.at(-1);
  if (top && top.length <= staged.length && sameOps(staged.slice(-top.length), top)) return top;
  return staged.slice(-1);
}
function canRedo(ctx: Context): boolean {
  stepsOf(ctx);
  return redoSteps.length > 0 && ctx.state.repo.staged.length === redoAt;
}
const changes = (n: number): string => t('ontology.changes', { count: n });

const RELS = ['contains', 'runs', 'consumes', 'controlledBy', 'emits', 'describes', 'reads', 'monitors', 'feeds'];

// Canvas at scale (T2.14): what folding a level does, and when it happens by itself.
const LEVELS: [string, MessageKey, NodeType[]][] = [
  ['', 'ontology.fold.all', []],
  ['PLC', 'ontology.fold.plc', ['PLC']],
  ['Machine', 'ontology.fold.machines', ['Machine']],
  ['Line', 'ontology.fold.lines', ['Line', 'Cell']],
  ['Workcenter', 'ontology.fold.workcenters', ['Workcenter']],
];
const AUTO_FOLD_ABOVE = 400; // nodes: larger ontologies open with signals folded into their PLC

function levelNodes(graph: Graph, h: Hierarchy, types: NodeType[]): string[] {
  return collapsible(h).filter((id) => {
    const n = graph.nodes[id];
    return n !== undefined && types.includes(n.type);
  });
}

function collapsedSet(graph: Graph, h: Hierarchy, ui: OntologyUi): Set<string> {
  if (ui.collapsed) return new Set(ui.collapsed.filter((id) => graph.nodes[id]));
  return new Set(Object.keys(graph.nodes).length > AUTO_FOLD_ABOVE ? levelNodes(graph, h, ['PLC']) : []);
}

// The last canvas drawn, for its handlers (zoom limits, where a node is).
let drawn: (Layout & { graph: Graph }) | null = null;
let centerAfterRender: string | null = null; // a search result to bring into view once drawn
let focusAfterRender = false; // focus selection, once the folds hiding some of it are opened
let canvasTall = ''; // the canvas's height, last worked out

const short = (s: string, n = 19): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function describeOp(op: Op, graph: Graph): string {
  const label = (id: string) => graph.nodes[id]?.label ?? id;
  switch (op.kind) {
    case 'addNode':
      return `+ ${op.node.type} “${op.node.label}”`;
    case 'removeNode':
      return t('ontology.op.removeNode', { id: op.id });
    case 'addEdge':
      return `+ ${label(op.edge.from)} —${op.edge.rel}→ ${label(op.edge.to)}`;
    case 'removeEdge':
      return t('ontology.op.removeEdge', { id: op.id });
    case 'setProp':
      return op.value === undefined ? `− ${label(op.id)}.${op.key}` : `~ ${label(op.id)}.${op.key} = ${op.value}`;
  }
}

function statBadges(s: DiffStats): string {
  const b = (n: number, what: string) =>
    n
      ? `<span class="badge"><span class="${n > 0 ? 'plus' : 'minus'}">${n > 0 ? '+' : '−'}${Math.abs(n)}</span> ${esc(what)}</span>`
      : '';
  return (
    b(s.nodes, t('ontology.stat.node')) + b(s.edges, t('ontology.stat.edge')) + b(s.props, t('ontology.stat.prop'))
  );
}

// Worked out once per graph (U3.07): the page's graph is made again only when the ontology changes,
// never changed in place, and a fold or a selection draws the page again with the same one.
const hierarchies = new WeakMap<Graph, ReturnType<typeof hierarchy>>();
function hierarchyOf(graph: Graph): ReturnType<typeof hierarchy> {
  let h = hierarchies.get(graph);
  if (!h) hierarchies.set(graph, (h = hierarchy(graph)));
  return h;
}
const optionLists = new WeakMap<Graph, string>();
// A number per graph: a node picker drawn for another graph is drawn again (its options go).
const versions = new WeakMap<Graph, number>();
let lastVersion = 0;
function versionOf(graph: Graph): number {
  let v = versions.get(graph);
  if (v === undefined) versions.set(graph, (v = ++lastVersion));
  return v;
}
// A node picker gets its options as it is first used (U3.07): 2,000 options drawn into the page
// made every redraw of a large plant slower, the options unchanged.
function fillNodeOptions(select: HTMLSelectElement, graph: Graph): void {
  if (select.options.length > 1) return;
  select.insertAdjacentHTML('beforeend', nodeOptions(graph));
  // Not the node itself (linking a node to itself).
  const except = select.dataset.except;
  if (except) [...select.options].find((o) => o.value === except)?.remove();
}
// Every node as an option, by label: 2,000 of them in a large plant.
function nodeOptions(graph: Graph): string {
  let html = optionLists.get(graph);
  if (html === undefined) {
    html = Object.values(graph.nodes)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((n) => `<option value="${esc(n.id)}">${esc(n.label)}</option>`)
      .join('');
    optionLists.set(graph, html);
  }
  return html;
}

function canvas(ctx: Context, graph: Graph, health: HealthReport, ui: OntologyUi): string {
  const hidden = new Set(ui.hidden);
  const h = hierarchyOf(graph);
  const collapsed = collapsedSet(graph, h, ui);
  const folded = hiddenByCollapse(graph, collapsed, h);
  const show = (id: string) => {
    const n = graph.nodes[id];
    return n !== undefined && !hidden.has(n.type) && !folded.has(id);
  };
  const placed = layout(graph, show, h);
  drawn = { ...placed, graph };
  const { pos, width, height } = placed;
  // A view of another drawing (nodes folded, opened or added since) would show the wrong part.
  const size = `${width}x${height}`;
  if (ui.viewFor !== size) ui.view = null;
  ui.viewFor = size;
  const counts = foldedCounts(collapsed, folded, h);
  const issueIds = new Set(health.issues.filter((i) => i.level !== 'info').map((i) => i.ref));
  const stagedIds = new Set(ctx.state.repo.staged.flatMap(touchedIds));
  const matches = new Set(searchNodes(graph, ui.search));
  const picked = new Set(selectedIds(ui, graph));
  const editor = ctx.ontology.role !== 'viewer';
  const edges = Object.values(graph.edges)
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return '';
      const fwd = b.x >= a.x;
      const x1 = fwd ? a.x + BOX.w : a.x;
      const x2 = fwd ? b.x : b.x + BOX.w;
      const y1 = a.y + BOX.h / 2;
      const y2 = b.y + BOX.h / 2;
      const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (fwd ? 1 : -1);
      const hl = picked.has(e.from) || picked.has(e.to);
      return `<path class="edge ${hl ? 'hl' : ''}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"><title>${esc(graph.nodes[e.from]?.label)} —${esc(e.rel)}→ ${esc(graph.nodes[e.to]?.label)}</title></path>`;
    })
    .join('');
  const nodes = [...pos.entries()]
    .map(([id, p]) => {
      const n = graph.nodes[id];
      if (!n) return '';
      const fold = counts.get(id) ?? 0; // the hidden nodes below it
      const cls = [
        'node',
        picked.has(id) && 'sel',
        issueIds.has(id) && 'issue',
        stagedIds.has(id) && 'staged',
        matches.has(id) && 'match',
        fold && 'folded',
      ]
        .filter(Boolean)
        .join(' ');
      return `<g class="${cls}" data-node="${esc(id)}" data-key="node-${esc(id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(t('ontology.node.label', { type: n.type, label: n.label, count: fold }))}">
          <rect width="${BOX.w}" height="${BOX.h}" rx="6"/>
          <rect width="5" height="${BOX.h}" rx="2" fill="${NODE_TYPES[n.type].color}" stroke="none"/>
          <text x="13" y="18">${esc(short(n.label, fold ? 15 : 19))}</text>${fold ? `<text class="fold" x="${BOX.w - 7}" y="18" text-anchor="end">+${fold}</text>` : ''}${
            editor && id === ui.selected && picked.size === 1
              ? `<circle class="handle" data-handle cx="${BOX.w}" cy="${BOX.h / 2}" r="6"><title>${esc(t('ontology.node.handle'))}</title></circle>`
              : ''
          }
          <title>${esc(t('ontology.node.title', { type: n.type, label: n.label, count: fold }))}</title>
        </g>`;
    })
    .join('');

  const legend = (Object.entries(NODE_TYPES) as [NodeType, { color: string }][])
    .map(
      ([type, def]) =>
        `<button class="chip${hidden.has(type) ? ' faded' : ''}" data-type="${type}" aria-pressed="${!hidden.has(type)}"><span class="dot" style="background:${def.color}"></span> ${type}</button>`,
    )
    .join('');
  const level = LEVELS.find(([, , types]) => {
    if (!ui.collapsed && Object.keys(graph.nodes).length > AUTO_FOLD_ABOVE) return types[0] === 'PLC';
    const nodesAt = levelNodes(graph, h, types);
    return types.length
      ? nodesAt.length > 0 && nodesAt.every((id) => collapsed.has(id)) && collapsed.size === nodesAt.length
      : !collapsed.size;
  });
  const total = Object.keys(graph.nodes).length;
  const view = ui.view ?? { x: 0, y: 0, w: width, h: height };
  const found = ui.search.trim() ? matches.size : null;

  return `
      <div class="onto">
        <div>
          <div class="canvas-tools">
            <span class="row gap-1">
              <button class="btn sm" data-zoom="out" aria-label="${esc(t('ontology.zoom.out'))}">−</button>
              <button class="btn sm" data-zoom="in" aria-label="${esc(t('ontology.zoom.in'))}">+</button>
              <button class="btn sm" data-zoom="fit">${esc(t('ontology.zoom.fit'))}</button>
              <button class="btn sm" data-zoom="focus" ${picked.size ? '' : 'disabled'}>${esc(t('ontology.zoom.focus'))}</button>
            </span>${
              editor
                ? `<span class="row gap-1">
              <button class="btn sm" data-undo aria-keyshortcuts="Control+Z Meta+Z" data-tooltip="${esc(t('ontology.undo.tooltip'))}" ${undoable(ctx).length ? '' : 'disabled'}>${esc(t('ontology.undo.label'))}</button>
              <button class="btn sm" data-redo aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y" data-tooltip="${esc(t('ontology.redo.tooltip'))}" ${canRedo(ctx) ? '' : 'disabled'}>${esc(t('ontology.redo.label'))}</button>
              <span class="sr-only" aria-live="polite" data-undo-note>${esc(undoNote)}</span>
            </span>`
                : ''
            }
            <select class="sm" data-fold-level aria-label="${esc(t('ontology.fold.label'))}">${LEVELS.map(
              ([value, label]) =>
                `<option value="${value}" ${level?.[0] === value ? 'selected' : ''}>${esc(t(label))}</option>`,
            ).join('')}${level ? '' : `<option selected disabled>${esc(t('ontology.fold.byHand'))}</option>`}</select>
            <span class="row canvas-search">
              <input type="search" data-onto-search${keyAttr('/')} value="${esc(ui.search)}" placeholder="${esc(t('ontology.search.placeholder'))}" aria-label="${esc(t('ontology.search.placeholder'))}" />
              <button class="btn sm" data-search-next ${found ? '' : 'disabled'}>${esc(t('ontology.search.next'))}</button>
              <span class="small soft" data-search-count aria-live="polite">${found === null ? '' : esc(t('ontology.search.found', { count: found }))}</span>
            </span>
          </div>
          <div class="canvas-wrap" data-tour="onto-canvas">
            <svg data-canvas data-morph="replace" viewBox="${view.x} ${view.y} ${view.w} ${view.h}" preserveAspectRatio="xMidYMid meet">${edges}${nodes}</svg>
            <svg class="minimap" data-minimap data-morph="replace" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path class="mini-nodes" d="${minimapPath(pos)}"/><rect class="mini-view" data-mini-view x="${view.x}" y="${view.y}" width="${view.w}" height="${view.h}"/></svg>
          </div>
          <div class="statusbar">
            <span>${esc(t('ontology.status.nodes', { total, shown: pos.size, hidden: pos.size < total ? 'yes' : 'no' }))}</span><span>${esc(t('ontology.status.edges', { count: Object.keys(graph.edges).length }))}</span>
            <span class="spacer"></span><span class="small soft">${esc(t('ontology.status.hint', { editor: editor ? 'yes' : 'no' }))}</span>
          </div>
          <div class="chips mt-2">${legend}</div>
        </div>
        <div class="card" id="inspector">${
          ui.linking && editor
            ? linkPanel(graph, ui.linking)
            : picked.size > 1
              ? manyPanel(graph, [...picked], editor)
              : ui.selected
                ? inspector(graph, ui.selected, counts, h)
                : editor
                  ? newNodeForm(graph)
                  : viewOnlyNote()
        }</div>
      </div>`;
}

function inspector(graph: Graph, id: string, folded: Map<string, number>, h: Hierarchy): string {
  const n = graph.nodes[id];
  if (!n) return '';
  const isFolded = folded.has(id);
  const below = isFolded ? (folded.get(id) ?? 0) : h.children.get(id)?.length ? hiddenUnder(graph, id, h) : 0;
  const rels = neighbors(graph, id);
  const path = pathTo(graph, id);
  const props = Object.entries(n.props ?? {});
  const required = NODE_TYPES[n.type].required.filter((r) => n.props?.[r] === undefined);
  return `
      <div class="card-head">
        <div><span class="badge"><span class="dot" style="background:${NODE_TYPES[n.type].color}"></span>${esc(n.type)}</span><h2 class="mt-1_5">${esc(n.label)}</h2><div class="muted small mono">${esc(n.id)}</div></div>
        <button class="btn sm" data-deselect aria-label="${esc(t('ontology.inspector.close'))}">✕</button>
      </div>
      ${path.length > 1 ? `<p class="small soft mb-3">${path.map((p) => esc(p.label)).join(' → ')}</p>` : ''}
      ${below || isFolded ? `<p class="mb-3"><button class="btn sm" data-fold="${esc(id)}">${esc(isFolded ? t('ontology.inspector.open', { count: below }) : t('ontology.inspector.fold', { count: below }))}</button></p>` : ''}
      <h3 class="mb-1_5">${esc(t('ontology.inspector.properties'))}</h3>
      <div class="kv">
        ${props.map(([k, v]) => `<span class="k">${esc(k)}</span><span>${esc(v)}</span><button class="btn sm" data-unset="${esc(k)}" aria-label="${esc(t('ontology.inspector.removeProp', { key: k }))}">✕</button>`).join('') || `<span class="muted small span3">${esc(t('ontology.inspector.noProps'))}</span>`}
      </div>
      ${required.length ? `<p class="small text-warn mt-1_5">${esc(t('ontology.inspector.missing', { props: required.join(', ') }))}</p>` : ''}
      <form class="row mt-2 mb-4 m-0" id="prop-form">
        <input type="text" name="key" placeholder="${esc(t('ontology.prop.key'))}" class="w-6em" value="${esc(required[0] ?? '')}" required aria-label="${esc(t('ontology.prop.keyLabel'))}" />
        <input type="text" name="value" placeholder="${esc(t('ontology.prop.value'))}" class="grow w-6em" required aria-label="${esc(t('ontology.prop.valueLabel'))}" />
        <button class="btn sm" type="submit">${esc(t('ontology.prop.set'))}</button>
      </form>
      <h3 class="mb-1_5">${esc(t('ontology.inspector.relationships'))}</h3>
      <div class="rel-list">
        ${rels.map((r) => `<div class="rel">${r.outgoing ? '' : '<span class="r">←</span>'}<span class="r">${esc(r.edge.rel)}</span><a href="#/ontology" data-goto="${esc(r.node.id)}">${esc(r.node.label)}</a><span class="spacer"></span><button class="btn sm" data-unlink="${esc(r.edge.id)}" aria-label="${esc(t('ontology.inspector.unlink'))}">✕</button></div>`).join('') || `<span class="muted small">${esc(t('ontology.inspector.orphan'))}</span>`}
      </div>
      <form class="row mt-2 mb-4 m-0" id="link-form">
        <select name="rel" aria-label="${esc(t('ontology.relationship'))}">${RELS.map((r) => `<option>${r}</option>`).join('')}</select>
        <select name="to" class="grow w-6em" aria-label="${esc(t('ontology.inspector.target'))}" required data-morph="if-changed" data-node-options="${versionOf(graph)}" data-except="${esc(id)}"><option value="">${esc(t('ontology.inspector.choose'))}</option></select>
        <button class="btn sm" type="submit">${esc(t('ontology.inspector.link'))}</button>
      </form>
      <button class="btn danger sm" data-delete ${rels.length ? `disabled title="${esc(t('ontology.inspector.removeFirst', { count: rels.length }))}"` : ''}>${esc(t('ontology.inspector.delete'))}</button>`;
}

// A drag from one node onto another (U5.05): the relationship it most likely means, to confirm.
function linkPanel(graph: Graph, link: { from: string; to: string }): string {
  const a = graph.nodes[link.from];
  const b = graph.nodes[link.to];
  if (!a || !b) return '';
  const rel = likelyRel(a.type, b.type);
  return `
      <div class="card-head"><h2>${esc(t('ontology.link.title'))}</h2><button class="btn sm" type="button" data-link-cancel aria-label="${esc(t('ontology.cancel'))}">✕</button></div>
      <p class="small mb-3"><b>${esc(a.label)}</b> <span class="soft">${esc(a.type)}</span> → <b>${esc(b.label)}</b> <span class="soft">${esc(b.type)}</span></p>
      <form class="row wrap gap-2 m-0" id="drag-link-form">
        <select name="rel" aria-label="${esc(t('ontology.relationship'))}">${RELS.map((r) => `<option ${r === rel ? 'selected' : ''}>${r}</option>`).join('')}</select>
        <button class="btn primary sm" type="submit">${esc(t('ontology.link.add'))}</button>
        <button class="btn sm" type="button" data-link-swap>${esc(t('ontology.link.swap'))}</button>
      </form>`;
}

// Relationships to or from any of `ids`.
function edgesTouching(graph: Graph, ids: string[]): string[] {
  const set = new Set(ids);
  return Object.values(graph.edges)
    .filter((e) => set.has(e.from) || set.has(e.to))
    .map((e) => e.id);
}

const MANY_LISTED = 12;

// Several nodes selected (U5.05): what they are, and what can be done to all of them at once.
function manyPanel(graph: Graph, ids: string[], editor: boolean): string {
  const edges = edgesTouching(graph, ids).length;
  const listed = ids
    .slice(0, MANY_LISTED)
    .map((id) => {
      const n = graph.nodes[id];
      return n
        ? `<li data-key="pick-${esc(id)}"><a href="#/ontology" data-goto="${esc(id)}">${esc(n.label)}</a> <span class="small soft">${esc(n.type)}</span></li>`
        : '';
    })
    .join('');
  const more =
    ids.length > MANY_LISTED
      ? `<li class="small soft">${esc(t('ontology.many.more', { count: ids.length - MANY_LISTED }))}</li>`
      : '';
  return `
      <div class="card-head"><h2>${esc(t('ontology.many.title', { count: ids.length }))}</h2><button class="btn sm" data-deselect aria-label="${esc(t('ontology.many.clear'))}">✕</button></div>
      <ul class="pick-list">${listed}${more}</ul>
      <p class="small soft mt-2 mb-3">${esc(t('ontology.many.hint'))}</p>
      ${
        editor
          ? `<h3 class="mb-1_5">${esc(t('ontology.many.setTitle'))}</h3>
      <form class="row mt-2 mb-4 m-0" id="many-prop-form">
        <input type="text" name="key" placeholder="${esc(t('ontology.prop.key'))}" class="w-6em" required aria-label="${esc(t('ontology.prop.keyLabel'))}" />
        <input type="text" name="value" placeholder="${esc(t('ontology.prop.value'))}" class="grow w-6em" required aria-label="${esc(t('ontology.prop.valueLabel'))}" />
        <button class="btn sm" type="submit">${esc(t('ontology.prop.set'))}</button>
      </form>
      <button class="btn danger sm" data-delete-many>${esc(t('ontology.many.delete', { count: ids.length, edges }))}</button>`
          : ''
      }`;
}

// A file being imported (T2.13, API mode): read here, planned by the API, staged once confirmed.
interface PendingImport {
  site: string;
  name: string;
  format: 'json' | 'csv';
  content: string;
  mode: 'merge' | 'replace';
  preview: OntologyImport | null; // null while it is planned
  plans: number; // the latest plan asked for: an older answer (another mode) is dropped
}
let pending: PendingImport | null = null;

const PREVIEW_LINES = 40;

export function importSummary(c: OntologyImport['counts']): string {
  const part = (count: number, key: MessageKey) => (count ? t(key, { count }) : '');
  const parts = [
    part(c.add_nodes, 'ontology.import.addNodes'),
    part(c.remove_nodes, 'ontology.import.removeNodes'),
    part(c.set_props, 'ontology.import.setProps'),
    part(c.remove_props, 'ontology.import.removeProps'),
    part(c.add_edges, 'ontology.import.addEdges'),
    part(c.remove_edges, 'ontology.import.removeEdges'),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : t('ontology.import.nothing');
}

function importCard(ctx: Context): string {
  const p = pending;
  if (!p || p.site !== ctx.ontology.site?.id) return '';
  const preview = p.preview;
  const lines = preview
    ? describeChanges(ctx.state.repo.head, preview.ops.slice(0, PREVIEW_LINES))
        .map(
          (c) =>
            `<div class="change ${c.sign === '+' ? 'plus' : c.sign === '−' ? 'minus' : 'mod'}"><span class="sign">${c.sign}</span> ${esc(c.text)}</div>`,
        )
        .join('')
    : '';
  const more =
    preview && preview.total > PREVIEW_LINES
      ? `<div>${esc(t('ontology.more', { count: preview.total - PREVIEW_LINES }))}</div>`
      : '';
  return `
    <div class="card mb-4" id="import-card">
      <div class="card-head"><h2>${esc(t('ontology.import.title', { name: p.name }))}</h2>
        <label class="row small gap-1_5">${esc(t('ontology.import.mode'))}<select name="import-mode" data-import-mode aria-label="${esc(t('ontology.import.modeLabel'))}">
          <option value="merge" ${p.mode === 'merge' ? 'selected' : ''}>${esc(t('ontology.import.merge'))}</option>
          <option value="replace" ${p.mode === 'replace' ? 'selected' : ''}>${esc(t('ontology.import.replace'))}</option>
        </select></label></div>
      ${
        preview
          ? `<p class="small" data-import-summary>${esc(importSummary(preview.counts))}.${preview.duplicates.length ? ` ${esc(t('ontology.import.duplicates', { count: preview.duplicates.length }))}` : ''}</p>
      <div class="diff review-diff">${lines}${more}</div>
      <p class="small soft mt-2">${esc(t('ontology.import.staged'))}</p>
      <div class="row gap-2 mt-2">
        <button class="btn primary" data-import-stage ${preview.total ? '' : 'disabled'}>${esc(t('ontology.import.stage', { changes: changes(preview.total) }))}</button>
        <button class="btn" data-import-cancel>${esc(t('ontology.cancel'))}</button>
      </div>`
          : `<p class="small soft">${esc(t('ontology.import.checking'))}</p>`
      }
    </div>`;
}

async function planImport(ctx: Context): Promise<void> {
  const p = pending;
  if (!p || !ctx.api) return;
  const plan = ++p.plans;
  p.preview = null;
  ctx.rerender();
  try {
    const preview = await ctx.api.ontology.importFile(p.site, { ...p, dryRun: true });
    if (pending !== p || plan !== p.plans) return;
    p.preview = preview;
  } catch {
    if (pending !== p || plan !== p.plans) return;
    pending = null; // the client showed why
  }
  ctx.rerender();
}

// Makes `id` show on the canvas: opens the folded nodes above it and shows its type.
function reveal(graph: Graph, ui: OntologyUi, id: string): void {
  const h = hierarchyOf(graph);
  const collapsed = collapsedSet(graph, h, ui);
  for (const above of revealPath(graph, id, collapsed, h)) collapsed.delete(above);
  ui.collapsed = [...collapsed];
  const type = graph.nodes[id]?.type;
  if (type) ui.hidden = ui.hidden.filter((t) => t !== type);
}

// Zoom (wheel, buttons), pan (drag), fold (double-click) and search on the canvas. The view box
// changes in place, without re-rendering, and is kept in the page state for the next render.
function bindCanvas(root: HTMLElement, ctx: Context, ui: OntologyUi): void {
  const svg = root.querySelector<SVGSVGElement>('svg[data-canvas]');
  const layoutNow = drawn;
  // A node to bring into view: kept until a frame of this drawing (or a later one) has done it.
  const center = centerAfterRender;
  if (!svg || !layoutNow) {
    centerAfterRender = null; // for this render only, when not drawn
    return;
  }
  const limits = { width: layoutNow.width, height: layoutNow.height };
  const current = (): ViewBox => {
    const b = svg.viewBox.baseVal;
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  // The view box in the svg's own proportions, so zooming and panning move what is seen.
  const shaped = (): ViewBox => {
    const v = current();
    const aspect = svg.clientWidth / Math.max(1, svg.clientHeight);
    if (!Number.isFinite(aspect) || aspect <= 0) return v;
    const fit = fitView(v.w, v.h, aspect);
    return { x: v.x + fit.x, y: v.y + fit.y, w: fit.w, h: fit.h };
  };
  // The minimap's frame follows the view.
  const miniView = root.querySelector<SVGRectElement>('[data-mini-view]');
  const frame = (v: ViewBox) => {
    if (!miniView) return;
    miniView.setAttribute('x', String(v.x));
    miniView.setAttribute('y', String(v.y));
    miniView.setAttribute('width', String(v.w));
    miniView.setAttribute('height', String(v.h));
  };
  const setView = (v: ViewBox) => {
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    ui.view = v;
    frame(v);
  };
  const toDrawing = (clientX: number, clientY: number) => {
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  // The canvas as tall as the drawing needs at its fitted scale, within the window; the whole
  // drawing shows, never blown up past MAX_FIT_SCALE (text stays the size of the page's).
  const showAll = () => {
    const aspect = svg.clientWidth / svg.clientHeight;
    const v =
      Number.isFinite(aspect) && aspect > 0 // a canvas not laid out (hidden) shows the whole drawing
        ? fitView(limits.width, limits.height, aspect, svg.clientWidth / MAX_FIT_SCALE)
        : { x: 0, y: 0, w: limits.width, h: limits.height };
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`); // not kept: the next render fits again
    frame(v);
  };
  // Focus selection: the view that shows every node selected (opening the folds hiding any).
  const focusSelection = () => {
    const ids = selectedIds(ui, ctx.graph);
    if (!ids.length) return;
    if (ids.some((id) => !layoutNow.pos.has(id))) {
      for (const id of ids) reveal(ctx.graph, ui, id);
      focusAfterRender = true;
      ctx.rerender();
      return;
    }
    const v = focusView(layoutNow.pos, ids, svg.clientWidth / Math.max(1, svg.clientHeight));
    if (v) setView(v);
  };
  const zoom = (factor: number, at?: { x: number; y: number }) => {
    const v = shaped();
    setView(zoomAt(v, factor, at ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 }, limits));
  };
  // What needs the canvas's size waits for the next frame (still before it is painted): read now,
  // it would lay out 2,000 elements inside this task as well as in the frame (U3.07).
  // Meanwhile the canvas keeps the height it had (drawn again, it would lose it, and the page would
  // be measured shorter: its scroll put back wrong).
  const wrap = svg.parentElement;
  if (wrap && canvasTall) wrap.style.height = canvasTall;
  const signal = bound();
  requestAnimationFrame(() => {
    if (signal.aborted) return; // drawn again since: that drawing's frame does it
    if (wrap) {
      const tall = canvasHeight(limits.width, limits.height, wrap.clientWidth, 280, window.innerHeight * 0.75);
      wrap.style.height = canvasTall = `${tall}px`;
    }
    if (!ui.view) showAll();
    else frame(shaped());
    if (centerAfterRender === center) centerAfterRender = null;
    const p = center ? layoutNow.pos.get(center) : undefined;
    if (p) setView(centerOn(shaped(), p));
    if (focusAfterRender) {
      focusAfterRender = false;
      focusSelection();
    }
  });

  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoom(Math.exp(-e.deltaY * 0.0015), toDrawing(e.clientX, e.clientY));
    },
    { passive: false, signal: bound() },
  );
  onAll(root, '[data-zoom]', 'click', (el) => {
    if (el.dataset.zoom === 'in') zoom(1.5);
    else if (el.dataset.zoom === 'out') zoom(1 / 1.5);
    else if (el.dataset.zoom === 'focus') focusSelection();
    else {
      ui.view = null;
      showAll();
    }
  });

  // Drag to pan, Shift-drag to select the nodes in a box, and (editors) drag the handle of the node
  // selected onto another to relate them (U5.05): from anywhere on a node, a drag still pans. A drag ends without the click that would select a node.
  const editor = ctx.ontology.role !== 'viewer';
  const NS = 'http://www.w3.org/2000/svg';
  interface Drag {
    x: number;
    y: number;
    view: ViewBox;
    scale: number;
    moved: boolean;
    id: number;
    mode: 'pan' | 'box' | 'link';
    from: string | null;
    start: { x: number; y: number };
    mark: SVGElement | null;
    over: Element | null;
  }
  let drag: Drag | null = null;
  let swallowClick = false;
  const nodeAt = (x: number, y: number): Element | null =>
    document.elementFromPoint(x, y)?.closest('[data-node]') ?? null;
  svg.addEventListener(
    'pointerdown',
    (e) => {
      swallowClick = false; // a drag the browser cancelled has no click to swallow
      if (e.button !== 0) return;
      const view = shaped();
      const scale = Math.max(view.w / Math.max(1, svg.clientWidth), view.h / Math.max(1, svg.clientHeight));
      const handle = editor && e.target instanceof Element ? e.target.closest('[data-handle]') : null;
      const from = handle?.closest<SVGGElement>('[data-node]')?.dataset.node ?? null;
      const mode = e.shiftKey ? 'box' : from ? 'link' : 'pan';
      const start = toDrawing(e.clientX, e.clientY);
      drag = {
        x: e.clientX,
        y: e.clientY,
        view,
        scale,
        moved: false,
        id: e.pointerId,
        mode,
        from,
        start,
        mark: null,
        over: null,
      };
    },
    { signal: bound() },
  );
  svg.addEventListener(
    'pointermove',
    (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) {
        svg.setPointerCapture(e.pointerId);
        if (drag.mode !== 'pan') {
          drag.mark = document.createElementNS(NS, drag.mode === 'box' ? 'rect' : 'line');
          drag.mark.setAttribute('class', drag.mode === 'box' ? 'box-select' : 'link-preview');
          svg.append(drag.mark);
        }
      }
      drag.moved = true;
      if (drag.mode === 'pan') {
        svg.classList.add('panning');
        setView(panBy(drag.view, -dx * drag.scale, -dy * drag.scale));
        return;
      }
      const at = toDrawing(e.clientX, e.clientY);
      const mark = drag.mark;
      if (!mark) return;
      if (drag.mode === 'box') {
        mark.setAttribute('x', String(Math.min(at.x, drag.start.x)));
        mark.setAttribute('y', String(Math.min(at.y, drag.start.y)));
        mark.setAttribute('width', String(Math.abs(at.x - drag.start.x)));
        mark.setAttribute('height', String(Math.abs(at.y - drag.start.y)));
        return;
      }
      const p = drag.from ? layoutNow.pos.get(drag.from) : undefined;
      if (p) {
        mark.setAttribute('x1', String(p.x + BOX.w / 2));
        mark.setAttribute('y1', String(p.y + BOX.h / 2));
      }
      mark.setAttribute('x2', String(at.x));
      mark.setAttribute('y2', String(at.y));
      const over = nodeAt(e.clientX, e.clientY);
      const target = over && (over as SVGGElement).dataset.node !== drag.from ? over : null;
      if (target !== drag.over) {
        drag.over?.classList.remove('drop');
        target?.classList.add('drop');
        drag.over = target;
      }
    },
    { signal: bound() },
  );
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const done = drag;
    drag = null;
    swallowClick = done.moved;
    svg.classList.remove('panning');
    done.mark?.remove();
    done.over?.classList.remove('drop');
    if (!done.moved || e.type === 'pointercancel') return;
    if (done.mode === 'box') {
      const at = toDrawing(e.clientX, e.clientY);
      const ids = inBox(layoutNow.pos, {
        x: done.start.x,
        y: done.start.y,
        w: at.x - done.start.x,
        h: at.y - done.start.y,
      });
      if (!ids.length) return;
      ui.selection = [...new Set([...selectedIds(ui, ctx.graph), ...ids])];
      ui.selected ??= ids[0] ?? null;
      ui.linking = null;
      ctx.rerender();
    } else if (done.mode === 'link' && done.from) {
      const to = (nodeAt(e.clientX, e.clientY) as SVGGElement | null)?.dataset.node;
      if (!to || to === done.from) return;
      selectOnly(ui, done.from);
      ui.linking = { from: done.from, to };
      ctx.rerender();
      document.querySelector<HTMLSelectElement>('#drag-link-form select')?.focus({ preventScroll: true });
    }
  };
  svg.addEventListener('pointerup', endDrag, { signal: bound() });
  svg.addEventListener('pointercancel', endDrag, { signal: bound() });

  // The minimap: press or drag on it to move the view there.
  const minimap = root.querySelector<SVGSVGElement>('svg[data-minimap]');
  if (minimap) {
    let moving: number | null = null;
    const moveTo = (e: PointerEvent) => {
      const m = minimap.getScreenCTM();
      if (!m) return;
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
      const v = shaped();
      setView({ ...v, x: p.x - v.w / 2, y: p.y - v.h / 2 });
    };
    minimap.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        moving = e.pointerId;
        minimap.setPointerCapture(e.pointerId);
        moveTo(e);
      },
      { signal: bound() },
    );
    minimap.addEventListener(
      'pointermove',
      (e) => {
        if (moving === e.pointerId) moveTo(e);
      },
      { signal: bound() },
    );
    for (const type of ['pointerup', 'pointercancel'] as const)
      minimap.addEventListener(
        type,
        () => {
          moving = null;
        },
        { signal: bound() },
      );
  }
  svg.addEventListener(
    'click',
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation(); // the end of a drag, not a click on a node
    },
    { capture: true, signal: bound() },
  );

  // Fold or open a node.
  const toggleFold = (id: string) => {
    const h = hierarchyOf(ctx.graph);
    const collapsed = collapsedSet(ctx.graph, h, ui);
    if (collapsed.has(id)) collapsed.delete(id);
    else if (h.children.get(id)?.length) collapsed.add(id);
    else return;
    ui.collapsed = [...collapsed];
    if (ui.view) centerAfterRender = id; // zoomed in: stay on the node in the new drawing
    ctx.rerender();
  };
  // A double click folds or opens the node it began on: the first click selects it and the canvas
  // is drawn again, which can move the node from under the second click (onto the background).
  svg.addEventListener(
    'click',
    (e) => {
      if (e.detail !== 2 || !pressedNode) return;
      clearTimeout(inspectorTimer); // opening it, not showing the inspector
      toggleFold(pressedNode);
    },
    { signal: bound() },
  );
  onAll(root, '[data-fold]', 'click', (el) => {
    if (el.dataset.fold) toggleFold(el.dataset.fold);
  });
  onAll(root, '[data-fold-level]', 'change', (el) => {
    const value = (el as HTMLSelectElement).value;
    const types = LEVELS.find(([v]) => v === value)?.[2] ?? [];
    ui.collapsed = levelNodes(ctx.graph, hierarchyOf(ctx.graph), types);
    ui.view = null;
    ctx.rerender();
  });

  // Search: matches light up as you type; Enter (or Next) goes to the next one.
  const input = need<HTMLInputElement>(root, '[data-onto-search]');
  const count = need(root, '[data-search-count]');
  const next = need<HTMLButtonElement>(root, '[data-search-next]');
  const mark = () => {
    const found = new Set(searchNodes(ctx.graph, ui.search));
    svg.querySelectorAll<SVGGElement>('[data-node]').forEach((g) => {
      g.classList.toggle('match', found.has(g.dataset.node ?? ''));
    });
    const shownCount = svg.querySelectorAll('.match').length;
    count.textContent = ui.search.trim()
      ? t('ontology.search.foundHidden', { count: found.size, hidden: Math.max(0, found.size - shownCount) })
      : '';
    next.disabled = !found.size;
  };
  const goNext = () => {
    const found = searchNodes(ctx.graph, ui.search);
    if (!found.length) return;
    ui.match = (ui.match + 1) % found.length;
    const id = found[ui.match];
    if (!id) return;
    reveal(ctx.graph, ui, id);
    selectOnly(ui, id);
    centerAfterRender = id;
    ctx.rerender();
    // Keep typing where you were.
    const again = document.querySelector<HTMLInputElement>('#view [data-onto-search]');
    again?.focus();
    again?.setSelectionRange(again.value.length, again.value.length);
  };
  onAll(root, '[data-onto-search]', 'input', () => {
    ui.search = input.value;
    ui.match = -1;
    mark();
  });
  onAll(root, '[data-onto-search]', 'keydown', (_, e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    goNext();
  });
  onAll(root, '[data-search-next]', 'click', goNext);
  if (ui.search) mark();
}

// Controls that change the ontology; removed for viewers (the API refuses
// their writes anyway, this just keeps the page honest).
const EDIT_CONTROLS =
  '#node-form, #prop-form, #link-form, #many-prop-form, #drag-link-form, [data-unset], [data-unlink], [data-delete], [data-delete-many], [data-fix-delete], [data-revert], [data-import-demo], [data-undo], [data-redo]';

function viewOnlyNote(): string {
  return `
      <div class="card-head"><h2>${esc(t('ontology.viewOnly'))}</h2></div>
      <p class="small soft">${esc(t('ontology.viewOnlyHint'))}</p>`;
}

function newNodeForm(graph: Graph): string {
  return `
      <div class="card-head"><h2>${esc(t('ontology.new.title'))}</h2></div>
      <p class="small soft mb-3">${esc(t('ontology.new.hint'))}</p>
      <form class="stack gap-2_5 max-w-form" id="node-form" data-tour="onto-add">
        <label class="field">${esc(t('ontology.new.type'))}<select name="type">${Object.keys(NODE_TYPES)
          .map((type) => `<option>${type}</option>`)
          .join('')}</select></label>
        <label class="field">${esc(t('ontology.new.label'))}<input type="text" name="label" placeholder="${esc(t('ontology.new.placeholder'))}" required /></label>
        <label class="field">${esc(t('ontology.new.from'))}<select name="from" data-morph="if-changed" data-node-options="${versionOf(graph)}"><option value="">${esc(t('ontology.new.none'))}</option></select></label>
        <label class="field">${esc(t('ontology.relationship'))}<select name="rel">${RELS.map((r) => `<option>${r}</option>`).join('')}</select></label>
        <button class="btn primary" type="submit">${esc(t('ontology.new.stage'))}</button>
      </form>`;
}

function history(ctx: Context, graph: Graph): string {
  const { history } = ctx.state.repo;
  const revert = ctx.ontology.reviewRequired ? t('ontology.history.requestRevert') : t('ontology.history.revert');
  return `<div class="card">${history
    .map(
      (c, i) => `
        <div class="commit">
          <span class="avatar ${i === 0 ? 'bg-accent' : 'bg-line-strong'}">${esc((c.author[0] ?? '?').toUpperCase())}</span>
          <div class="grow min-w-0">
            <div><b>${esc(c.message)}</b></div>
            <div class="small muted">${esc(c.author)}${c.reviewer ? ` · ${esc(t('ontology.history.approvedBy', { reviewer: c.reviewer }))}` : ''} · ${timeAgo(c.date)} · <span class="mono">${esc(c.id.slice(-7))}</span></div>
            <div class="stats">${statBadges(c.stats)}</div>
            <details class="mt-1_5"><summary class="small soft cursor-pointer">${esc(t('ontology.history.ops', { count: c.ops.length }))}</summary>
              <div class="diff mt-1_5">${c.ops
                .slice(0, 60)
                .map((op) => `<div>${esc(describeOp(op, graph))}</div>`)
                .join(
                  '',
                )}${c.ops.length > 60 ? `<div>${esc(t('ontology.more', { count: c.ops.length - 60 }))}</div>` : ''}</div>
            </details>
          </div>
          <button class="btn sm" data-revert="${esc(c.id)}">${esc(revert)}</button>
        </div>`,
    )
    .join('')}</div>`;
}

function healthTab(health: HealthReport, graph: Graph): string {
  const fix = (i: HealthIssue) => {
    if (i.kind === 'orphan')
      return `<button class="btn sm" data-fix-delete="${esc(i.ref)}">${esc(t('ontology.health.stageDelete'))}</button>`;
    if (i.kind === 'duplicate')
      return `<button class="btn sm" data-unlink="${esc(i.ref)}">${esc(t('ontology.health.removeDuplicate'))}</button>`;
    if (graph.nodes[i.ref])
      return `<button class="btn sm" data-goto="${esc(i.ref)}">${esc(t('ontology.health.inspect'))}</button>`;
    return '';
  };
  return `
      <div class="grid g3 mb-4">
        <div class="card kpi ${health.score === 100 ? 'good' : ''}"><div class="label">${esc(t('ontology.health.score'))}</div><div class="value">${health.score}</div></div>
        <div class="card kpi"><div class="label">${esc(t('ontology.health.nodes'))}</div><div class="value">${health.counts.nodes}</div></div>
        <div class="card kpi"><div class="label">${esc(t('ontology.inspector.relationships'))}</div><div class="value">${health.counts.edges}</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>${esc(t('ontology.health.checks'))}</h2><p>${esc(t('ontology.health.checksHint'))}</p></div>
        ${health.issues.map((i) => `<div class="issue"><span class="badge ${i.level === 'info' ? '' : 'bad'}">${esc(i.kind)}</span><span class="grow">${esc(i.text)}</span>${fix(i)}</div>`).join('') || `<div class="empty">${esc(t('ontology.health.pass'))}</div>`}
      </div>`;
}

// Ids of nodes an op touches, to highlight staged changes on the canvas.
function touchedIds(op: Op): string[] {
  switch (op.kind) {
    case 'addNode':
      return [op.node.id];
    case 'addEdge':
      return [op.edge.from, op.edge.to];
    default:
      return [op.id];
  }
}

// Commit, or send for review (T2.12): in API mode the staged changes can go to
// another engineer first; when the site requires that, there is no Commit.
function reviewControls(ctx: Context): string {
  const o = ctx.ontology;
  const commit = `<button class="btn primary" type="submit" value="commit">${esc(t('ontology.commit'))}</button>`;
  if (o.status !== 'ready') return commit;
  const reviewers = o.members
    .filter((m) => m.user_id !== o.userId && m.role !== 'viewer')
    .sort((a, b) => a.name.localeCompare(b.name));
  return `${o.reviewRequired ? '' : commit}
          <select name="reviewer" aria-label="${esc(t('ontology.reviewer'))}"><option value="">${esc(t('ontology.anyEngineer'))}</option>${reviewers
            .map((m) => `<option value="${esc(m.user_id)}">${esc(m.name)}</option>`)
            .join('')}</select>
          <button class="btn ${o.reviewRequired ? 'primary' : ''}" type="submit" value="review" data-request-review>${esc(t('ontology.requestReview'))}</button>`;
}

const ontologyHead = (): string =>
  pageHead({
    eyebrow: t('ontology.eyebrow'),
    title: t('ontology.headTitle'),
    lead: t('ontology.lead'),
  });

// Where this ontology lives, shown only in API mode.
function sourceBar(ctx: Context): string {
  const o = ctx.ontology;
  if (o.status === 'local') return '';
  if (o.status === 'loading')
    return `<div class="card source-bar" aria-live="polite">${esc(t('ontology.source.loading'))}</div>`;
  if (o.status === 'error')
    return `<div class="card source-bar" role="alert"><b>${esc(t('ontology.source.error'))}</b> <span class="soft">${esc(o.error)}</span> <span class="row gap-2 mt-2">${ctx.auth.config?.enabled && !ctx.auth.signedIn ? `<button class="btn sm primary" data-sign-in>${esc(t('ontology.source.signIn'))}</button>` : ''}<button class="btn sm" type="button" data-reconnect>${esc(t('ontology.source.retry'))}</button><a class="btn sm" href="#/settings">${esc(t('ontology.source.settings'))}</a></span></div>`;
  const { head, history, staged } = ctx.state.repo;
  const empty = !Object.keys(head.nodes).length && !history.length && !staged.length;
  return `<div class="card source-bar small" aria-live="polite">
      <span>${tHtml('ontology.source.shared', { site: `<b>${esc(o.site?.name)}</b>` })}${o.reviewRequired ? ` ${t('ontology.source.reviewRequired')}` : ''}${o.role === 'viewer' ? ` <span class="badge">${esc(t('ontology.viewOnly'))}</span>` : ''}</span>
      <span class="row gap-2">${empty ? `<button class="btn sm primary" data-import-demo>${esc(t('ontology.source.demo'))}</button>` : ''}<a class="btn sm" href="#/reviews">${esc(t('ontology.source.reviews'))}</a><button class="btn sm" data-export="json">${esc(t('ontology.source.exportJson'))}</button><button class="btn sm" data-export="csv">${esc(t('ontology.source.exportCsv'))}</button>${o.role === 'viewer' ? '' : `<label class="btn sm" ${staged.length ? `aria-disabled="true" title="${t('ontology.source.importFirst')}"` : ''}>${esc(t('ontology.source.import'))}<input type="file" accept=".json,.csv,application/json,text/csv" data-import-file hidden ${staged.length ? 'disabled' : ''} /></label>`}<button class="btn sm" data-refresh>${esc(t('ontology.source.refresh'))}</button></span>
    </div>`;
}

// How long a click waits to be sure it isn't the first of a double click.
const DOUBLE_CLICK_MS = 400;
let inspectorTimer: ReturnType<typeof setTimeout> | undefined;
let pressedNode: string | null = null; // the node a click began on: a double click opens that one

// A node a link opens (#/ontology?node=<id>, from the command palette, U4.02): selected, shown and
// brought into view once the graph it is in has loaded; the address keeps it until then.
let linkedNode: string | null = null;
onNavigate((hash) => {
  if (routeOf(hash) !== 'ontology') linkedNode = null; // left before it loaded: not for a later visit
});

const view: View = {
  id: 'ontology',
  get title() {
    return t('ontology.title');
  },
  icon: 'network',
  query: {
    read(params) {
      linkedNode = params.get('node');
    },
    write() {
      return { node: linkedNode };
    },
  },
  render(ctx) {
    const ui = uiState(ctx);
    const { repo } = ctx.state;
    const graph = ctx.graph;
    const source = sourceBar(ctx);
    if (ctx.ontology.status === 'loading' || ctx.ontology.status === 'error') return ontologyHead() + source;
    if (linkedNode) {
      const id = linkedNode;
      linkedNode = null; // once: a node not in the graph is let go
      if (graph.nodes[id]) {
        ui.tab = 'canvas';
        selectOnly(ui, id);
        reveal(graph, ui, id);
        centerAfterRender = id;
      }
    }
    const health = graphHealth(graph);
    if (ui.selected && !graph.nodes[ui.selected]) ui.selected = null;
    ui.selection = ui.selection.filter((id) => graph.nodes[id]);
    if (ui.linking && !(graph.nodes[ui.linking.from] && graph.nodes[ui.linking.to])) ui.linking = null;

    const { conflict } = safeWorkingGraph(repo);
    const stagedBar = conflict
      ? `<div class="staged-bar" role="alert">
          <span class="badge bad">${esc(t('ontology.staged.uncommitted', { count: repo.staged.length }))}</span>
          <span class="grow">${esc(t('ontology.staged.conflict', { conflict }))}</span>
          <button class="btn" type="button" data-discard>${esc(t('ontology.staged.discard'))}</button>
        </div>`
      : repo.staged.length && ctx.ontology.role === 'viewer'
        ? // Staged before an admin made them a viewer: they can still throw it away.
          `<div class="staged-bar" id="viewer-staged">
          <span class="badge warn">${esc(t('ontology.staged.uncommitted', { count: repo.staged.length }))}</span>
          <span class="grow">${esc(t('ontology.staged.viewer'))}</span>
          <button class="btn" type="button" data-discard>${esc(t('ontology.staged.discard'))}</button>
        </div>`
        : repo.staged.length
          ? `<form class="staged-bar" id="commit-form" data-tour="onto-commit">
          <span class="badge warn">${esc(t('ontology.staged.uncommitted', { count: repo.staged.length }))}</span>
          <span class="small soft">${statBadges(diffStats(repo.staged))}</span>
          <input type="text" name="message" placeholder="${esc(t('ontology.staged.placeholder'))}" aria-label="${esc(t('ontology.staged.message'))}" required />
          ${reviewControls(ctx)}
          <button class="btn" type="button" data-discard>${esc(t('ontology.staged.discard'))}</button>
        </form>`
          : '';

    const tabs = [
      ['canvas', t('ontology.tab.canvas')],
      ['history', `${esc(t('ontology.tab.history'))} <span class="badge">${repo.history.length}</span>`],
      [
        'health',
        `${esc(t('ontology.tab.health'))} <span class="badge ${health.issues.some((i) => i.level !== 'info') ? 'bad' : 'good'}">${health.score}</span>`,
      ],
    ];

    let body = '';
    if (ui.tab === 'canvas') body = canvas(ctx, graph, health, ui);
    if (ui.tab === 'history') body = history(ctx, graph);
    if (ui.tab === 'health') body = healthTab(health, graph);

    return `
      ${ontologyHead()}
      ${source}
      ${stagedBar}
      ${importCard(ctx)}
      <div class="tabs" role="tablist" data-tour="onto-tabs">${tabs.map(([id, label]) => `<button class="tab ${ui.tab === id ? 'active' : ''}" data-tab="${id}" role="tab">${label}</button>`).join('')}</div>
      ${body}`;
  },

  bind(root, ctx) {
    const ui = uiState(ctx);
    if (ctx.ontology.role === 'viewer') root.querySelectorAll(EDIT_CONTROLS).forEach((el) => el.remove());
    const author = ctx.state.user.email;
    // Each action staged is one step to undo (U5.05); a new one drops what could be redone.
    // The steps are kept as the change lands, before the page is drawn with it (its Undo and Redo
    // buttons and the note then show the new state, drawn once).
    const stageOps = (ops: Op[], ok?: string, then?: () => void) =>
      ctx.ontology.act(async (store, repo) => {
        const next = await store.stage(repo, ops);
        stepsOf(ctx);
        undoSteps.push(ops);
        if (undoSteps.length > 100) undoSteps.shift();
        redoSteps = [];
        undoNote = '';
        then?.();
        return next;
      }, ok);
    const stageOp = (op: Op, ok?: string) => stageOps([op], ok);
    const undo = async () => {
      const ops = undoable(ctx);
      if (undoing || !ops.length || ctx.ontology.role === 'viewer') return;
      undoing = true;
      const top = undoSteps.at(-1);
      try {
        const done = await ctx.ontology.act(async (store, repo) => {
          const next = await store.unstage(repo, ops.length);
          if (top === ops) undoSteps.pop();
          redoSteps.push(ops);
          redoAt = next.staged.length;
          undoNote = t('ontology.undo.note', { changes: changes(ops.length) });
          return next;
        });
        if (done) ux('task', 'ontology.undo');
      } finally {
        undoing = false;
      }
    };
    // A redo that fails stays to be tried again (offline, a busy server); one that no longer fits
    // (a conflicting commit since) fails again with the reason.
    const redo = async () => {
      const ops = redoSteps.at(-1);
      if (undoing || !ops || !canRedo(ctx)) return;
      undoing = true;
      try {
        const done = await ctx.ontology.act(async (store, repo) => {
          const next = await store.stage(repo, ops);
          redoSteps.pop();
          undoSteps.push(ops);
          redoAt = next.staged.length;
          undoNote = t('ontology.redo.note', { changes: changes(ops.length) });
          return next;
        });
        if (done) ux('task', 'ontology.redo');
      } finally {
        undoing = false;
      }
    };
    onAll(root, '[data-undo]', 'click', () => void undo());
    onAll(root, '[data-redo]', 'click', () => void redo());
    // Ctrl Z and Ctrl Shift Z (⌘ on a Mac; Ctrl Y too) on the page, not in a field, an overlay (help,
    // a tour) or the menu.
    document.addEventListener(
      'keydown',
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.defaultPrevented || typing(e.target)) return;
        const t = e.target;
        if (!(t === document.body || (t instanceof Element && t.closest('#view')))) return;
        if (document.querySelector('dialog[open]')) return;
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          void undo();
        } else if ((key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey)) {
          e.preventDefault();
          void redo();
        }
      },
      { signal: bound() },
    );
    // Deletes the nodes selected and their relationships, as one step to undo.
    const deleteSelected = () => {
      const ids = selectedIds(ui, ctx.graph);
      if (!ids.length || ctx.ontology.role === 'viewer') return;
      const ops: Op[] = [
        ...edgesTouching(ctx.graph, ids).map((id): Op => ({ kind: 'removeEdge', id })),
        ...ids.map((id): Op => ({ kind: 'removeNode', id })),
      ];
      if (ops.length > MOST_OPS) {
        ctx.toast(
          t('ontology.toast.tooMany', {
            count: fmt(ops.length),
            most: fmt(MOST_OPS),
          }),
        );
        return;
      }
      selectOnly(ui, null);
      void stageOps(
        ops,
        ids.length === 1 ? t('ontology.toast.deleted') : t('ontology.toast.deletedMany', { count: ids.length }),
      );
    };
    onAll(root, '[data-delete-many]', 'click', deleteSelected);
    onAll(root, '[data-refresh]', 'click', () => void ctx.ontology.reload());
    onAll(root, '[data-export]', 'click', async (el) => {
      const site = ctx.ontology.site;
      const format = el.dataset.export === 'csv' ? 'csv' : 'json';
      if (!ctx.api || !site) return;
      try {
        const text = await ctx.api.ontology.exportFile(site.id, format);
        download(`${site.slug}-ontology.${format}`, text, format === 'csv' ? 'text/csv' : 'application/json');
      } catch {
        // the client showed why
      }
    });
    root.querySelector<HTMLInputElement>('[data-import-file]')?.addEventListener(
      'change',
      (e) => {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        const site = ctx.ontology.site;
        input.value = ''; // choosing the same file again still counts
        if (!file || !site) return;
        void file.text().then((content) => {
          const format = /\.csv$/i.test(file.name) || file.type === 'text/csv' ? 'csv' : 'json';
          pending = { site: site.id, name: file.name, format, content, mode: 'merge', preview: null, plans: 0 };
          void planImport(ctx);
        });
      },
      { signal: bound() },
    );
    root.querySelector<HTMLSelectElement>('[data-import-mode]')?.addEventListener(
      'change',
      (e) => {
        if (!pending) return;
        pending.mode = (e.target as HTMLSelectElement).value === 'replace' ? 'replace' : 'merge';
        void planImport(ctx);
      },
      { signal: bound() },
    );
    onAll(root, '[data-import-cancel]', 'click', () => {
      pending = null;
      ctx.rerender();
    });
    onAll(root, '[data-import-stage]', 'click', (el) => {
      const p = pending;
      const shown = p?.preview;
      if (!p || !shown || !ctx.api) return;
      el.setAttribute('disabled', '');
      const api = ctx.api;
      void ctx.ontology
        .act(
          async (store) => {
            // Only what the preview showed: refused if someone committed since.
            const result = await api.ontology.importFile(p.site, { ...p, dryRun: false, expectCommit: shown.commit });
            if (pending === p) pending = null;
            if (!(store.kind === 'api' && 'load' in store)) throw new Error(t('ontology.toast.importsNeedApi'));
            if (!result.staged) throw new Error(t('ontology.toast.nothing'));
            return (store as RemoteStore).load();
          },
          t('ontology.toast.imported', { name: p.name }),
        )
        .then((ok) => {
          if (!ok && pending === p) void planImport(ctx); // show what it would change now
        });
    });
    onAll(root, '[data-sign-in]', 'click', () => void ctx.auth.signIn());
    onAll(root, '[data-import-demo]', 'click', async (el) => {
      el.setAttribute('disabled', '');
      const ops = historyOps(seedOntology());
      if (!(await stageOps(ops))) return;
      const message = t('ontology.demo.message');
      if (ctx.ontology.reviewRequired)
        await ctx.ontology.act((store, repo) => store.requestReview(repo, { message }), t('ontology.demo.review'));
      else await ctx.ontology.act((store, repo) => store.commit(repo, message, author), t('ontology.demo.imported'));
    });
    const selected = (): string | null => ui.selected;

    onAll(root, '[data-tab]', 'click', (el) => {
      const tab = el.dataset.tab;
      if (tab === 'canvas' || tab === 'history' || tab === 'health') ui.tab = tab;
      ctx.rerender();
    });
    const toInspector = () => {
      const panel = document.getElementById('inspector');
      const r = panel?.getBoundingClientRect();
      if (panel && r && (r.top > window.innerHeight || r.bottom < 0))
        panel.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    };
    const select = (id: string | undefined, scroll = true) => {
      if (!id) return;
      selectOnly(ui, id);
      ctx.rerender();
      if (scroll) toInspector();
    };
    // A click away from the nodes forgets the node pressed last.
    root.querySelector<SVGSVGElement>('svg[data-canvas]')?.addEventListener(
      'click',
      (e) => {
        if (e.detail === 1 && !(e.target instanceof Element && e.target.closest('[data-node]'))) pressedNode = null;
      },
      { signal: bound() },
    );
    // A click shows the inspector once it is clearly not the first of a double click (which opens
    // the node): the page moving between the two clicks would send the second elsewhere.
    onAll(root, '[data-node]', 'click', (el, e) => {
      if (e.detail > 1) return; // the second of a double click: it folds or opens (bindCanvas)
      const id = el.dataset.node;
      if (e.shiftKey && id) {
        toggleSelected(ui, ctx.graph, id);
        ctx.rerender();
        return;
      }
      pressedNode = el.dataset.node ?? null;
      select(el.dataset.node, false);
      clearTimeout(inspectorTimer);
      inspectorTimer = setTimeout(toInspector, DOUBLE_CLICK_MS);
    });
    // Keys on a node: Enter or Space selects it (with Shift, adds it), the arrow keys move to the
    // nearest node that way, Escape clears the selection and Delete deletes what is selected.
    const ARROWS: Record<string, Direction> = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
    };
    onAll(root, '[data-node]', 'keydown', (el, e) => {
      const id = el.dataset.node;
      if (!id || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (e.shiftKey) {
          toggleSelected(ui, ctx.graph, id);
          ctx.rerender();
        } else select(id);
        return;
      }
      const dir = ARROWS[e.key];
      if (dir) {
        e.preventDefault();
        const next = drawn ? stepFrom(drawn.pos, id, dir) : null;
        if (!next) return;
        if (e.shiftKey) {
          ui.selection = [...new Set([...selectedIds(ui, ctx.graph), next])];
          ui.selected = next;
        } else selectOnly(ui, next);
        const p = drawn?.pos.get(next);
        const v = ui.view;
        if (p && v && (p.x < v.x || p.y < v.y || p.x + BOX.w > v.x + v.w || p.y + BOX.h > v.y + v.h))
          centerAfterRender = next;
        ctx.rerender();
        document.querySelector<SVGGElement>(`#view [data-node="${CSS.escape(next)}"]`)?.focus({ preventScroll: true });
        return;
      }
      if (e.key === 'Escape' && selectedIds(ui, ctx.graph).length) {
        e.preventDefault();
        selectOnly(ui, null);
        ctx.rerender();
        document.querySelector<SVGGElement>(`#view [data-node="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedIds(ui, ctx.graph).includes(id)) selectOnly(ui, id);
        e.preventDefault();
        deleteSelected();
      }
    });
    bindCanvas(root, ctx, ui);
    onAll(root, '[data-goto]', 'click', (el, e) => {
      e.preventDefault();
      const id = el.dataset.goto;
      if (!id) return;
      reveal(ctx.graph, ui, id);
      selectOnly(ui, id);
      ui.tab = 'canvas';
      centerAfterRender = id;
      ctx.rerender();
    });
    onAll(root, '[data-deselect]', 'click', () => {
      selectOnly(ui, null);
      ctx.rerender();
    });
    onAll(root, '[data-link-cancel]', 'click', () => {
      ui.linking = null;
      ctx.rerender();
    });
    onAll(root, '[data-link-swap]', 'click', () => {
      const link = ui.linking;
      if (!link) return;
      ui.linking = { from: link.to, to: link.from };
      ui.selected = link.to;
      ctx.rerender();
    });
    onSubmit(root, '#drag-link-form', (form) => {
      const link = ui.linking;
      if (!link) return;
      const rel = field(form, 'rel');
      const { from, to } = link;
      const id = edgeId(ctx.graph, from, rel, to);
      return stageOps([{ kind: 'addEdge', edge: { id, from, rel, to } }], t('ontology.toast.related'), () => {
        if (ui.linking === link) ui.linking = null;
      }).then((ok) => ok && ux('task', 'ontology.related'));
    });
    onSubmit(root, '#many-prop-form', (form) => {
      const ids = selectedIds(ui, ctx.graph);
      const key = field(form, 'key').trim();
      const value = parseValue(field(form, 'value').trim());
      if (!ids.length) return;
      if (ids.length > MOST_OPS) {
        ctx.toast(t('ontology.toast.tooManyProps', { most: fmt(MOST_OPS) }));
        return;
      }
      return stageOps(
        ids.map((id): Op => ({ kind: 'setProp', id, key, value })),
        t('ontology.toast.propSet', { key, count: ids.length }),
      );
    });
    onAll(root, '[data-type]', 'click', (el) => {
      const t = el.dataset.type as NodeType | undefined;
      if (!t) return;
      ui.hidden = ui.hidden.includes(t) ? ui.hidden.filter((x) => x !== t) : [...ui.hidden, t];
      ctx.rerender();
    });
    onAll(root, '[data-unset]', 'click', (el) => {
      const id = selected();
      if (id && el.dataset.unset) stageOp({ kind: 'setProp', id, key: el.dataset.unset });
    });
    onAll(root, '[data-unlink]', 'click', (el) => {
      if (el.dataset.unlink) stageOp({ kind: 'removeEdge', id: el.dataset.unlink }, t('ontology.toast.unlinked'));
    });
    onAll(root, '[data-delete]', 'click', () => {
      const id = selected();
      if (!id) return;
      selectOnly(ui, null);
      stageOp({ kind: 'removeNode', id }, t('ontology.toast.deleted'));
    });
    onAll(root, '[data-fix-delete]', 'click', (el) => {
      if (el.dataset.fixDelete) stageOp({ kind: 'removeNode', id: el.dataset.fixDelete }, t('ontology.toast.deleted'));
    });
    onAll(root, '[data-discard]', 'click', () =>
      ctx.ontology.act((store, repo) => store.discard(repo), t('ontology.toast.discarded')),
    );
    onAll(root, '[data-revert]', 'click', (el) => {
      const id = el.dataset.revert;
      if (!id) return;
      if (ctx.ontology.reviewRequired)
        void ctx.ontology.act(
          (store, repo) => store.requestReview(repo, { reverts: id }),
          t('ontology.toast.revertSent'),
        );
      else void ctx.ontology.act((store, repo) => store.revert(repo, id, author), t('ontology.toast.reverted'));
    });

    onSubmit(root, '#commit-form', (form, submitter) => {
      const message = field(form, 'message');
      // Enter in the message field submits with the first button: Commit, or Request review when it's the only one.
      const review = submitter ? submitter.hasAttribute('data-request-review') : !form.querySelector('[value=commit]');
      if (!review) {
        return ctx.ontology
          .act((store, repo) => store.commit(repo, message, author), t('ontology.toast.committed'))
          .then((ok) => ok && ux('task', 'ontology.committed'));
      }
      const reviewerId = field(form, 'reviewer') || undefined;
      return ctx.ontology
        .act((store, repo) => store.requestReview(repo, { message, reviewerId }), t('ontology.toast.sent'))
        .then((ok) => ok && ux('task', 'ontology.review-requested'));
    });
    onSubmit(root, '#prop-form', (form) => {
      const id = selected();
      if (!id) return;
      const key = field(form, 'key').trim();
      stageOp({ kind: 'setProp', id, key, value: parseValue(field(form, 'value').trim()) });
    });
    onSubmit(root, '#link-form', (form) => {
      const from = selected();
      if (!from) return;
      const rel = field(form, 'rel');
      const to = field(form, 'to');
      stageOp({ kind: 'addEdge', edge: { id: edgeId(ctx.graph, from, rel, to), from, rel, to } });
    });
    for (const type of ['focus', 'pointerdown', 'keydown'] as const)
      onAll(root, 'select[data-node-options]', type, (el) => fillNodeOptions(el as HTMLSelectElement, ctx.graph));
    onSubmit(root, '#node-form', (form) => {
      const type = field(form, 'type') as NodeType;
      const label = field(form, 'label').trim();
      const slug =
        label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 30) || 'node';
      let id = `${type.toLowerCase()}-${slug}`;
      for (let k = 2; ctx.graph.nodes[id]; k++) id = `${type.toLowerCase()}-${slug}-${k}`;
      const from = field(form, 'from');
      const rel = field(form, 'rel');
      const ops: Op[] = [{ kind: 'addNode', node: { id, type, label, props: {} } }];
      if (from) ops.push({ kind: 'addEdge', edge: { id: `${from}-${rel}-${id}`, from, rel, to: id } });
      void stageOps(ops, t('ontology.toast.staged')).then((ok) => {
        if (ok) {
          selectOnly(ui, id);
          ctx.rerender();
        }
      });
    });
  },
};

export default view;
