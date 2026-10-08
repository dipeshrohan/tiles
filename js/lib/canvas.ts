// The ontology canvas at scale (T2.14): which nodes show (hierarchy collapsed,
// types hidden), where each goes, and the visible part of the drawing (zoom
// and pan as a view box). Pure, so it is unit-tested; the Ontology page draws
// the result as SVG.

import type { Graph, NodeType } from './types.ts';

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
export const BOX = { w: 134, h: 28, colGap: 152, subGap: 146, rowGap: 38, pad: 16 };

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

// How many nodes collapsing `id` hides (what its badge shows).
export function hiddenUnder(graph: Graph, id: string, h = hierarchy(graph)): number {
  return hiddenByCollapse(graph, new Set([id]), h).size;
}

// Nodes with children: the ones that can be collapsed.
export function collapsible(h: Hierarchy): string[] {
  return [...h.children.keys()];
}

export type Point = { x: number; y: number };

export interface Layout {
  pos: Map<string, Point>;
  width: number;
  height: number;
}

// Rows per sub-column: tall columns wrap so the drawing stays roughly as wide as tall.
export function rowsPerColumn(visible: number): number {
  return Math.max(24, Math.ceil(Math.sqrt(visible) * 1.6));
}

// Places the visible nodes in their type's column, each ordered by the average row of its
// already-placed neighbours (fewer crossings), wrapping long columns into sub-columns.
export function layout(graph: Graph, show: (id: string) => boolean, h = hierarchy(graph)): Layout {
  const pos = new Map<string, Point>();
  const visible = Object.values(graph.nodes).filter((n) => show(n.id));
  const rows = rowsPerColumn(visible.length);
  let x = BOX.pad;
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
    ordered.forEach(({ n }, i) => {
      const sub = Math.floor(i / rows);
      const y = BOX.pad + (i % rows) * BOX.rowGap;
      pos.set(n.id, { x: x + sub * BOX.subGap, y });
      maxY = Math.max(maxY, y);
    });
    x += BOX.colGap + (Math.ceil(ordered.length / rows) - 1) * BOX.subGap;
  }
  return { pos, width: x - BOX.colGap + BOX.w + BOX.pad, height: maxY + BOX.h + BOX.pad };
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
export function centerOn(view: View, p: Point, readableWidth = 1400): View {
  const w = Math.min(view.w, readableWidth);
  const h = view.h * (w / view.w);
  return { x: p.x + BOX.w / 2 - w / 2, y: p.y + BOX.h / 2 - h / 2, w, h };
}

// ---- search ------------------------------------------------------------------------

// Nodes whose label or id contains every word of the query, best first: label starts with it,
// then shorter labels.
export function searchNodes(graph: Graph, query: string, limit = 500): string[] {
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

// What to un-collapse so `id` shows: its collapsed ancestors along every hidden path.
export function revealPath(graph: Graph, id: string, collapsed: ReadonlySet<string>, h = hierarchy(graph)): string[] {
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
