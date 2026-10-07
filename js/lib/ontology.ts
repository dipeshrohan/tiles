// Factory ontology: a typed graph plus Git-like change management.
// Edits are staged as operations, committed with a message and author,
// and any commit can be reverted by replaying its inverse operations.

import type {
  Commit,
  DiffStats,
  Graph,
  HealthIssue,
  HealthReport,
  Neighbor,
  NodeType,
  OntologyNode,
  Op,
  Repo,
} from './types.ts';

export const NODE_TYPES: Record<NodeType, { color: string; required: string[] }> = {
  Enterprise: { color: '#173f3c', required: [] },
  Site: { color: '#1f5f5b', required: ['location'] },
  Workcenter: { color: '#2f7d6d', required: [] },
  Line: { color: '#4b9b8a', required: [] },
  Cell: { color: '#5fae9b', required: [] },
  Machine: { color: '#c0603a', required: ['vendor'] },
  Process: { color: '#7b5ea7', required: [] },
  Material: { color: '#b88a1b', required: [] },
  PLC: { color: '#4a6fa5', required: ['protocol'] },
  Signal: { color: '#5d8aa8', required: ['unit'] },
  Document: { color: '#8a8a7a', required: [] },
  Model: { color: '#a23b5a', required: [] },
};

// ISA-95 equipment levels, top down (Line and Cell are both work centres).
export const HIERARCHY: NodeType[] = ['Enterprise', 'Site', 'Workcenter', 'Line', 'Cell', 'Machine'];

const isNodeType = (t: string): t is NodeType => Object.prototype.hasOwnProperty.call(NODE_TYPES, t);

export function emptyGraph(): Graph {
  return { nodes: {}, edges: {} };
}

const clone = (g: Graph): Graph => ({ nodes: { ...g.nodes }, edges: { ...g.edges } });

// Apply one op and return { graph, inverse }. Throws on invalid ops so bad
// changes never reach a commit.
export function applyOp(graph: Graph, op: Op): { graph: Graph; inverse: Op } {
  const g = clone(graph);
  switch (op.kind) {
    case 'addNode': {
      if (g.nodes[op.node.id]) throw new Error(`Node ${op.node.id} already exists`);
      if (!isNodeType(op.node.type)) throw new Error(`Unknown node type ${op.node.type}`);
      g.nodes[op.node.id] = { ...op.node, props: op.node.props ?? {} };
      return { graph: g, inverse: { kind: 'removeNode', id: op.node.id } };
    }
    case 'removeNode': {
      const node = g.nodes[op.id];
      if (!node) throw new Error(`Node ${op.id} not found`);
      const attached = Object.values(g.edges).filter((e) => e.from === op.id || e.to === op.id);
      if (attached.length) throw new Error(`Node ${op.id} still has ${attached.length} relationship(s)`);
      delete g.nodes[op.id];
      return { graph: g, inverse: { kind: 'addNode', node } };
    }
    case 'addEdge': {
      const e = op.edge;
      if (g.edges[e.id]) throw new Error(`Relationship ${e.id} already exists`);
      if (!g.nodes[e.from] || !g.nodes[e.to]) throw new Error(`Relationship ${e.id} points at a missing node`);
      g.edges[e.id] = { ...e };
      return { graph: g, inverse: { kind: 'removeEdge', id: e.id } };
    }
    case 'removeEdge': {
      const edge = g.edges[op.id];
      if (!edge) throw new Error(`Relationship ${op.id} not found`);
      delete g.edges[op.id];
      return { graph: g, inverse: { kind: 'addEdge', edge } };
    }
    case 'setProp': {
      const node = g.nodes[op.id];
      if (!node) throw new Error(`Node ${op.id} not found`);
      const had = Object.prototype.hasOwnProperty.call(node.props, op.key);
      const props = { ...node.props };
      if (op.value === undefined) delete props[op.key];
      else props[op.key] = op.value;
      g.nodes[op.id] = { ...node, props };
      const inverse: Op = had
        ? { kind: 'setProp', id: op.id, key: op.key, value: node.props[op.key] }
        : { kind: 'setProp', id: op.id, key: op.key };
      return { graph: g, inverse };
    }
    default: {
      const unknown: { kind?: unknown } = op;
      throw new Error(`Unknown op ${String(unknown.kind)}`);
    }
  }
}

export function applyOps(graph: Graph, ops: readonly Op[]): { graph: Graph; inverses: Op[] } {
  let g = graph;
  const inverses: Op[] = [];
  for (const op of ops) {
    const r = applyOp(g, op);
    g = r.graph;
    inverses.unshift(r.inverse);
  }
  return { graph: g, inverses };
}

export function diffStats(ops: readonly Op[]): DiffStats {
  const s: DiffStats = { nodes: 0, edges: 0, props: 0 };
  for (const op of ops) {
    if (op.kind === 'addNode') s.nodes += 1;
    if (op.kind === 'removeNode') s.nodes -= 1;
    if (op.kind === 'addEdge') s.edges += 1;
    if (op.kind === 'removeEdge') s.edges -= 1;
    if (op.kind === 'setProp') s.props += op.value === undefined ? -1 : 1;
  }
  return s;
}

// Repository = committed graph + history + staged (uncommitted) ops.
export function createRepo(graph: Graph = emptyGraph()): Repo {
  return { head: graph, history: [], staged: [] };
}

// The working graph is head with staged ops applied.
export function workingGraph(repo: Repo): Graph {
  return applyOps(repo.head, repo.staged).graph;
}

export function stage(repo: Repo, op: Op): Repo {
  applyOp(workingGraph(repo), op); // validate against the working copy
  return { ...repo, staged: [...repo.staged, op] };
}

export function discard(repo: Repo): Repo {
  return { ...repo, staged: [] };
}

let counter = 0;
const commitId = (): string => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface CommitInfo {
  message: string;
  author: string;
  date?: string;
}

export function commit(repo: Repo, { message, author, date = new Date().toISOString() }: CommitInfo): Repo {
  if (!repo.staged.length) throw new Error('Nothing to commit');
  if (!message || !message.trim()) throw new Error('A commit needs a message');
  const { graph, inverses } = applyOps(repo.head, repo.staged);
  const entry: Commit = {
    id: commitId(),
    message: message.trim(),
    author,
    date,
    ops: repo.staged,
    inverses,
    stats: diffStats(repo.staged),
  };
  return { head: graph, history: [entry, ...repo.history], staged: [] };
}

export function revert(repo: Repo, id: string, { author, date }: { author: string; date?: string }): Repo {
  const target = repo.history.find((c) => c.id === id);
  if (!target) throw new Error(`Commit ${id} not found`);
  if (repo.staged.length) throw new Error('Commit or discard staged changes first');
  return commit({ ...repo, staged: target.inverses }, { message: `Revert "${target.message}"`, author, date });
}

// ---- Health check -------------------------------------------------------

export function healthCheck(graph: Graph): HealthReport {
  const nodes = Object.values(graph.nodes);
  const edges = Object.values(graph.edges);
  const degree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const issues: HealthIssue[] = [];
  const seen = new Map<string, string>();
  for (const e of edges) {
    const from = graph.nodes[e.from];
    const to = graph.nodes[e.to];
    if (!from || !to) {
      issues.push({
        level: 'error',
        kind: 'dangling',
        ref: e.id,
        text: `Relationship ${e.id} points at a missing node`,
      });
      continue;
    }
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    const key = `${e.from}|${e.rel}|${e.to}`;
    const first = seen.get(key);
    if (first) {
      issues.push({
        level: 'warn',
        kind: 'duplicate',
        ref: e.id,
        text: `Duplicate relationship ${from.label} —${e.rel}→ ${to.label} (also ${first})`,
      });
    } else seen.set(key, e.id);
  }
  for (const n of nodes) {
    if (degree.get(n.id) === 0)
      issues.push({ level: 'warn', kind: 'orphan', ref: n.id, text: `${n.type} "${n.label}" has no relationships` });
    for (const req of NODE_TYPES[n.type]?.required ?? []) {
      if (n.props?.[req] === undefined || n.props[req] === '') {
        issues.push({
          level: 'info',
          kind: 'missing-prop',
          ref: n.id,
          text: `${n.type} "${n.label}" is missing "${req}"`,
        });
      }
    }
  }
  const score = nodes.length
    ? Math.max(0, Math.round(100 - (issues.filter((i) => i.level !== 'info').length * 100) / nodes.length))
    : 100;
  return { issues, score, counts: { nodes: nodes.length, edges: edges.length } };
}

// ---- Queries -------------------------------------------------------------

export function neighbors(graph: Graph, id: string): Neighbor[] {
  const out: Neighbor[] = [];
  for (const e of Object.values(graph.edges)) {
    if (e.from !== id && e.to !== id) continue;
    const node = graph.nodes[e.from === id ? e.to : e.from];
    if (node) out.push({ edge: e, node, outgoing: e.from === id });
  }
  return out;
}

export function children(graph: Graph, id: string): OntologyNode[] {
  return Object.values(graph.edges)
    .filter((e) => e.from === id && e.rel === 'contains')
    .map((e) => graph.nodes[e.to])
    .filter((n): n is OntologyNode => Boolean(n));
}

// Path from the site down to a node along "contains" edges.
export function pathTo(graph: Graph, id: string): OntologyNode[] {
  const parent = new Map<string, string>();
  for (const e of Object.values(graph.edges)) if (e.rel === 'contains') parent.set(e.to, e.from);
  const path: OntologyNode[] = [];
  let cur: string | undefined = id;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    const node: OntologyNode | undefined = graph.nodes[cur];
    if (!node) break;
    guard.add(cur);
    path.unshift(node);
    cur = parent.get(cur);
  }
  return path;
}

export function findNodes(graph: Graph, text: string): OntologyNode[] {
  const q = text.toLowerCase();
  return Object.values(graph.nodes).filter(
    (n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase() === q || n.type.toLowerCase() === q,
  );
}
