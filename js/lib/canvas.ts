// The ontology canvas at scale (T2.14): which nodes show (hierarchy collapsed,
// types hidden), where each goes, and the visible part of the drawing (zoom
// and pan as a view box). Pure, so it is unit-tested; the Ontology page draws
// the result as SVG.

import type { Graph, NodeType, OntologyNode } from './types.ts';

// Node types by column, left to right: the plant hierarchy, then what hangs off it.
export const COLUMNS: NodeType[][] = [
  ['Enterprise', 'Site'],
  ['Workcenter'],
  ['Line', 'Cell'],
  ['Machine'],
  ['Process', 'PLC'],
  ['Material', 'Signal'],
  ['Document', 'Model'],
];
// A node's box: `w` is a column's narrowest; a column widens to its longest label, up to `maxW`
// (review H-14), keeping the gaps between columns (colGap − w) and sub-columns (subGap − w).
export const BOX = { w: 134, maxW: 240, h: 28, colGap: 152, subGap: 146, rowGap: 38, pad: 16 };

// Relationships that make a hierarchy: collapsing a node hides what these lead to from it
// (a line's machines, a machine's PLC, a PLC's signals).
export const CHILD_RELS = new Set(['contains', 'controlledBy', 'emits']);

export interface Hierarchy {
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
  adjacent: Map<string, string[]>; // every neighbour, for ordering
}

export function hierarchy(graph: Graph): Hierarchy {
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const adjacent = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const e of Object.values(graph.edges)) {
    if (!graph.nodes[e.from] || !graph.nodes[e.to] || e.from === e.to) continue;
    push(adjacent, e.from, e.to);
    push(adjacent, e.to, e.from);
    if (CHILD_RELS.has(e.rel)) {
      push(parents, e.to, e.from);
      push(children, e.from, e.to);
    }
  }
  return { parents, children, adjacent };
}

// Nodes hidden by collapsing: those under a collapsed node with no way down from a visible,
// expanded parent. A node shared with an expanded branch stays; a collapsed node itself shows
// unless something above it hides it. (A loop of containment with no way in from outside is
// hidden whole, as nothing above it shows; "Expand all" brings it back.)
export function hiddenByCollapse(graph: Graph, collapsed: ReadonlySet<string>, h = hierarchy(graph)): Set<string> {
  if (!collapsed.size) return new Set();
  // Only nodes below a collapsed one can be hidden.
  const below = new Set<string>();
  const queue = [...collapsed];
  for (let id = queue.pop(); id !== undefined; id = queue.pop())
    for (const child of h.children.get(id) ?? [])
      if (!below.has(child)) {
        below.add(child);
        queue.push(child);
      }
  // Visible: everything else, then whatever a visible expanded parent leads to.
  const shown = (id: string) => !below.has(id) || reached.has(id);
  const reached = new Set<string>();
  const open = [...Object.keys(graph.nodes)].filter((id) => !below.has(id) && !collapsed.has(id));
  for (let id = open.pop(); id !== undefined; id = open.pop())
    for (const child of h.children.get(id) ?? [])
      if (below.has(child) && !reached.has(child)) {
        reached.add(child);
        if (!collapsed.has(child)) open.push(child);
      }
  return new Set([...below].filter((id) => !shown(id)));
}

// How many nodes collapsing `id` alone would hide (the inspector's "Fold its N").
export function hiddenUnder(graph: Graph, id: string, h = hierarchy(graph)): number {
  return hiddenByCollapse(graph, new Set([id]), h).size;
}

// For each collapsed node that shows, how many hidden nodes are below it (its badge).
export function foldedCounts(
  collapsed: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
  h: Hierarchy,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of collapsed) {
    if (hidden.has(id)) continue;
    const seen = new Set<string>();
    const queue = [...(h.children.get(id) ?? [])];
    for (let cur = queue.pop(); cur !== undefined; cur = queue.pop())
      if (hidden.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        queue.push(...(h.children.get(cur) ?? []));
      }
    counts.set(id, seen.size);
  }
  return counts;
}

// Nodes with children: the ones that can be collapsed.
export function collapsible(h: Hierarchy): string[] {
  return [...h.children.keys()];
}

export type Point = { x: number; y: number };
// A node's place: its box's top left, and its width (its column's; BOX.w when not given).
export type Placed = Point & { w?: number };
export const widthOf = (p: Placed): number => p.w ?? BOX.w;

export interface Layout {
  pos: Map<string, Point & { w: number }>;
  width: number;
  height: number;
}

// Rows per sub-column: tall columns wrap so the drawing stays roughly as wide as tall.
export function rowsPerColumn(visible: number): number {
  return Math.max(24, Math.ceil(Math.sqrt(visible) * 1.6));
}

// Places the visible nodes in their type's column, each ordered by the average row of its
// already-placed neighbours (fewer crossings), wrapping long columns into sub-columns. `need` is
// the width a node's box needs to show its label whole: its column is as wide as the widest of
// them, between BOX.w and BOX.maxW.
export function layout(
  graph: Graph,
  show: (id: string) => boolean,
  h = hierarchy(graph),
  need?: (n: OntologyNode) => number,
): Layout {
  const pos = new Map<string, Point & { w: number }>();
  const visible = Object.values(graph.nodes).filter((n) => show(n.id));
  const rows = rowsPerColumn(visible.length);
  let x = BOX.pad;
  let maxX = 0;
  let maxY = 0;
  for (const types of COLUMNS) {
    const col = visible.filter((n) => types.includes(n.type));
    if (!col.length) {
      x += BOX.colGap;
      continue;
    }
    const weight = (id: string) => {
      let sum = 0;
      let n = 0;
      for (const other of h.adjacent.get(id) ?? []) {
        const p = pos.get(other);
        if (p) {
          sum += p.y + p.x / 1000; // a node's row, sub-columns kept apart
          n++;
        }
      }
      return n ? sum / n : Infinity;
    };
    const ordered = col
      .map((n) => ({ n, w: weight(n.id), t: types.indexOf(n.type) }))
      .sort((a, b) => a.t - b.t || a.w - b.w || a.n.label.localeCompare(b.n.label));
    let w = BOX.w;
    if (need) for (const n of col) w = Math.max(w, Math.ceil(need(n)));
    w = Math.min(w, BOX.maxW);
    const subGap = w + BOX.subGap - BOX.w;
    ordered.forEach(({ n }, i) => {
      const sub = Math.floor(i / rows);
      const y = BOX.pad + (i % rows) * BOX.rowGap;
      pos.set(n.id, { x: x + sub * subGap, y, w });
      maxX = Math.max(maxX, x + sub * subGap + w);
      maxY = Math.max(maxY, y);
    });
    x += w + BOX.colGap - BOX.w + (Math.ceil(ordered.length / rows) - 1) * subGap;
  }
  // As wide as the rightmost node: types with no nodes leave no blank strip.
  return { pos, width: maxX + BOX.pad, height: maxY + BOX.h + BOX.pad };
}

// A label as drawn in `room` units of width (review H-14): whole when it fits; else the most whole
// words from its start that fit with `ellipsis` after them, and `cut` (the page draws the ellipsis
// as a shape). Words, not letters: a node's visible words stay words of its accessible name (axe's
// label-content-name-mismatch). A first word too long for the room is kept whole, to be clipped.
export function fitLabel(
  label: string,
  room: number,
  measure: (text: string) => number,
  ellipsis: number,
): { text: string; cut: boolean } {
  if (measure(label) <= room) return { text: label, cut: false };
  const ends: number[] = [];
  for (let i = label.indexOf(' '); i !== -1; i = label.indexOf(' ', i + 1)) if (i > 0) ends.push(i);
  let text = label.slice(0, ends[0] ?? label.length).trimEnd();
  for (const end of ends.slice(1)) {
    const longer = label.slice(0, end).trimEnd();
    if (measure(longer) + ellipsis > room) break;
    text = longer;
  }
  return { text, cut: true };
}

// ---- the visible part: a view box in drawing coordinates ------------------------

export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_VIEW_WIDTH = 240; // fully zoomed in: about two columns across

// The canvas height for a drawing in a container `containerWidth` pixels wide: the drawing at
// its fitted scale (at most MAX_FIT_SCALE), between `min` and `max` pixels.
export function canvasHeight(width: number, height: number, containerWidth: number, min: number, max: number): number {
  const scale = Math.min(MAX_FIT_SCALE, containerWidth / Math.max(1, width));
  return Math.round(Math.min(max, Math.max(min, height * scale)));
}

export const MAX_FIT_SCALE = 1.5; // fitting never enlarges a small drawing more than this (like charts)

// The whole drawing in a viewport of the given aspect (width / height), centred. `minWidth`
// keeps a small drawing from being blown up: pass the viewport's pixel width / MAX_FIT_SCALE.
export function fitView(width: number, height: number, aspect: number, minWidth = MIN_VIEW_WIDTH): View {
  const w = Math.max(width, height * aspect, minWidth, MIN_VIEW_WIDTH);
  const h = w / aspect;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

// Zooms by `factor` (above 1 zooms in) keeping the drawing point `at` where it is on screen.
export function zoomAt(view: View, factor: number, at: Point, limit: { width: number; height: number }): View {
  const most = Math.max(limit.width, limit.height * (view.w / view.h)) * 2;
  const w = Math.min(most, Math.max(MIN_VIEW_WIDTH, view.w / factor));
  const k = w / view.w;
  const h = view.h * k;
  return { x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k, w, h };
}

export function panBy(view: View, dx: number, dy: number): View {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

// The view moved so `p` is at its centre, zoomed in enough to read labels.
export function centerOn(view: View, p: Placed, readableWidth = 1400): View {
  const w = Math.min(view.w, readableWidth);
  const h = view.h * (w / view.w);
  return { x: p.x + widthOf(p) / 2 - w / 2, y: p.y + BOX.h / 2 - h / 2, w, h };
}

// ---- search ------------------------------------------------------------------------

// Nodes whose label or id contains every word of the query, best first: label starts with it,
// then shorter labels.
export function searchNodes(graph: Graph, query: string, limit = Infinity): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const q = words.join(' ');
  const hits: { id: string; rank: number; label: string }[] = [];
  for (const n of Object.values(graph.nodes)) {
    const text = `${n.label} ${n.id}`.toLowerCase();
    if (!words.every((w) => text.includes(w))) continue;
    const label = n.label.toLowerCase();
    hits.push({ id: n.id, rank: label === q ? 0 : label.startsWith(q) ? 1 : 2, label: n.label });
  }
  return hits
    .sort((a, b) => a.rank - b.rank || a.label.length - b.label.length || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map((hit) => hit.id);
}

// What to un-collapse so `id` shows: nothing if it shows already, else its collapsed ancestors
// along every path down to it.
export function revealPath(graph: Graph, id: string, collapsed: ReadonlySet<string>, h = hierarchy(graph)): string[] {
  if (!hiddenByCollapse(graph, collapsed, h).has(id)) return [];
  const out = new Set<string>();
  const seen = new Set<string>([id]);
  const queue = [id];
  for (let cur = queue.pop(); cur !== undefined; cur = queue.pop())
    for (const p of h.parents.get(cur) ?? []) {
      if (collapsed.has(p)) out.add(p);
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  return [...out];
}

// ---- the builder (U5.05): keyboard moves, box selection, focus, the minimap, drag to relate --------

export type Direction = 'left' | 'right' | 'up' | 'down';

// The node an arrow key moves to from `from`: the nearest one on that side, a node straight
// across counting for more than one off to the side. Null at the edge.
export function stepFrom(pos: ReadonlyMap<string, Placed>, from: string, dir: Direction): string | null {
  const a = pos.get(from);
  if (!a) return null;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [id, b] of pos) {
    if (id === from) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const ahead = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const aside = dir === 'right' || dir === 'left' ? Math.abs(dy) : Math.abs(dx);
    if (ahead <= 0) continue;
    const score = ahead + aside * 3;
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Nodes a dragged box touches, in drawing coordinates (the box from any corner).
export function inBox(pos: ReadonlyMap<string, Placed>, box: Box): string[] {
  const x0 = Math.min(box.x, box.x + box.w);
  const x1 = Math.max(box.x, box.x + box.w);
  const y0 = Math.min(box.y, box.y + box.h);
  const y1 = Math.max(box.y, box.y + box.h);
  const out: string[] = [];
  for (const [id, p] of pos) if (p.x < x1 && p.x + widthOf(p) > x0 && p.y < y1 && p.y + BOX.h > y0) out.push(id);
  return out;
}

// The view that shows the given nodes (focus selection), with a margin, in a viewport of
// `aspect`; never closer than MIN_VIEW_WIDTH. Null when none of them is drawn.
export function focusView(
  pos: ReadonlyMap<string, Placed>,
  ids: Iterable<string>,
  aspect: number,
  margin = 48,
): View | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids) {
    const p = pos.get(id);
    if (!p) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + widthOf(p));
    y1 = Math.max(y1, p.y + BOX.h);
  }
  if (x0 === Infinity) return null;
  const width = x1 - x0 + margin * 2;
  const height = y1 - y0 + margin * 2;
  const fit = fitView(width, height, aspect);
  return { x: x0 - margin + fit.x, y: y0 - margin + fit.y, w: fit.w, h: fit.h };
}

// The minimap's nodes as one path (2,000 rectangles as one element stay cheap to draw).
export function minimapPath(pos: ReadonlyMap<string, Placed>): string {
  let d = '';
  for (const p of pos.values()) {
    const w = widthOf(p);
    d += `M${p.x} ${p.y}h${w}v${BOX.h}h-${w}z`;
  }
  return d;
}

// The relationship a drag from one node to another most likely means, by their types (the
// hierarchy of docs/data-model.md); the person can change it before adding it.
export function likelyRel(from: NodeType, to: NodeType): string {
  const level = (t: NodeType) => COLUMNS.findIndex((types) => types.includes(t));
  if (from === 'Document') return 'describes';
  if (from === 'Model') return to === 'Signal' ? 'reads' : 'monitors';
  if (from === 'PLC' && to === 'Signal') return 'emits';
  if ((from === 'Machine' || from === 'Cell' || from === 'Line') && to === 'PLC') return 'controlledBy';
  if ((from === 'Machine' || from === 'Line' || from === 'Cell') && to === 'Process') return 'runs';
  if (from === 'Process' && to === 'Material') return 'consumes';
  if (from === to) return 'feeds';
  return level(from) < level(to) ? 'contains' : 'feeds';
}

// The type a new node most likely has under `parent` (review H-22): the next equipment level down,
// a machine's PLC, a PLC's signal, a process's material; a Machine with no parent or none of these.
const CHILD: Partial<Record<NodeType, NodeType>> = {
  Enterprise: 'Site',
  Site: 'Workcenter',
  Workcenter: 'Line',
  Line: 'Machine',
  Cell: 'Machine',
  Machine: 'PLC',
  PLC: 'Signal',
  Process: 'Material',
};
export const likelyChild = (parent: NodeType | null | undefined): NodeType => (parent && CHILD[parent]) || 'Machine';
