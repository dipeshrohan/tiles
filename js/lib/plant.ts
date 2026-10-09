// The Plant page's logic (T5.17), apart from the page: the site → workcenter → line → machine
// hierarchy of the ontology (`contains` between hierarchy nodes) as places to drill into, what a
// machine has (its PLCs and their signals, processes and materials, documents, models, and the
// machines it feeds), finding a place by name, and the open warnings rolled up to each place.

import { HIERARCHY } from './ontology.ts';
import { incoming, outgoing } from './graph-index.ts';
import type { FloorItem, FloorState } from './shopfloor.ts';
import type { Graph, OntologyNode } from './types.ts';

const collator = new Intl.Collator('en', { numeric: true }); // "Line 2" before "Line 10"

const isPlace = (graph: Graph, id: string): boolean => {
  const node = graph.nodes[id];
  return node !== undefined && HIERARCHY.includes(node.type);
};

const byLabel = (graph: Graph) => (a: string, b: string) =>
  collator.compare(graph.nodes[a]?.label ?? a, graph.nodes[b]?.label ?? b) || a.localeCompare(b);

const nodes = (graph: Graph, ids: readonly string[]): OntologyNode[] =>
  ids.flatMap((id) => (graph.nodes[id] ? [graph.nodes[id]] : [])).sort((a, b) => byLabel(graph)(a.id, b.id));

// The place a place is in (its first `contains` parent that is a place), if any.
export function parentPlace(graph: Graph, id: string): string | null {
  return incoming(graph, id, 'contains').find((p) => isPlace(graph, p)) ?? null;
}

// The places at the top: hierarchy nodes no place contains (usually the site, or the sites).
export function topPlaces(graph: Graph): string[] {
  return Object.keys(graph.nodes)
    .filter((id) => isPlace(graph, id) && parentPlace(graph, id) === null)
    .sort(byLabel(graph));
}

// The places a place contains, by name.
export function placesIn(graph: Graph, id: string): string[] {
  return outgoing(graph, id, 'contains')
    .filter((c) => isPlace(graph, c) && parentPlace(graph, c) === id)
    .sort(byLabel(graph));
}

// The places above a place, top first, then the place itself.
export function trail(graph: Graph, id: string): OntologyNode[] {
  const path: OntologyNode[] = [];
  const seen = new Set<string>();
  for (let at: string | null = id; at && !seen.has(at); at = parentPlace(graph, at)) {
    const node = graph.nodes[at];
    if (!node) break;
    path.unshift(node);
    seen.add(at);
  }
  return path;
}

// Every machine at or under a place.
export function machinesUnder(graph: Graph, id: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const at = stack.pop() ?? '';
    if (seen.has(at) || !graph.nodes[at]) continue;
    seen.add(at);
    if (graph.nodes[at]?.type === 'Machine') found.push(at);
    stack.push(...placesIn(graph, at));
  }
  return found.sort(byLabel(graph));
}

export interface MachineSheet {
  plcs: { plc: OntologyNode; signals: OntologyNode[] }[];
  signals: OntologyNode[]; // signals the machine contains itself, not through a PLC
  processes: { process: OntologyNode; materials: OntologyNode[] }[];
  documents: OntologyNode[];
  models: OntologyNode[]; // models that monitor it
  feedsFrom: OntologyNode[]; // what feeds it material
  feedsTo: OntologyNode[]; // what it feeds
  parts: OntologyNode[]; // anything else it contains
}

// What a machine has, as the ontology tells it.
export function machineSheet(graph: Graph, id: string): MachineSheet {
  const contained = nodes(graph, outgoing(graph, id, 'contains'));
  return {
    plcs: nodes(graph, outgoing(graph, id, 'controlledBy')).map((plc) => ({
      plc,
      signals: nodes(graph, outgoing(graph, plc.id, 'emits')),
    })),
    signals: contained.filter((n) => n.type === 'Signal'),
    processes: nodes(graph, outgoing(graph, id, 'runs')).map((process) => ({
      process,
      materials: nodes(graph, outgoing(graph, process.id, 'consumes')),
    })),
    documents: nodes(graph, incoming(graph, id, 'describes')),
    models: nodes(graph, incoming(graph, id, 'monitors')),
    feedsFrom: nodes(graph, incoming(graph, id, 'feeds')),
    feedsTo: nodes(graph, outgoing(graph, id, 'feeds')),
    parts: contained.filter((n) => n.type !== 'Signal'),
  };
}

// Places whose name has every word of `query` (any case), best first: names that start with it,
// then by depth and name. Each with the names above it.
export function findPlaces(
  graph: Graph,
  query: string,
  limit = 20,
): { id: string; label: string; type: string; path: string[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const q = words.join(' ');
  return Object.values(graph.nodes)
    .filter((n) => HIERARCHY.includes(n.type) && words.every((w) => n.label.toLowerCase().includes(w)))
    .map((n) => {
      const path = trail(graph, n.id)
        .slice(0, -1)
        .map((p) => p.label);
      return { id: n.id, label: n.label, type: n.type, path, starts: n.label.toLowerCase().startsWith(q) };
    })
    .sort(
      (a, b) =>
        Number(b.starts) - Number(a.starts) ||
        a.path.length - b.path.length ||
        collator.compare(a.label, b.label) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit)
    .map(({ starts: _starts, ...hit }) => hit);
}

const RANK: Record<FloorState, number> = { out: 0, new: 1, taken: 2, ok: 3 };

// The open warnings of the machines at or under a place, and the worst of their states. `under`:
// the place's machines, when the caller has them already.
export function rollUp(
  graph: Graph,
  items: readonly FloorItem[],
  id: string,
  under: readonly string[] = machinesUnder(graph, id),
): { state: FloorState; warnings: FloorItem[] } {
  const machines = new Set(under);
  const warnings = items.filter((i) => i.machineId !== null && machines.has(i.machineId) && i.state !== 'ok');
  const state = warnings.reduce<FloorState>((worst, i) => (RANK[i.state] < RANK[worst] ? i.state : worst), 'ok');
  return { state, warnings };
}

// The place a `#/plant/<id>` link opens; null for the page itself.
export function placeFromHash(hash: string): string | null {
  const m = hash.match(/^#\/plant\/([^?]+)/i); // the router reads routes in any case
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null; // a broken link opens the top
  }
}

export const placeLink = (id: string): string => `#/plant/${encodeURIComponent(id)}`;
