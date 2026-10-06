// Factory ontology: a typed graph plus Git-like change management.
// Edits are staged as operations, committed with a message and author,
// and any commit can be reverted by replaying its inverse operations.

export const NODE_TYPES = {
  Site: { color: '#1f5f5b', required: ['location'] },
  Workcenter: { color: '#2f7d6d', required: [] },
  Line: { color: '#4b9b8a', required: [] },
  Machine: { color: '#c0603a', required: ['vendor'] },
  Process: { color: '#7b5ea7', required: [] },
  Material: { color: '#b88a1b', required: [] },
  PLC: { color: '#4a6fa5', required: ['protocol'] },
  Signal: { color: '#5d8aa8', required: ['unit'] },
  Document: { color: '#8a8a7a', required: [] },
  Model: { color: '#a23b5a', required: [] },
};

export const HIERARCHY = ['Site', 'Workcenter', 'Line', 'Machine'];

export function emptyGraph() {
  return { nodes: {}, edges: {} };
}

const clone = (g) => ({ nodes: { ...g.nodes }, edges: { ...g.edges } });

// Apply one op and return { graph, inverse }. Throws on invalid ops so bad
// changes never reach a commit.
export function applyOp(graph, op) {
  const g = clone(graph);
  switch (op.kind) {
    case 'addNode': {
      if (g.nodes[op.node.id]) throw new Error(`Node ${op.node.id} already exists`);
      if (!NODE_TYPES[op.node.type]) throw new Error(`Unknown node type ${op.node.type}`);
      g.nodes[op.node.id] = { props: {}, ...op.node };
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
      return {
        graph: g,
        inverse: { kind: 'setProp', id: op.id, key: op.key, value: had ? node.props[op.key] : undefined },
      };
    }
    default:
      throw new Error(`Unknown op ${op.kind}`);
  }
}

export function applyOps(graph, ops) {
  let g = graph;
  const inverses = [];
  for (const op of ops) {
    const r = applyOp(g, op);
    g = r.graph;
    inverses.unshift(r.inverse);
  }
  return { graph: g, inverses };
}

export function diffStats(ops) {
  const s = { nodes: 0, edges: 0, props: 0 };
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
export function createRepo(graph = emptyGraph()) {
  return { head: graph, history: [], staged: [] };
}

// The working graph is head with staged ops applied.
export function workingGraph(repo) {
  return applyOps(repo.head, repo.staged).graph;
}

export function stage(repo, op) {
  applyOp(workingGraph(repo), op); // validate against the working copy
  return { ...repo, staged: [...repo.staged, op] };
}

export function discard(repo) {
  return { ...repo, staged: [] };
}

let counter = 0;
const commitId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

export function commit(repo, { message, author, date = new Date().toISOString() }) {
  if (!repo.staged.length) throw new Error('Nothing to commit');
  if (!message || !message.trim()) throw new Error('A commit needs a message');
  const { graph, inverses } = applyOps(repo.head, repo.staged);
  const entry = {
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

export function revert(repo, id, { author, date } = {}) {
  const target = repo.history.find((c) => c.id === id);
  if (!target) throw new Error(`Commit ${id} not found`);
  if (repo.staged.length) throw new Error('Commit or discard staged changes first');
  return commit(
    { ...repo, staged: target.inverses },
    { message: `Revert "${target.message}"`, author, date },
  );
}

// ---- Health check -------------------------------------------------------

export function healthCheck(graph) {
  const nodes = Object.values(graph.nodes);
  const edges = Object.values(graph.edges);
  const degree = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  const issues = [];
  const seen = new Map();
  for (const e of edges) {
    if (!graph.nodes[e.from] || !graph.nodes[e.to]) {
      issues.push({ level: 'error', kind: 'dangling', ref: e.id, text: `Relationship ${e.id} points at a missing node` });
      continue;
    }
    degree[e.from]++;
    degree[e.to]++;
    const key = `${e.from}|${e.rel}|${e.to}`;
    if (seen.has(key)) {
      issues.push({ level: 'warn', kind: 'duplicate', ref: e.id, text: `Duplicate relationship ${graph.nodes[e.from].label} —${e.rel}→ ${graph.nodes[e.to].label} (also ${seen.get(key)})` });
    } else seen.set(key, e.id);
  }
  for (const n of nodes) {
    if (degree[n.id] === 0) issues.push({ level: 'warn', kind: 'orphan', ref: n.id, text: `${n.type} "${n.label}" has no relationships` });
    for (const req of NODE_TYPES[n.type]?.required ?? []) {
      if (n.props?.[req] === undefined || n.props[req] === '') {
        issues.push({ level: 'info', kind: 'missing-prop', ref: n.id, text: `${n.type} "${n.label}" is missing "${req}"` });
      }
    }
  }
  const score = nodes.length ? Math.max(0, Math.round(100 - (issues.filter((i) => i.level !== 'info').length * 100) / nodes.length)) : 100;
  return { issues, score, counts: { nodes: nodes.length, edges: edges.length } };
}

// ---- Queries -------------------------------------------------------------

export function neighbors(graph, id) {
  return Object.values(graph.edges)
    .filter((e) => e.from === id || e.to === id)
    .map((e) => ({ edge: e, node: graph.nodes[e.from === id ? e.to : e.from], outgoing: e.from === id }));
}

export function children(graph, id) {
  return Object.values(graph.edges)
    .filter((e) => e.from === id && e.rel === 'contains')
    .map((e) => graph.nodes[e.to])
    .filter(Boolean);
}

// Path from the site down to a node along "contains" edges.
export function pathTo(graph, id) {
  const parent = {};
  for (const e of Object.values(graph.edges)) if (e.rel === 'contains') parent[e.to] = e.from;
  const path = [];
  let cur = id;
  const guard = new Set();
  while (cur && graph.nodes[cur] && !guard.has(cur)) {
    guard.add(cur);
    path.unshift(graph.nodes[cur]);
    cur = parent[cur];
  }
  return path;
}

export function findNodes(graph, text) {
  const q = text.toLowerCase();
  return Object.values(graph.nodes).filter(
    (n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase() === q || n.type.toLowerCase() === q,
  );
}
