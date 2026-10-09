// The Design Studio's runs from the Tiles API (T4.11, T4.14), pure: the API names models and
// versions as its registry does ("cell-swelling" 2.0.0), the browser as js/lib/design.ts does
// ("swelling" 2.0); a stored run becomes a browser Run, so the run history, its diffs and the
// audit export read the same either way.
import type { DesignRun, SweepResult } from './api.ts';
import type { RunChange } from './design.ts';
import type { Run } from './types.ts';

// The registry's key for each browser model (api models/design.py BROWSER_KEYS).
export const API_MODEL: Record<string, string> = { swelling: 'cell-swelling', actuator: 'joint-actuator' };

export const browserModel = (key: string): string => Object.entries(API_MODEL).find(([, k]) => k === key)?.[0] ?? key;

// 2.0.0 → 2.0; the browser's versions have no patch number.
export const browserVersion = (version: string): string => version.replace(/^(\d+\.\d+)\.0$/, '$1');

export function asRun(r: DesignRun): Run {
  return {
    id: String(r.number),
    modelId: browserModel(r.model),
    version: browserVersion(r.version),
    params: { ...r.params },
    value: Object.values(r.output)[0] ?? Number.NaN,
    author: r.author.name,
    note: r.note,
    parent: r.parent === null ? null : String(r.parent),
    date: r.created_at,
  };
}

// The run a new one follows: the latest of its model (runs come latest first).
export const headOf = (runs: readonly DesignRun[], model: string): number | null =>
  runs.find((r) => browserModel(r.model) === model)?.number ?? null;

// What changed from a stored run's parent, as the run history shows it (the API's changes: the
// parent may not be among the runs fetched).
export function changesOf(r: DesignRun): RunChange[] {
  return r.changes.map((c) =>
    c.key === 'version'
      ? { key: 'model version', from: browserVersion(String(c.before)), to: browserVersion(String(c.after)) }
      : { key: c.key, from: c.before ?? undefined, to: c.after ?? undefined },
  );
}

// An API sweep's result as the heatmap draws it (T4.12): a point the model couldn't run is NaN
// (drawn empty); a one-axis sweep is one row.
export function sweepGrid(r: SweepResult): { xs: number[]; ys: number[]; grid: number[][]; min: number; max: number } {
  return {
    xs: r.x.values,
    ys: r.y?.values ?? [0],
    grid: r.grid.map((row) => row.map((v) => v ?? Number.NaN)),
    min: r.min ?? 0,
    max: r.max ?? 0,
  };
}

// Which sweep a design's current settings ask for: a finished one shows only while they hold.
export const sweepKey = (
  site: string,
  model: string,
  version: string,
  params: Record<string, number>,
  x: string,
  y: string,
  steps: number,
): string => JSON.stringify([site, model, version, Object.entries(params).sort(), x, y, steps]);
