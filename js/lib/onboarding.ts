// Setting up a site (T6.06), apart from the page: the steps and their words, a site's slug from its
// name, the plant outline as ontology ops (site → workcenter → line → machines, each with its PLC,
// so mapping suggestions have somewhere to put signals), and the edge agent's config file.

import type { Graph, NodeType, Op } from './types.ts';
import type { Onboarding } from './api.ts';
import { machineOf } from './shopfloor.ts';
import { outgoing, signalByTag } from './graph-index.ts';
import { t, type MessageKey } from './i18n.ts';

export type StepKey = 'site' | 'outline' | 'agent' | 'mapping' | 'dashboard';

// A step's words, read when shown (the language may change after load).
const step = (key: StepKey, title: MessageKey, why: MessageKey): { key: StepKey; title: string; why: string } => ({
  key,
  get title() {
    return t(title);
  },
  get why() {
    return t(why);
  },
});

export const STEPS: { key: StepKey; title: string; why: string }[] = [
  step('site', 'onboarding.step.site', 'onboarding.step.siteWhy'),
  step('outline', 'onboarding.step.outline', 'onboarding.step.outlineWhy'),
  step('agent', 'onboarding.step.agent', 'onboarding.step.agentWhy'),
  step('mapping', 'onboarding.step.mapping', 'onboarding.step.mappingWhy'),
  step('dashboard', 'onboarding.step.dashboard', 'onboarding.step.dashboardWhy'),
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

// Kept on the PLC nodes as written: names, not words to translate.
export const PROTOCOLS = ['OPC UA', 'MQTT (Sparkplug B)', 'Modbus TCP', 'SQL historian'] as const; // i18n-ok

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
  if (!o.line.trim()) return t('onboarding.problem.line');
  if (!o.machines.length) return t('onboarding.problem.machine');
  if (o.machines.length > 200) return t('onboarding.problem.tooMany');
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

// ---- in local mode (U4.10) -----------------------------------------------------------------------
// The wizard on the demo plant, so people can learn the flow before they have the API: the site is
// this browser's, the outline is added to its ontology, the agent step shows how one is installed
// (and a demo agent stands in for it), and mapping links the demo's tags. A tag is mapped when a
// Signal node carries it (its `tag` property), so the mapping shows on the Ontology page too.

export const LOCAL_KEY = 'onboarding-local';

export interface LocalSetup {
  agent: boolean; // the demo agent "called in"
}

// The tags a demo agent would send: the die-caster's, the cutter's and the welder's PLCs. Each
// suggests a Signal node by its name (`suggest`), or a new one under its machine's PLC.
export interface DemoTag {
  tag: string;
  unit: string;
  description: string;
  machine: string; // the Machine node it comes from
  suggest: string | null; // a Signal node of that machine, when one fits
}

// The demo plant's data (its Signal nodes' names), like the rest of the seeded plant.
export const DEMO_TAGS: readonly DemoTag[] = [
  { tag: 'dc02.hyd_pressure', unit: 'bar', description: 'Hydraulic pressure', machine: 'm-dc02', suggest: 'sig-ph' }, // i18n-ok
  { tag: 'dc02.metal_pressure', unit: 'bar', description: 'Metal pressure', machine: 'm-dc02', suggest: 'sig-pm' }, // i18n-ok
  { tag: 'dc02.plunger_vel', unit: 'm/s', description: 'Plunger velocity', machine: 'm-dc02', suggest: 'sig-vel' }, // i18n-ok
  { tag: 'dc02.die_temp', unit: '°C', description: 'Die temperature', machine: 'm-dc02', suggest: null }, // i18n-ok
  {
    tag: 'c01.front_tension',
    unit: 'N·10⁻¹',
    description: 'Front stock tension', // i18n-ok
    machine: 'm-cut01',
    suggest: 'sig-tension',
  },
  { tag: 'w03.weld_power', unit: 'W', description: 'Median welding power', machine: 'm-weld03', suggest: 'sig-power' }, // i18n-ok
];

export type Suggestion =
  | { kind: 'link'; node: string; label: string; why: string }
  | { kind: 'new'; plc: string; label: string; why: string }
  | { kind: 'none'; why: string };

// The Signal node that carries a tag, if any (the Plant page's pick when several do).
export const mappedTo = (graph: Graph, tag: string): string | null => signalByTag(graph, tag) ?? null;

// What to map a demo tag to: its named Signal node when that is still there and free; else a new
// Signal node under its machine's controller; else nothing (the machine or its PLC is gone).
export function suggestFor(graph: Graph, tag: DemoTag): Suggestion {
  const node = tag.suggest ? graph.nodes[tag.suggest] : undefined;
  const machine = graph.nodes[tag.machine];
  if (
    node?.type === 'Signal' &&
    (node.props.tag === undefined || node.props.tag === tag.tag) &&
    machineOf(graph, node.id) === tag.machine // still that machine's
  )
    return {
      kind: 'link',
      node: node.id,
      label: node.label,
      why: t('onboarding.why.link', { signal: node.label, machine: machine?.label ?? t('onboarding.why.machine') }),
    };
  const plc = outgoing(graph, tag.machine, 'controlledBy').find((id) => graph.nodes[id]?.type === 'PLC');
  if (machine && plc && graph.nodes[plc])
    return {
      kind: 'new',
      plc,
      label: tag.description,
      why: t('onboarding.why.new', { plc: graph.nodes[plc]!.label, machine: machine.label }),
    };
  return { kind: 'none', why: t('onboarding.why.none') };
}

// The ops that map tags as suggested (those with a suggestion, not mapped yet).
export function mappingOps(graph: Graph, tags: readonly DemoTag[]): Op[] {
  const taken = new Set([...Object.keys(graph.nodes), ...Object.keys(graph.edges)]);
  const ops: Op[] = [];
  for (const tag of tags) {
    if (mappedTo(graph, tag.tag)) continue;
    const s = suggestFor(graph, tag);
    if (s.kind === 'link') ops.push({ kind: 'setProp', id: s.node, key: 'tag', value: tag.tag });
    else if (s.kind === 'new') {
      let id = `sig-${slugFrom(tag.tag)}`;
      for (let n = 2; taken.has(id); n++) id = `sig-${slugFrom(tag.tag)}-${n}`;
      taken.add(id);
      let edge = `${s.plc}-emits-${id}`;
      for (let n = 2; taken.has(edge); n++) edge = `${s.plc}-emits-${id}-${n}`;
      taken.add(edge);
      ops.push(
        {
          kind: 'addNode',
          node: { id, type: 'Signal', label: tag.description, props: { unit: tag.unit, tag: tag.tag } },
        },
        { kind: 'addEdge', edge: { id: edge, from: s.plc, rel: 'emits', to: id } },
      );
    }
  }
  return ops;
}

// The progress the API's /onboarding gives, worked out from this browser's ontology and setup.
export function localProgress(graph: Graph, setup: LocalSetup): Onboarding {
  const machines = Object.values(graph.nodes).filter((n) => n.type === 'Machine');
  const mapped = DEMO_TAGS.map((d) => mappedTo(graph, d.tag)).filter((id): id is string => id !== null);
  const counts = new Map<string, number>();
  for (const id of mapped) {
    const m = machineOf(graph, id);
    if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort(
    ([a, x], [b, y]) => y - x || graph.nodes[a]!.label.localeCompare(graph.nodes[b]!.label) || a.localeCompare(b),
  )[0];
  const dashboard = best ? { id: best[0], label: graph.nodes[best[0]]!.label } : null;
  const steps: Onboarding['steps'] = [
    { key: 'site', done: true, detail: t('onboarding.progress.site') },
    {
      key: 'outline',
      done: machines.length > 0,
      detail: machines.length
        ? t('onboarding.progress.machines', { count: machines.length })
        : t('onboarding.progress.noMachines'),
    },
    {
      key: 'agent',
      done: setup.agent,
      detail: setup.agent ? t('onboarding.progress.agent') : t('onboarding.progress.noAgent'),
    },
    {
      key: 'mapping',
      done: mapped.length > 0,
      detail: t('onboarding.progress.mapped', { mapped: mapped.length, count: DEMO_TAGS.length }),
    },
    {
      key: 'dashboard',
      done: dashboard !== null,
      detail:
        dashboard && best
          ? t('onboarding.progress.dashboard', { machine: dashboard.label, count: best[1] })
          : t('onboarding.progress.noDashboard'),
    },
  ];
  return {
    steps,
    next: steps.find((s) => !s.done)?.key ?? null,
    machines: machines.length,
    agents: setup.agent ? 1 : 0,
    agents_seen: setup.agent ? 1 : 0,
    tags: DEMO_TAGS.length,
    mapped: mapped.length,
    dashboard,
  };
}
