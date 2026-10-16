// Detector templates (T7.02): the form's values for a template, and what applying it did. The API
// (api_detector_templates.py) finds the machines, runs each backtest and makes the detectors.
import type { AppliedMachine, AppliedResult, DetectorTemplate } from './api.ts';
import { textOrder } from './format.ts';

// Several values for a setting, separated by spaces or semicolons ("3 4 5"); a decimal comma is
// read as a point, so "2,5 4" is 2.5 and 4. Null when one isn't a number or none is given.
export function parseValues(text: string, whole = false): number[] | null {
  const parts = text
    .split(/[\s;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const values = parts.map((p) => Number(p.replace(',', '.')));
  if (values.some((v) => !Number.isFinite(v) || (whole && !Number.isInteger(v)))) return null;
  return [...new Set(values)];
}

// The values as the form shows them again.
export const valuesText = (values: readonly (number | string)[]): string => values.join(' ');

// The combinations a template's backtest tries.
export function combinations(grid: DetectorTemplate['grid']): number {
  return Object.values(grid).reduce((n, values) => n * values.length, 1);
}

// Made first, then the ones already there, then what is missing, each by machine.
const ORDER: Record<AppliedResult, number> = { created: 0, exists: 1, no_history: 2, no_tag: 3, no_signal: 4 };
export function appliedOrder(machines: readonly AppliedMachine[]): AppliedMachine[] {
  const order = textOrder();
  return [...machines].sort((a, b) => ORDER[a.result] - ORDER[b.result] || order.compare(a.label, b.label));
}

// A detector's backtest report as a file.
export const reportFile = (detector: string): string => `backtest-${detector}.md`;
