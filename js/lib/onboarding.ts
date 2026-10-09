// Setting up a site (T6.06), apart from the page: the steps and their words, a site's slug from its
// name, the plant outline as ontology ops (site → workcenter → line → machines, each with its PLC,
// so mapping suggestions have somewhere to put signals), and the edge agent's config file.

import type { Graph, NodeType, Op } from './types.ts';

export type StepKey = 'site' | 'outline' | 'agent' | 'mapping' | 'dashboard';

export const STEPS: { key: StepKey; title: string; why: string }[] = [
  { key: 'site', title: 'Create the site', why: 'A site holds one plant’s ontology, signals, warnings and people.' },
  {
    key: 'outline',
    title: 'Outline the plant',
    why: 'Lines and machines, each with its controller: where signals and warnings belong.',
  },
  {
    key: 'agent',
    title: 'Connect an edge agent',
    why: 'It runs on site, reads the controllers and historians, and sends the readings out to Tiles.',
  },
  {
    key: 'mapping',
    title: 'Map the tags',
    why: 'Each tag linked to its Signal node, so readings land on their machine.',
  },
  {
    key: 'dashboard',
    title: 'Open the first dashboard',
    why: 'A machine’s page with its live readings, and the Shopfloor view for the line.',
  },
];

// A site's slug from its name: lower case, digits and dashes, as the API wants it.
export function slugFrom(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63)
      .replace(/-+$/, '') || 'site'
  );
}

export const PROTOCOLS = ['OPC UA', 'MQTT (Sparkplug B)', 'Modbus TCP', 'SQL historian'] as const;

export interface Outline {
  site: string; // the site's name: its Site node, made if the ontology has none
  workcenter: string; // optional
  line: string;
  machines: string[];
  protocol: string;
}

// The lines of a textarea as names, one per line (a name may have a comma: "Press 4, 400 t"):
// trimmed, blank ones and repeats dropped.
export function names(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

// Why an outline can't be made, or null.
// The first agent name of the form edge-01, edge-02, … that no agent has.
export function freeAgentName(taken: readonly string[]): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const name = `edge-${String(n).padStart(2, '0')}`;
    if (!used.has(name)) return name;
  }
}

export function outlineProblem(o: Outline): string | null {
  if (!o.line.trim()) return 'Name the line';
  if (!o.machines.length) return 'Name at least one machine';
  if (o.machines.length > 200) return 'Outline up to 200 machines at once';
  return null;
}

// The ops that add the outline to `graph`: a Site node unless it has one, the workcenter (if named)
// under it, the line under that, and each machine under the line with its PLC. Ids are made from
// the names and never collide with the graph's.
export function outlineOps(graph: Graph, o: Outline): Op[] {
  const taken = new Set([...Object.keys(graph.nodes), ...Object.keys(graph.edges)]);
  const id = (prefix: string, label: string): string => {
    const base = `${prefix}-${slugFrom(label)}`;
    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
    taken.add(candidate);
    return candidate;
  };
  const ops: Op[] = [];
  const node = (prefix: string, type: NodeType, label: string, props = {}, named = label) => {
    const nodeId = id(prefix, named);
    ops.push({ kind: 'addNode', node: { id: nodeId, type, label, props } });
    return nodeId;
  };
  const edge = (from: string, rel: string, to: string) =>
    ops.push({ kind: 'addEdge', edge: { id: id('e', `${from}-${rel}-${to}`), from, rel, to } });

  const existing = Object.values(graph.nodes)
    .filter((n) => n.type === 'Site')
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  const site = existing?.id ?? node('site', 'Site', o.site.trim() || 'Site');
  let parent = site;
  if (o.workcenter.trim()) {
    const wc = node('wc', 'Workcenter', o.workcenter.trim());
    edge(parent, 'contains', wc);
    parent = wc;
  }
  const line = node('line', 'Line', o.line.trim());
  edge(parent, 'contains', line);
  for (const label of o.machines) {
    const machine = node('m', 'Machine', label);
    const plc = node('plc', 'PLC', `PLC ${label}`, { protocol: o.protocol }, label); // plc-press-1
    edge(line, 'contains', machine);
    edge(machine, 'controlledBy', plc);
  }
  return ops;
}

// The edge agent's config file for this Tiles, its token in a file beside it.
export function agentConfig(apiUrl: string): string {
  return `[tiles]
url = "${apiUrl.replace(/\/+$/, '')}"
token_file = "token"             # the token above, in a file only the agent's user can read

[agent]
heartbeat_seconds = 30

# Then a connector for each source, e.g. an OPC UA server and one of its tags:
# [[opcua]]
# name = "press-line"
# endpoint = "opc.tcp://10.0.0.5:4840"
# [[opcua.signals]]
# node = "ns=2;s=Press1.Temperature"
# signal = "press1.temperature"
# See the edge agent's README for OPC UA, MQTT and SQL sources.
`;
}
