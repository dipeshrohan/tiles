import { NODE_TYPES, healthCheck, neighbors, pathTo, diffStats } from '../lib/ontology.ts';
import {
  BOX,
  MAX_FIT_SCALE,
  canvasHeight,
  centerOn,
  collapsible,
  fitView,
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
import { historyOps, safeWorkingGraph, type RemoteStore } from '../lib/ontology-store.ts';
import { seedOntology } from '../lib/data.ts';
import { download, esc, field, need, onAll, onSubmit, timeAgo } from '../lib/dom.ts';
import { describeChanges } from '../lib/review.ts';
import type { OntologyImport } from '../lib/api.ts';
import type { DiffStats, Graph, HealthIssue, HealthReport, NodeType, Op } from '../lib/types.ts';
import type { Context, View } from './types.ts';

interface OntologyUi {
  tab: 'canvas' | 'history' | 'health';
  selected: string | null;
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

const RELS = ['contains', 'runs', 'consumes', 'controlledBy', 'emits', 'describes', 'reads', 'monitors', 'feeds'];

// Canvas at scale (T2.14): what folding a level does, and when it happens by itself.
const LEVELS: [string, string, NodeType[]][] = [
  ['', 'Show everything', []],
  ['PLC', 'Fold signals into their PLC', ['PLC']],
  ['Machine', 'Fold into machines', ['Machine']],
  ['Line', 'Fold into lines', ['Line', 'Cell']],
  ['Workcenter', 'Fold into workcenters', ['Workcenter']],
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

const short = (s: string, n = 19): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function describeOp(op: Op, graph: Graph): string {
  const label = (id: string) => graph.nodes[id]?.label ?? id;
  switch (op.kind) {
    case 'addNode':
      return `+ ${op.node.type} “${op.node.label}”`;
    case 'removeNode':
      return `− node ${op.id}`;
    case 'addEdge':
      return `+ ${label(op.edge.from)} —${op.edge.rel}→ ${label(op.edge.to)}`;
    case 'removeEdge':
      return `− relationship ${op.id}`;
    case 'setProp':
      return op.value === undefined ? `− ${label(op.id)}.${op.key}` : `~ ${label(op.id)}.${op.key} = ${op.value}`;
  }
}

function statBadges(s: DiffStats): string {
  const b = (n: number, what: string) =>
    n
      ? `<span class="badge"><span class="${n > 0 ? 'plus' : 'minus'}">${n > 0 ? '+' : '−'}${Math.abs(n)}</span> ${what}</span>`
      : '';
  return b(s.nodes, 'node') + b(s.edges, 'edge') + b(s.props, 'prop');
}

function canvas(ctx: Context, graph: Graph, health: HealthReport, ui: OntologyUi): string {
  const hidden = new Set(ui.hidden);
  const h = hierarchy(graph);
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
      const hl = ui.selected && (e.from === ui.selected || e.to === ui.selected);
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
        ui.selected === id && 'sel',
        issueIds.has(id) && 'issue',
        stagedIds.has(id) && 'staged',
        matches.has(id) && 'match',
        fold && 'folded',
      ]
        .filter(Boolean)
        .join(' ');
      return `<g class="${cls}" data-node="${esc(id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(n.type)} ${esc(n.label)}${fold ? `, ${fold} folded` : ''}">
          <rect width="${BOX.w}" height="${BOX.h}" rx="6"/>
          <rect width="5" height="${BOX.h}" rx="2" fill="${NODE_TYPES[n.type].color}" stroke="none"/>
          <text x="13" y="18">${esc(short(n.label, fold ? 15 : 19))}</text>${fold ? `<text class="fold" x="${BOX.w - 7}" y="18" text-anchor="end">+${fold}</text>` : ''}
          <title>${esc(n.type)}: ${esc(n.label)}${fold ? ` (${fold} folded: double-click to open)` : ''}</title>
        </g>`;
    })
    .join('');

  const legend = (Object.entries(NODE_TYPES) as [NodeType, { color: string }][])
    .map(
      ([t, def]) =>
        `<button class="chip${hidden.has(t) ? ' faded' : ''}" data-type="${t}" aria-pressed="${!hidden.has(t)}"><span class="dot" style="background:${def.color}"></span> ${t}</button>`,
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
              <button class="btn sm" data-zoom="out" aria-label="Zoom out">−</button>
              <button class="btn sm" data-zoom="in" aria-label="Zoom in">+</button>
              <button class="btn sm" data-zoom="fit">Fit</button>
            </span>
            <select class="sm" data-fold-level aria-label="Fold the hierarchy">${LEVELS.map(
              ([value, label]) =>
                `<option value="${value}" ${level?.[0] === value ? 'selected' : ''}>${label}</option>`,
            ).join('')}${level ? '' : '<option selected disabled>Folded by hand</option>'}</select>
            <span class="row canvas-search">
              <input type="search" data-onto-search value="${esc(ui.search)}" placeholder="Find a node" aria-label="Find a node" />
              <button class="btn sm" data-search-next ${found ? '' : 'disabled'}>Next</button>
              <span class="small soft" data-search-count aria-live="polite">${found === null ? '' : `${found} found`}</span>
            </span>
          </div>
          <div class="canvas-wrap">
            <svg data-canvas viewBox="${view.x} ${view.y} ${view.w} ${view.h}" preserveAspectRatio="xMidYMid meet">${edges}${nodes}</svg>
          </div>
          <div class="statusbar">
            <span>Nodes: ${total}${pos.size < total ? ` (${pos.size} shown)` : ''}</span><span>Relationships: ${Object.keys(graph.edges).length}</span>
            <span class="spacer"></span><span class="small soft">Scroll to zoom, drag to move, double-click a node to fold or open it</span>
          </div>
          <div class="chips mt-2">${legend}</div>
        </div>
        <div class="card" id="inspector">${ui.selected ? inspector(graph, ui.selected, counts, h) : ctx.ontology.role === 'viewer' ? viewOnlyNote() : newNodeForm(graph)}</div>
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
  const others = Object.values(graph.nodes)
    .filter((o) => o.id !== id)
    .sort((a, b) => a.label.localeCompare(b.label));
  return `
      <div class="card-head">
        <div><span class="badge"><span class="dot" style="background:${NODE_TYPES[n.type].color}"></span>${esc(n.type)}</span><h2 class="mt-1_5">${esc(n.label)}</h2><div class="muted small mono">${esc(n.id)}</div></div>
        <button class="btn sm" data-deselect aria-label="Close">✕</button>
      </div>
      ${path.length > 1 ? `<p class="small soft mb-3">${path.map((p) => esc(p.label)).join(' → ')}</p>` : ''}
      ${below || isFolded ? `<p class="mb-3"><button class="btn sm" data-fold="${esc(id)}">${isFolded ? `Open (${below} folded)` : `Fold the ${below} below it`}</button></p>` : ''}
      <h3 class="mb-1_5">Properties</h3>
      <div class="kv">
        ${props.map(([k, v]) => `<span class="k">${esc(k)}</span><span>${esc(v)}</span><button class="btn sm" data-unset="${esc(k)}" aria-label="Remove ${esc(k)}">✕</button>`).join('') || '<span class="muted small span3">No properties</span>'}
      </div>
      ${required.length ? `<p class="small text-warn mt-1_5">Missing required: ${required.map(esc).join(', ')}</p>` : ''}
      <form class="row mt-2 mb-4 m-0" id="prop-form">
        <input type="text" name="key" placeholder="key" class="w-6em" value="${esc(required[0] ?? '')}" required aria-label="Property key" />
        <input type="text" name="value" placeholder="value" class="grow w-6em" required aria-label="Property value" />
        <button class="btn sm" type="submit">Set</button>
      </form>
      <h3 class="mb-1_5">Relationships</h3>
      <div class="rel-list">
        ${rels.map((r) => `<div class="rel">${r.outgoing ? '' : '<span class="r">←</span>'}<span class="r">${esc(r.edge.rel)}</span><a href="#/ontology" data-goto="${esc(r.node.id)}">${esc(r.node.label)}</a><span class="spacer"></span><button class="btn sm" data-unlink="${esc(r.edge.id)}" aria-label="Remove relationship">✕</button></div>`).join('') || '<span class="muted small">No relationships — this node is an orphan</span>'}
      </div>
      <form class="row mt-2 mb-4 m-0" id="link-form">
        <select name="rel" aria-label="Relationship">${RELS.map((r) => `<option>${r}</option>`).join('')}</select>
        <select name="to" class="grow w-6em" aria-label="Target node">${others.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}</select>
        <button class="btn sm" type="submit">Link</button>
      </form>
      <button class="btn danger sm" data-delete ${rels.length ? `disabled title="Remove its ${rels.length} relationship(s) first"` : ''}>Delete node</button>`;
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
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
  const parts = [
    part(c.add_nodes, 'new node', 'new nodes'),
    part(c.remove_nodes, 'node removed', 'nodes removed'),
    part(c.set_props, 'property set', 'properties set'),
    part(c.remove_props, 'property removed', 'properties removed'),
    part(c.add_edges, 'new relationship', 'new relationships'),
    part(c.remove_edges, 'relationship removed', 'relationships removed'),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'nothing to change: the ontology already matches the file';
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
  const more = preview && preview.total > PREVIEW_LINES ? `<div>… ${preview.total - PREVIEW_LINES} more</div>` : '';
  return `
    <div class="card mb-4" id="import-card">
      <div class="card-head"><h2>Import ${esc(p.name)}</h2>
        <label class="row small gap-1_5">Mode<select name="import-mode" data-import-mode aria-label="Import mode">
          <option value="merge" ${p.mode === 'merge' ? 'selected' : ''}>Merge: add and update</option>
          <option value="replace" ${p.mode === 'replace' ? 'selected' : ''}>Replace: the ontology becomes the file</option>
        </select></label></div>
      ${
        preview
          ? `<p class="small" data-import-summary>${esc(importSummary(preview.counts))}.${preview.duplicates.length ? ` ${preview.duplicates.length} relationship(s) already there under another id are skipped.` : ''}</p>
      <div class="diff review-diff">${lines}${more}</div>
      <p class="small soft mt-2">The changes are staged, not committed: you then commit them, or send them for review.</p>
      <div class="row gap-2 mt-2">
        <button class="btn primary" data-import-stage ${preview.total ? '' : 'disabled'}>Stage ${preview.total} change(s)</button>
        <button class="btn" data-import-cancel>Cancel</button>
      </div>`
          : '<p class="small soft">Checking the file against the ontology…</p>'
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
  const h = hierarchy(graph);
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
  const center = centerAfterRender;
  centerAfterRender = null; // for this render only, drawn or not
  if (!svg || !layoutNow) return;
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
  const setView = (v: ViewBox) => {
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    ui.view = v;
  };
  const toDrawing = (clientX: number, clientY: number) => {
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  // The canvas as tall as the drawing needs at its fitted scale, within the window; the whole
  // drawing shows, never blown up past MAX_FIT_SCALE (text stays the size of the page's).
  const wrap = svg.parentElement;
  if (wrap) {
    const tall = canvasHeight(limits.width, limits.height, wrap.clientWidth, 280, window.innerHeight * 0.75);
    wrap.style.height = `${tall}px`;
  }
  const showAll = () => {
    const aspect = svg.clientWidth / svg.clientHeight;
    const v =
      Number.isFinite(aspect) && aspect > 0 // a canvas not laid out (hidden) shows the whole drawing
        ? fitView(limits.width, limits.height, aspect, svg.clientWidth / MAX_FIT_SCALE)
        : { x: 0, y: 0, w: limits.width, h: limits.height };
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`); // not kept: the next render fits again
  };
  if (!ui.view) showAll();
  const zoom = (factor: number, at?: { x: number; y: number }) => {
    const v = shaped();
    setView(zoomAt(v, factor, at ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 }, limits));
  };

  if (center) {
    const p = layoutNow.pos.get(center);
    if (p) setView(centerOn(shaped(), p));
  }

  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoom(Math.exp(-e.deltaY * 0.0015), toDrawing(e.clientX, e.clientY));
    },
    { passive: false },
  );
  onAll(root, '[data-zoom]', 'click', (el) => {
    if (el.dataset.zoom === 'in') zoom(1.5);
    else if (el.dataset.zoom === 'out') zoom(1 / 1.5);
    else {
      ui.view = null;
      showAll();
    }
  });

  // Drag to pan; a drag ends without the click that would select a node.
  let drag: { x: number; y: number; view: ViewBox; scale: number; moved: boolean; id: number } | null = null;
  let swallowClick = false;
  svg.addEventListener('pointerdown', (e) => {
    swallowClick = false; // a drag the browser cancelled has no click to swallow
    if (e.button !== 0) return;
    const view = shaped();
    const scale = Math.max(view.w / Math.max(1, svg.clientWidth), view.h / Math.max(1, svg.clientHeight));
    drag = { x: e.clientX, y: e.clientY, view, scale, moved: false, id: e.pointerId };
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) svg.setPointerCapture(e.pointerId);
    drag.moved = true;
    svg.classList.add('panning');
    setView(panBy(drag.view, -dx * drag.scale, -dy * drag.scale));
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    swallowClick = drag.moved;
    drag = null;
    svg.classList.remove('panning');
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener(
    'click',
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation(); // the end of a drag, not a click on a node
    },
    true,
  );

  // Fold or open a node.
  const toggleFold = (id: string) => {
    const h = hierarchy(ctx.graph);
    const collapsed = collapsedSet(ctx.graph, h, ui);
    if (collapsed.has(id)) collapsed.delete(id);
    else if (h.children.get(id)?.length) collapsed.add(id);
    else return;
    ui.collapsed = [...collapsed];
    if (ui.view) centerAfterRender = id; // zoomed in: stay on the node in the new drawing
    ctx.rerender();
  };
  onAll(root, '[data-node]', 'dblclick', (el) => {
    if (el.dataset.node) toggleFold(el.dataset.node);
  });
  onAll(root, '[data-fold]', 'click', (el) => {
    if (el.dataset.fold) toggleFold(el.dataset.fold);
  });
  onAll(root, '[data-fold-level]', 'change', (el) => {
    const value = (el as HTMLSelectElement).value;
    const types = LEVELS.find(([v]) => v === value)?.[2] ?? [];
    ui.collapsed = levelNodes(ctx.graph, hierarchy(ctx.graph), types);
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
      ? `${found.size} found${shownCount < found.size ? ` (${found.size - shownCount} folded or hidden)` : ''}`
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
    ui.selected = id;
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
  '#node-form, #prop-form, #link-form, [data-unset], [data-unlink], [data-delete], [data-fix-delete], [data-revert], [data-import-demo]';

function viewOnlyNote(): string {
  return `
      <div class="card-head"><h2>View only</h2></div>
      <p class="small soft">Your role on this site is viewer. Select a node on the canvas to inspect it. To make changes, ask a site admin for the engineer role.</p>`;
}

function newNodeForm(graph: Graph): string {
  const nodes = Object.values(graph.nodes).sort((a, b) => a.label.localeCompare(b.label));
  return `
      <div class="card-head"><h2>New node</h2></div>
      <p class="small soft mb-3">Select a node on the canvas to inspect it, or stage a new one here.</p>
      <form class="stack gap-2_5 max-w-form" id="node-form">
        <label class="field">Type<select name="type">${Object.keys(NODE_TYPES)
          .map((t) => `<option>${t}</option>`)
          .join('')}</select></label>
        <label class="field">Label<input type="text" name="label" placeholder="e.g. Alarm stream DC-02" required /></label>
        <label class="field">Link from (optional)<select name="from"><option value="">— none —</option>${nodes.map((n) => `<option value="${esc(n.id)}">${esc(n.label)}</option>`).join('')}</select></label>
        <label class="field">Relationship<select name="rel">${RELS.map((r) => `<option>${r}</option>`).join('')}</select></label>
        <button class="btn primary" type="submit">+ Stage node</button>
      </form>`;
}

function history(ctx: Context, graph: Graph): string {
  const { history } = ctx.state.repo;
  const revert = ctx.ontology.reviewRequired ? 'Request revert' : 'Revert';
  return `<div class="card">${history
    .map(
      (c, i) => `
        <div class="commit">
          <span class="avatar ${i === 0 ? 'bg-accent' : 'bg-line-strong'}">${esc((c.author[0] ?? '?').toUpperCase())}</span>
          <div class="grow min-w-0">
            <div><b>${esc(c.message)}</b></div>
            <div class="small muted">${esc(c.author)}${c.reviewer ? ` · approved by ${esc(c.reviewer)}` : ''} · ${timeAgo(c.date)} · <span class="mono">${esc(c.id.slice(-7))}</span></div>
            <div class="stats">${statBadges(c.stats)}</div>
            <details class="mt-1_5"><summary class="small soft cursor-pointer">${c.ops.length} operation(s)</summary>
              <div class="diff mt-1_5">${c.ops
                .slice(0, 60)
                .map((op) => `<div>${esc(describeOp(op, graph))}</div>`)
                .join('')}${c.ops.length > 60 ? `<div>… ${c.ops.length - 60} more</div>` : ''}</div>
            </details>
          </div>
          <button class="btn sm" data-revert="${esc(c.id)}">${revert}</button>
        </div>`,
    )
    .join('')}</div>`;
}

function healthTab(health: HealthReport, graph: Graph): string {
  const fix = (i: HealthIssue) => {
    if (i.kind === 'orphan') return `<button class="btn sm" data-fix-delete="${esc(i.ref)}">Stage delete</button>`;
    if (i.kind === 'duplicate') return `<button class="btn sm" data-unlink="${esc(i.ref)}">Remove duplicate</button>`;
    if (graph.nodes[i.ref]) return `<button class="btn sm" data-goto="${esc(i.ref)}">Inspect</button>`;
    return '';
  };
  return `
      <div class="grid g3 mb-4">
        <div class="card kpi ${health.score === 100 ? 'good' : ''}"><div class="label">Health score</div><div class="value">${health.score}</div></div>
        <div class="card kpi"><div class="label">Nodes</div><div class="value">${health.counts.nodes}</div></div>
        <div class="card kpi"><div class="label">Relationships</div><div class="value">${health.counts.edges}</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Checks</h2><p>Orphan nodes, dangling and duplicate relationships, and required properties per type.</p></div>
        ${health.issues.map((i) => `<div class="issue"><span class="badge ${i.level === 'info' ? '' : 'bad'}">${esc(i.kind)}</span><span class="grow">${esc(i.text)}</span>${fix(i)}</div>`).join('') || '<div class="empty">All checks pass ✓</div>'}
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
  const commit = '<button class="btn primary" type="submit" value="commit">Commit</button>';
  if (o.status !== 'ready') return commit;
  const reviewers = o.members
    .filter((m) => m.user_id !== o.userId && m.role !== 'viewer')
    .sort((a, b) => a.name.localeCompare(b.name));
  return `${o.reviewRequired ? '' : commit}
          <select name="reviewer" aria-label="Reviewer"><option value="">Any engineer</option>${reviewers
            .map((m) => `<option value="${esc(m.user_id)}">${esc(m.name)}</option>`)
            .join('')}</select>
          <button class="btn ${o.reviewRequired ? 'primary' : ''}" type="submit" value="review" data-request-review>Request review</button>`;
}

function pageHead(): string {
  return `
      <div class="page-head">
        <div>
          <div class="eyebrow">Operations · Ontology</div>
          <h1>A map of the factory</h1>
          <p>Site → Workcenter → Line → Machine, linked to processes, materials, PLCs, signals, documents and models. Edits are staged, committed with a message, and reversible.</p>
        </div>
      </div>`;
}

// Where this ontology lives, shown only in API mode.
function sourceBar(ctx: Context): string {
  const o = ctx.ontology;
  if (o.status === 'local') return '';
  if (o.status === 'loading')
    return '<div class="card source-bar" aria-live="polite">Loading the ontology from the Tiles API…</div>';
  if (o.status === 'error')
    return `<div class="card source-bar" role="alert"><b>Can't load the ontology from the Tiles API.</b> <span class="soft">${esc(o.error)}</span> <span class="row gap-2 mt-2">${ctx.auth.config?.enabled && !ctx.auth.signedIn ? '<button class="btn sm primary" data-sign-in>Sign in</button>' : ''}<a class="btn sm" href="#/settings">Data source settings</a></span></div>`;
  const { head, history, staged } = ctx.state.repo;
  const empty = !Object.keys(head.nodes).length && !history.length && !staged.length;
  return `<div class="card source-bar small" aria-live="polite">
      <span>Shared through the Tiles API · <b>${esc(o.site?.name)}</b> · everyone on this site sees each commit.${o.reviewRequired ? ' Every change needs a review.' : ''}${o.role === 'viewer' ? ' <span class="badge">View only</span>' : ''}</span>
      <span class="row gap-2">${empty ? '<button class="btn sm primary" data-import-demo>Load demo ontology</button>' : ''}<a class="btn sm" href="#/reviews">Change reviews</a><button class="btn sm" data-export="json">Export JSON</button><button class="btn sm" data-export="csv">Export CSV</button>${o.role === 'viewer' ? '' : `<label class="btn sm" ${staged.length ? 'aria-disabled="true" title="Commit or discard your staged changes first"' : ''}>Import file<input type="file" accept=".json,.csv,application/json,text/csv" data-import-file hidden ${staged.length ? 'disabled' : ''} /></label>`}<button class="btn sm" data-refresh>Refresh</button></span>
    </div>`;
}

const view: View = {
  id: 'ontology',
  title: 'Ontology builder',
  icon: 'network',
  render(ctx) {
    const ui = uiState(ctx);
    const { repo } = ctx.state;
    const graph = ctx.graph;
    const source = sourceBar(ctx);
    if (ctx.ontology.status === 'loading' || ctx.ontology.status === 'error') return pageHead() + source;
    const health = healthCheck(graph);
    if (ui.selected && !graph.nodes[ui.selected]) ui.selected = null;

    const { conflict } = safeWorkingGraph(repo);
    const stagedBar = conflict
      ? `<div class="staged-bar" role="alert">
          <span class="badge bad">${repo.staged.length} uncommitted</span>
          <span class="grow">Your staged changes no longer fit the latest commits (${esc(conflict)}). Discard them, then redo what you still need.</span>
          <button class="btn" type="button" data-discard>Discard</button>
        </div>`
      : repo.staged.length && ctx.ontology.role === 'viewer'
        ? // Staged before an admin made them a viewer: they can still throw it away.
          `<div class="staged-bar" id="viewer-staged">
          <span class="badge warn">${repo.staged.length} uncommitted</span>
          <span class="grow">You staged these changes before your role became viewer, so they can't be committed. Discard them to see the latest commit.</span>
          <button class="btn" type="button" data-discard>Discard</button>
        </div>`
        : repo.staged.length
          ? `<form class="staged-bar" id="commit-form">
          <span class="badge warn">${repo.staged.length} uncommitted</span>
          <span class="small soft">${statBadges(diffStats(repo.staged))}</span>
          <input type="text" name="message" placeholder="Describe this change, e.g. “add alarms node to ontology”" aria-label="Commit message" required />
          ${reviewControls(ctx)}
          <button class="btn" type="button" data-discard>Discard</button>
        </form>`
          : '';

    const tabs = [
      ['canvas', 'Canvas'],
      ['history', `History <span class="badge">${repo.history.length}</span>`],
      [
        'health',
        `Health <span class="badge ${health.issues.some((i) => i.level !== 'info') ? 'bad' : 'good'}">${health.score}</span>`,
      ],
    ];

    let body = '';
    if (ui.tab === 'canvas') body = canvas(ctx, graph, health, ui);
    if (ui.tab === 'history') body = history(ctx, graph);
    if (ui.tab === 'health') body = healthTab(health, graph);

    return `
      ${pageHead()}
      ${source}
      ${stagedBar}
      ${importCard(ctx)}
      <div class="tabs" role="tablist">${tabs.map(([id, label]) => `<button class="tab ${ui.tab === id ? 'active' : ''}" data-tab="${id}" role="tab">${label}</button>`).join('')}</div>
      ${body}`;
  },

  bind(root, ctx) {
    const ui = uiState(ctx);
    if (ctx.ontology.role === 'viewer') root.querySelectorAll(EDIT_CONTROLS).forEach((el) => el.remove());
    const author = ctx.state.user.email;
    const stageOps = (ops: Op[], ok?: string) => ctx.ontology.act((store, repo) => store.stage(repo, ops), ok);
    const stageOp = (op: Op, ok?: string) => stageOps([op], ok);
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
    root.querySelector<HTMLInputElement>('[data-import-file]')?.addEventListener('change', (e) => {
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
    });
    root.querySelector<HTMLSelectElement>('[data-import-mode]')?.addEventListener('change', (e) => {
      if (!pending) return;
      pending.mode = (e.target as HTMLSelectElement).value === 'replace' ? 'replace' : 'merge';
      void planImport(ctx);
    });
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
        .act(async (store) => {
          // Only what the preview showed: refused if someone committed since.
          const result = await api.ontology.importFile(p.site, { ...p, dryRun: false, expectCommit: shown.commit });
          if (pending === p) pending = null;
          if (!(store.kind === 'api' && 'load' in store)) throw new Error('Imports need the Tiles API');
          if (!result.staged) throw new Error('Nothing to change: the ontology already matches the file');
          return (store as RemoteStore).load();
        }, `Staged the changes from ${p.name}: commit them, or send them for review`)
        .then((ok) => {
          if (!ok && pending === p) void planImport(ctx); // show what it would change now
        });
    });
    onAll(root, '[data-sign-in]', 'click', () => void ctx.auth.signIn());
    onAll(root, '[data-import-demo]', 'click', async (el) => {
      el.setAttribute('disabled', '');
      const ops = historyOps(seedOntology());
      if (!(await stageOps(ops))) return;
      const message = 'Import demo ontology';
      if (ctx.ontology.reviewRequired)
        await ctx.ontology.act(
          (store, repo) => store.requestReview(repo, { message }),
          'Demo ontology sent for review',
        );
      else await ctx.ontology.act((store, repo) => store.commit(repo, message, author), 'Demo ontology imported');
    });
    const selected = (): string | null => ui.selected;

    onAll(root, '[data-tab]', 'click', (el) => {
      const tab = el.dataset.tab;
      if (tab === 'canvas' || tab === 'history' || tab === 'health') ui.tab = tab;
      ctx.rerender();
    });
    const select = (id: string | undefined) => {
      if (!id) return;
      ui.selected = id;
      ctx.rerender();
      const panel = document.getElementById('inspector');
      const r = panel?.getBoundingClientRect();
      if (panel && r && (r.top > window.innerHeight || r.bottom < 0))
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    onAll(root, '[data-node]', 'click', (el) => select(el.dataset.node));
    onAll(root, '[data-node]', 'keydown', (el, e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(el.dataset.node);
      }
    });
    bindCanvas(root, ctx, ui);
    onAll(root, '[data-goto]', 'click', (el, e) => {
      e.preventDefault();
      const id = el.dataset.goto;
      if (!id) return;
      reveal(ctx.graph, ui, id);
      ui.selected = id;
      ui.tab = 'canvas';
      centerAfterRender = id;
      ctx.rerender();
    });
    onAll(root, '[data-deselect]', 'click', () => {
      ui.selected = null;
      ctx.rerender();
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
      if (el.dataset.unlink) stageOp({ kind: 'removeEdge', id: el.dataset.unlink }, 'Relationship removal staged');
    });
    onAll(root, '[data-delete]', 'click', () => {
      const id = selected();
      if (!id) return;
      ui.selected = null;
      stageOp({ kind: 'removeNode', id }, 'Node deletion staged');
    });
    onAll(root, '[data-fix-delete]', 'click', (el) => {
      if (el.dataset.fixDelete) stageOp({ kind: 'removeNode', id: el.dataset.fixDelete }, 'Node deletion staged');
    });
    onAll(root, '[data-discard]', 'click', () =>
      ctx.ontology.act((store, repo) => store.discard(repo), 'Changes discarded'),
    );
    onAll(root, '[data-revert]', 'click', (el) => {
      const id = el.dataset.revert;
      if (!id) return;
      if (ctx.ontology.reviewRequired)
        void ctx.ontology.act((store, repo) => store.requestReview(repo, { reverts: id }), 'Revert sent for review');
      else void ctx.ontology.act((store, repo) => store.revert(repo, id, author), 'Commit reverted');
    });

    onSubmit(root, '#commit-form', (form, submitter) => {
      const message = field(form, 'message');
      // Enter in the message field submits with the first button: Commit, or Request review when it's the only one.
      const review = submitter ? submitter.hasAttribute('data-request-review') : !form.querySelector('[value=commit]');
      if (!review) {
        void ctx.ontology.act((store, repo) => store.commit(repo, message, author), 'Committed');
        return;
      }
      const reviewerId = field(form, 'reviewer') || undefined;
      void ctx.ontology.act((store, repo) => store.requestReview(repo, { message, reviewerId }), 'Sent for review');
    });
    onSubmit(root, '#prop-form', (form) => {
      const id = selected();
      if (!id) return;
      const key = field(form, 'key').trim();
      const raw = field(form, 'value').trim();
      const value = raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
      stageOp({ kind: 'setProp', id, key, value });
    });
    onSubmit(root, '#link-form', (form) => {
      const from = selected();
      if (!from) return;
      const rel = field(form, 'rel');
      const to = field(form, 'to');
      stageOp({ kind: 'addEdge', edge: { id: `${from}-${rel}-${to}`, from, rel, to } });
    });
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
      void stageOps(ops, 'Node staged — commit to save it').then((ok) => {
        if (ok) {
          ui.selected = id;
          ctx.rerender();
        }
      });
    });
  },
};

export default view;
