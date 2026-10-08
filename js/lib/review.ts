// Change reviews (T2.12): a change request's ops described against the
// committed ontology, so a reviewer sees what each op does to it: the labels
// of the nodes involved and, for a property, the value it replaces.

import { applyOp } from './ontology.ts';
import type { Graph, Op, PropValue } from './types.ts';

export interface Change {
  sign: '+' | '−' | '~';
  text: string;
  // Why the op doesn't apply here, if it doesn't (the ontology changed since it was requested).
  problem?: string;
}

const show = (v: PropValue | undefined): string => (typeof v === 'string' ? `“${v}”` : String(v));

// Describes each op in order, each against the graph the ops before it made.
// With `compare: false` (a request already decided, whose ops may be in the head
// by now) the head only lends its labels: no values replaced, no problems.
export function describeChanges(head: Graph, ops: readonly Op[], { compare = true } = {}): Change[] {
  let graph = head;
  return ops.map((op) => {
    const label = (id: string) => graph.nodes[id]?.label ?? id;
    const change = describe(op, compare ? graph : { nodes: {}, edges: {} }, label);
    if (!compare) return change;
    try {
      graph = applyOp(graph, op).graph;
    } catch (e) {
      change.problem = e instanceof Error ? e.message : String(e);
    }
    return change;
  });
}

function describe(op: Op, graph: Graph, label: (id: string) => string): Change {
  switch (op.kind) {
    case 'addNode': {
      const props = Object.entries(op.node.props ?? {}).map(([k, v]) => `${k} ${show(v)}`);
      return {
        sign: '+',
        text: `${op.node.type} “${op.node.label}”${props.length ? ` (${props.join(', ')})` : ''}`,
      };
    }
    case 'removeNode': {
      const node = graph.nodes[op.id];
      return { sign: '−', text: node ? `${node.type} “${node.label}”` : `node ${label(op.id)}` };
    }
    case 'addEdge':
      return { sign: '+', text: `${label(op.edge.from)} —${op.edge.rel}→ ${label(op.edge.to)}` };
    case 'removeEdge': {
      const edge = graph.edges[op.id];
      return {
        sign: '−',
        text: edge ? `${label(edge.from)} —${edge.rel}→ ${label(edge.to)}` : `relationship ${op.id}`,
      };
    }
    case 'setProp': {
      const before = graph.nodes[op.id]?.props?.[op.key];
      const what = `${label(op.id)} · ${op.key}`;
      if (op.value === undefined)
        return { sign: '−', text: before === undefined ? what : `${what} (was ${show(before)})` };
      if (before === undefined) return { sign: '+', text: `${what} = ${show(op.value)}` };
      return { sign: '~', text: `${what}: ${show(before)} → ${show(op.value)}` };
    }
  }
}
