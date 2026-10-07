// Design studio models: physics-based models with versions, parameter sweeps,
// and a run log that records exactly which model version and parameters
// produced each result.

export const MODELS = {
  swelling: {
    id: 'swelling',
    name: 'Cell swelling force',
    domain: 'Electrochemical · Mechanical',
    output: { key: 'force', label: 'Swelling force', unit: 'kN' },
    params: [
      { key: 'soc', label: 'State of charge', unit: '%', min: 0, max: 100, default: 80 },
      { key: 'temperature', label: 'Temperature', unit: '°C', min: -10, max: 60, default: 25 },
      { key: 'preload', label: 'Stack preload', unit: 'kN', min: 0.5, max: 6, default: 2 },
      { key: 'cycles', label: 'Cycle count', unit: '', min: 0, max: 2000, default: 300 },
      { key: 'thickness', label: 'Anode thickness', unit: 'µm', min: 60, max: 140, default: 95 },
    ],
    versions: {
      '1.0': (p) => p.preload + 0.018 * p.soc * (p.thickness / 100),
      1.1: (p) =>
        p.preload + 0.018 * p.soc * (p.thickness / 100) * (1 + 0.004 * (p.temperature - 25)) + 0.0011 * p.cycles,
      '2.0': (p) => {
        // Graphite expansion with SOC plus SEI growth (√cycles) and a stiffening preload term.
        const intercalation = 0.021 * p.soc * (p.thickness / 100) * (1 + 0.0035 * (p.temperature - 25));
        const sei = 0.045 * Math.sqrt(p.cycles) * (1 + 0.012 * Math.max(0, p.temperature - 25));
        return p.preload * (1 + 0.04 * intercalation) + intercalation + sei;
      },
    },
    latest: '2.0',
  },
  actuator: {
    id: 'actuator',
    name: 'Humanoid joint actuator',
    domain: 'Electromechanical · Thermal',
    output: { key: 'temp', label: 'Winding temperature', unit: '°C' },
    params: [
      { key: 'torque', label: 'Continuous torque', unit: 'N·m', min: 5, max: 120, default: 40 },
      { key: 'ratio', label: 'Gear ratio', unit: ':1', min: 6, max: 100, default: 30 },
      { key: 'kt', label: 'Torque constant', unit: 'N·m/A', min: 0.05, max: 0.4, default: 0.12 },
      { key: 'rth', label: 'Thermal resistance', unit: 'K/W', min: 0.5, max: 4, default: 1.6 },
      { key: 'ambient', label: 'Ambient', unit: '°C', min: 0, max: 45, default: 25 },
    ],
    versions: {
      '1.0': (p) => {
        const current = p.torque / (p.ratio * 0.85) / p.kt;
        const loss = 3 * current ** 2 * 0.18;
        return p.ambient + loss * p.rth;
      },
      1.1: (p) => {
        const current = p.torque / (p.ratio * 0.85) / p.kt;
        // Copper resistance rises with temperature; iterate to a fixed point.
        let t = p.ambient;
        for (let i = 0; i < 20; i++) t = p.ambient + 3 * current ** 2 * 0.18 * (1 + 0.00393 * (t - 20)) * p.rth;
        return t;
      },
    },
    latest: '1.1',
  },
};

export function evaluate(modelId, version, params) {
  const model = MODELS[modelId];
  if (!model) throw new Error(`Unknown model ${modelId}`);
  const fn = model.versions[version];
  if (!fn) throw new Error(`Model ${modelId} has no version ${version}`);
  const full = Object.fromEntries(model.params.map((p) => [p.key, params[p.key] ?? p.default]));
  return fn(full);
}

export function linspace(lo, hi, n) {
  if (n < 2) return [lo];
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

// Full-factorial sweep over two parameters, others held at `base`.
export function sweep(modelId, version, base, xKey, yKey, steps = 12) {
  const model = MODELS[modelId];
  const px = model.params.find((p) => p.key === xKey);
  const py = model.params.find((p) => p.key === yKey);
  const xs = linspace(px.min, px.max, steps);
  const ys = linspace(py.min, py.max, steps);
  const grid = ys.map((y) => xs.map((x) => evaluate(modelId, version, { ...base, [xKey]: x, [yKey]: y })));
  const flat = grid.flat();
  return { xs, ys, grid, min: Math.min(...flat), max: Math.max(...flat) };
}

// One-at-a-time sensitivity: output change when each parameter moves ±10 % of its range.
export function sensitivity(modelId, version, base) {
  const model = MODELS[modelId];
  return model.params
    .map((p) => {
      const step = 0.1 * (p.max - p.min);
      const lo = evaluate(modelId, version, { ...base, [p.key]: Math.max(p.min, base[p.key] - step) });
      const hi = evaluate(modelId, version, { ...base, [p.key]: Math.min(p.max, base[p.key] + step) });
      return { key: p.key, label: p.label, delta: hi - lo };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export function makeRun({
  modelId,
  version,
  params,
  author,
  note = '',
  parent = null,
  date = new Date().toISOString(),
}) {
  const value = evaluate(modelId, version, params);
  return {
    id: `run-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    modelId,
    version,
    params: { ...params },
    value,
    author,
    note,
    parent,
    date,
  };
}

// Which parameters changed between a run and its parent.
export function runDiff(run, parent) {
  if (!parent) return [];
  return Object.keys(run.params)
    .filter((k) => run.params[k] !== parent.params[k])
    .map((k) => ({ key: k, from: parent.params[k], to: run.params[k] }))
    .concat(run.version !== parent.version ? [{ key: 'model version', from: parent.version, to: run.version }] : []);
}

export function auditRecord(runs, modelId) {
  const model = MODELS[modelId];
  return {
    exportedAt: new Date().toISOString(),
    model: { id: model.id, name: model.name, versions: Object.keys(model.versions) },
    runs: runs
      .filter((r) => r.modelId === modelId)
      .map((r) => ({ ...r, output: { [model.output.key]: r.value, unit: model.output.unit } })),
  };
}
