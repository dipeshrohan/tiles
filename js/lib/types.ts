// Shared domain types for the Tiles library modules.

// ---- Ontology -------------------------------------------------------------

// Equipment hierarchy aligned with ISA-95 (see docs/data-model.md):
// Enterprise > Site > Workcenter (ISA-95 Area) > Line | Cell > Machine.
export type NodeType =
  | 'Enterprise'
  | 'Site'
  | 'Workcenter'
  | 'Line'
  | 'Cell'
  | 'Machine'
  | 'Process'
  | 'Material'
  | 'PLC'
  | 'Signal'
  | 'Document'
  | 'Model';

export type PropValue = string | number | boolean;

export interface OntologyNode {
  id: string;
  type: NodeType;
  label: string;
  props: Record<string, PropValue>;
}

export interface OntologyEdge {
  id: string;
  from: string;
  rel: string;
  to: string;
}

export interface Graph {
  nodes: Record<string, OntologyNode>;
  edges: Record<string, OntologyEdge>;
}

export type Op =
  | { kind: 'addNode'; node: OntologyNode }
  | { kind: 'removeNode'; id: string }
  | { kind: 'addEdge'; edge: OntologyEdge }
  | { kind: 'removeEdge'; id: string }
  // `value` undefined (or absent after a JSON round trip) removes the property.
  | { kind: 'setProp'; id: string; key: string; value?: PropValue };

export interface DiffStats {
  nodes: number;
  edges: number;
  props: number;
}

export interface Commit {
  id: string;
  message: string;
  author: string;
  date: string;
  ops: Op[];
  inverses: Op[];
  stats: DiffStats;
  // Who approved it, when it went through a review (API only, T2.12).
  reviewer?: string | null;
}

export interface Repo {
  head: Graph;
  history: Commit[];
  staged: Op[];
}

export type IssueLevel = 'error' | 'warn' | 'info';
export type IssueKind = 'dangling' | 'duplicate' | 'orphan' | 'missing-prop';

export interface HealthIssue {
  level: IssueLevel;
  kind: IssueKind;
  ref: string;
  text: string;
}

export interface HealthReport {
  issues: HealthIssue[];
  score: number;
  counts: { nodes: number; edges: number };
}

export interface Neighbor {
  edge: OntologyEdge;
  node: OntologyNode;
  outgoing: boolean;
}

// ---- Physics --------------------------------------------------------------

export interface PlungerSpec {
  mass: number;
  hydraulicArea: number;
  metalArea: number;
  samples: number;
  dt: number;
}

export interface ShotPayload {
  t: number[];
  x: number[];
  v: number[];
  ph: number[];
  pm: number[];
}

export interface ShotRecord {
  index: number;
  time?: number;
  trueFriction?: number;
  friction: number;
}

export interface DowntimeEvent {
  id: string;
  shot: number;
  code: string;
  durationMin: number;
}

export interface ShotHistory {
  history: ShotRecord[];
  downtime: DowntimeEvent[];
  cycleSeconds: number;
}

export interface FrictionAlert {
  firstShot: number;
  lastShot: number;
  peak: number;
}

export interface Detection {
  flags: boolean[];
  thresholds: (number | null)[];
  alerts: FrictionAlert[];
}

export interface ScoredEvent extends DowntimeEvent {
  predicted: boolean;
  leadShots: number;
  leadHours: number;
}

// ---- Process data ---------------------------------------------------------

export type Material = 'anode' | 'cathode';

export interface CutterBatch {
  id: string;
  material: Material;
  tension: number;
  speed: number;
  humidity: number;
  bladeAge: number;
  rollDiameter: number;
  tabDev: number;
  ng: boolean;
}

export interface Variable<K extends string = string> {
  key: K;
  label: string;
  unit: string;
}

export interface WeldSample {
  hour: number;
  anode: number;
  cathode: number;
}

export interface WeldData {
  series: WeldSample[];
  swapAt: number;
  wearStart: number;
}

// ---- Design studio --------------------------------------------------------

export type Params = Record<string, number>;

export interface ParamSpec {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  default: number;
}

export interface DesignModel {
  id: string;
  name: string;
  domain: string;
  output: { key: string; label: string; unit: string };
  params: ParamSpec[];
  versions: Record<string, (p: Params) => number>;
  latest: string;
}

export interface Run {
  id: string;
  modelId: string;
  version: string;
  params: Params;
  value: number;
  author: string;
  note: string;
  parent: string | null;
  date: string;
}
