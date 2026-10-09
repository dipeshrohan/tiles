// Lookups over an ontology graph by relationship, built once per graph object and cached: the
// Shopfloor and Plant pages walk the hierarchy for every machine they show.

import type { Graph } from './types.ts';

// The graph's edges by relationship and end, built once per graph (each render has its own):
// lookups are then constant time, however many machines and warnings the page shows. Graphs are
// never changed in place (applyOp makes a new one), so a cached index stays true.
interface Index {
  to: Map<string, string[]>; // `${rel}|${to}` → the nodes it comes from, sorted
  from: Map<string, string[]>; // `${rel}|${from}` → the nodes it goes to, sorted
  byTag: Map<string, string>; // a Signal node's `tag` property → its id (the first by id)
  byLabel: Map<string, string>; // a Signal node's label → its id (the first by id)
}

const indexes = new WeakMap<Graph, Index>();

function indexOf(graph: Graph): Index {
  const cached = indexes.get(graph);
  if (cached) return cached;
  const add = (map: Map<string, string[]>, key: string, id: string) => {
    const list = map.get(key);
    if (list) list.push(id);
    else map.set(key, [id]);
  };
  const index: Index = { to: new Map(), from: new Map(), byTag: new Map(), byLabel: new Map() };
  for (const e of Object.values(graph.edges)) {
    if (!graph.nodes[e.from] || !graph.nodes[e.to]) continue; // dangling: the health check's business
    add(index.to, `${e.rel}|${e.to}`, e.from);
    add(index.from, `${e.rel}|${e.from}`, e.to);
  }
  for (const list of [...index.to.values(), ...index.from.values()]) list.sort();
  const signals = Object.values(graph.nodes)
    .filter((n) => n.type === 'Signal')
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const n of signals) {
    const tag = n.props['tag'];
    if (typeof tag === 'string' && !index.byTag.has(tag)) index.byTag.set(tag, n.id);
    if (!index.byLabel.has(n.label)) index.byLabel.set(n.label, n.id);
  }
  indexes.set(graph, index);
  return index;
}

export const incoming = (graph: Graph, to: string, rel: string): string[] =>
  indexOf(graph).to.get(`${rel}|${to}`) ?? [];
export const outgoing = (graph: Graph, from: string, rel: string): string[] =>
  indexOf(graph).from.get(`${rel}|${from}`) ?? [];

// A Signal node by its `tag` property, or by its label (the first by id when several share one).
export const signalByTag = (graph: Graph, tag: string): string | undefined => indexOf(graph).byTag.get(tag);
export const signalByLabel = (graph: Graph, label: string): string | undefined => indexOf(graph).byLabel.get(label);
