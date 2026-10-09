// The shopfloor view's logic (T5.16), apart from the page: where on the line a warning is (its
// signal's machine in the ontology), the order a shift works through warnings in, the board of
// machines with the worst state of each, and the line that says how things stand.

import type { WarningInfo } from './api.ts';
import { incoming, outgoing, signalByLabel, signalByTag } from './graph-index.ts';
import type { Graph, OntologyNode } from './types.ts';

// How a warning stands on the floor, worst first.
export type FloorState = 'out' | 'new' | 'taken' | 'ok';

export interface FloorItem {
  id: string;
  tag: string; // the signal, or what the local demo detector watches
  machineId: string | null; // the Machine node, when the ontology places it
  machine: string; // its label, or the tag when nothing places it
  path: string[]; // the hierarchy above the machine, top first, without the site: e.g. Workcenter, Line
  state: FloorState;
  status: WarningInfo['status'];
  out: boolean; // the signal is still out
  startedAt: string | null; // null for the local demo, which counts shots rather than time
  endedAt: string | null;
  assignee: string | null;
  assigneeId: string | null;
  detail: string; // how far out it went, in words
}

const isMachine = (graph: Graph, id: string): boolean => graph.nodes[id]?.type === 'Machine';

// The hierarchy parent (`contains`), if any.
const parentOf = (graph: Graph, id: string): string | null => incoming(graph, id, 'contains')[0] ?? null;

// The machine a node belongs to:
// - a Machine is its own;
// - a Signal is its PLC's (PLC emits Signal, Machine controlledBy PLC);
// - a PLC is its machine's;
// - a Model is the machine it monitors.
// Otherwise, the nearest Machine above it in the hierarchy.
export function machineOf(graph: Graph, id: string): string | null {
  const node = graph.nodes[id];
  if (!node) return null;
  if (node.type === 'Machine') return id;
  const plcs = node.type === 'Signal' ? incoming(graph, id, 'emits') : node.type === 'PLC' ? [id] : [];
  for (const plc of plcs) {
    const machine = incoming(graph, plc, 'controlledBy').find((m) => isMachine(graph, m));
    if (machine) return machine;
  }
  if (node.type === 'Model') {
    const machine = outgoing(graph, id, 'monitors').find((m) => isMachine(graph, m));
    if (machine) return machine;
  }
  const seen = new Set([id]);
  for (let up = parentOf(graph, id); up && !seen.has(up); up = parentOf(graph, up)) {
    if (isMachine(graph, up)) return up;
    seen.add(up);
  }
  return null;
}

// The labels above a node in the hierarchy, top first, leaving out the enterprise and the site
// (the page names the site once).
export function pathOf(graph: Graph, id: string): string[] {
  const path: string[] = [];
  const seen = new Set([id]);
  for (let up = parentOf(graph, id); up && !seen.has(up); up = parentOf(graph, up)) {
    const node = graph.nodes[up];
    if (node && node.type !== 'Site' && node.type !== 'Enterprise') path.unshift(node.label);
    seen.add(up);
  }
  return path;
}

// The Signal node a tag stands for:
// - the signal catalogue's link (`links`: tag to node id);
// - a Signal node whose `tag` property is the tag (made from a mapping suggestion);
// - or one whose label is the tag.
export function nodeForTag(graph: Graph, tag: string, links: ReadonlyMap<string, string>): string | null {
  const linked = links.get(tag);
  if (linked && graph.nodes[linked]) return linked;
  return signalByTag(graph, tag) ?? signalByLabel(graph, tag) ?? null;
}

export function stateOf(w: Pick<WarningInfo, 'status' | 'ended_at'>): FloorState {
  if (w.status === 'resolved') return 'ok';
  if (!w.ended_at) return 'out';
  return w.status === 'raised' ? 'new' : 'taken';
}

const RANK: Record<FloorState, number> = { out: 0, new: 1, taken: 2, ok: 3 };

// Where a warning stands in the API's terms, as the floor reads it.
export function placeWarning(
  graph: Graph,
  w: WarningInfo,
  links: ReadonlyMap<string, string>,
  detail: string,
): FloorItem {
  const node = nodeForTag(graph, w.signal_tag, links);
  const machineId = node ? machineOf(graph, node) : null;
  const machine = machineId ? graph.nodes[machineId] : undefined;
  return {
    id: w.id,
    tag: w.signal_tag,
    machineId,
    machine: machine?.label ?? w.signal_tag,
    path: machineId ? pathOf(graph, machineId) : [],
    state: stateOf(w),
    status: w.status,
    out: !w.ended_at,
    startedAt: w.started_at,
    endedAt: w.ended_at,
    assignee: w.assignee,
    assigneeId: w.assignee_id,
    detail,
  };
}

// The order a shift works through warnings in:
// - signals still out first;
// - then the ones nobody has taken;
// - then the newest first.
export function floorOrder(a: FloorItem, b: FloorItem): number {
  return (
    RANK[a.state] - RANK[b.state] || (b.startedAt ?? '').localeCompare(a.startedAt ?? '') || a.id.localeCompare(b.id)
  );
}

export interface MachineTile {
  id: string;
  label: string;
  path: string[];
  state: FloorState; // the worst of its warnings; ok without any
  warnings: number;
}

// Every machine of the ontology with the worst state of its open warnings: machines with warnings
// first (worst first), then by where they are (workcenter, line, then name; "Line 2" before
// "Line 10"). The ontology keeps no order of its own between siblings.
export function machineBoard(graph: Graph, items: readonly FloorItem[]): MachineTile[] {
  const open = new Map<string, FloorItem[]>();
  for (const i of items) {
    if (i.machineId === null || i.state === 'ok') continue;
    open.set(i.machineId, [...(open.get(i.machineId) ?? []), i]);
  }
  const machines = Object.values(graph.nodes).filter((n): n is OntologyNode => n.type === 'Machine');
  const tiles = machines.map((m) => {
    const mine = open.get(m.id) ?? [];
    const state = mine.reduce<FloorState>((worst, i) => (RANK[i.state] < RANK[worst] ? i.state : worst), 'ok');
    return { id: m.id, label: m.label, path: pathOf(graph, m.id), state, warnings: mine.length };
  });
  const where = (t: MachineTile) => [...t.path, t.label].join('\u0000');
  const collator = new Intl.Collator('en', { numeric: true });
  return tiles.sort((a, b) => RANK[a.state] - RANK[b.state] || collator.compare(where(a), where(b)));
}

// The page's headline: what needs someone now.
export function headline(items: readonly FloorItem[]): { tone: 'bad' | 'warn' | 'good'; text: string } {
  const open = items.filter((i) => i.state !== 'ok');
  const out = open.filter((i) => i.state === 'out').length;
  const untaken = open.filter((i) => i.status === 'raised').length;
  if (!open.length) return { tone: 'good', text: 'All clear: no open warnings' };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [out ? `${plural(out, 'signal')} still out` : '', untaken ? `${untaken} nobody has taken` : ''].filter(
    Boolean,
  );
  return {
    tone: out || untaken ? 'bad' : 'warn',
    text: `${plural(open.length, 'open warning')}${parts.length ? `: ${parts.join(', ')}` : ''}`,
  };
}
