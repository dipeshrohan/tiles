// Setpoint recommendations (T11.02), the browser's side: which models can recommend, what a
// recommendation changes, and what the person looking may do with it. The sweep, the limits'
// check and the audit are the API's (api_recommendations.py); nothing here decides a setting.
import type { ModelInfo, ModelParam, Recommendation } from './api.ts';
import type { OntologyNode } from './types.ts';

// A design model, its parameters the design and its outputs one value each, can be swept.
export const recommendable = (models: readonly ModelInfo[]): ModelInfo[] =>
  models.filter((m) => m.kind === 'design' && m.inputs.length === 0);

// The machine as the MES names it: its `asset` property, else its label (coverage.asset_of).
export function assetOf(node: OntologyNode): string {
  const asset = node.props.asset;
  return typeof asset === 'string' && asset.trim() ? asset.trim() : node.label;
}

export interface Change {
  param: string;
  unit: string;
  from: number | null; // the state it was swept on
  to: number;
  min: number | null; // the limit it was swept within
  max: number | null;
}

// Each settable parameter: from its state to the value proposed, within its limit.
export function changes(rec: Recommendation, params: readonly ModelParam[] = []): Change[] {
  const units = new Map(params.map((p) => [p.name, p.unit]));
  return Object.entries(rec.proposal).map(([param, to]) => ({
    param,
    unit: units.get(param) ?? '',
    from: rec.state[param] ?? null,
    to,
    min: rec.limits[param]?.min ?? null,
    max: rec.limits[param]?.max ?? null,
  }));
}

// A chance (0 to 1) reads as a percentage; anything else as the number it is.
export const isChance = (output: string): boolean => /(^|_)(chance|probability|share)$/.test(output);

export interface Allowed {
  approve: boolean; // someone other than its proposer, while it is proposed
  reject: boolean; // anyone who may edit, its proposer too (withdrawing it)
  applied: boolean; // once approved: the line set it by hand
}

export function allowed(rec: Recommendation, canEdit: boolean): Allowed {
  return {
    approve: canEdit && rec.status === 'proposed' && !rec.mine,
    reject: canEdit && rec.status === 'proposed',
    applied: canEdit && rec.status === 'approved',
  };
}

// Open ones first (proposed, then approved), then the rest; newest first within each.
const RANK: Record<Recommendation['status'], number> = { proposed: 0, approved: 1, applied: 2, rejected: 3 };
export const ordered = (recs: readonly Recommendation[]): Recommendation[] =>
  [...recs].sort((a, b) => RANK[a.status] - RANK[b.status] || b.number - a.number);

// The parameters a form can sweep: those with a limit, at most two at once (recommend.MAX_SETTABLE).
export const MAX_SETTABLE = 2;
export const settableOf = (model: ModelInfo, limited: ReadonlySet<string>): ModelParam[] =>
  model.params.filter((p) => limited.has(p.name));

// The form's numbers: a value per parameter, unless it is read from a signal; NaN for a field
// that isn't a number, so the form can say which.
export function stateOf(
  model: ModelInfo,
  values: Readonly<Record<string, string>>,
  signals: Readonly<Record<string, string>>,
): { state: Record<string, number>; signals: Record<string, string>; bad: string[] } {
  const state: Record<string, number> = {};
  const read: Record<string, string> = {};
  const bad: string[] = [];
  for (const p of model.params) {
    const signal = signals[p.name];
    if (signal) {
      read[p.name] = signal;
      continue;
    }
    const text = (values[p.name] ?? '').trim();
    if (!text) continue; // the model's default
    const x = Number(text);
    if (!Number.isFinite(x)) bad.push(p.name);
    else state[p.name] = x;
  }
  return { state, signals: read, bad };
}
