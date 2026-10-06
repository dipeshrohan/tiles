// Demo factory: a battery cell plant with an electrode cutter, tab welder and
// a die-cast housing line. All data is synthetic and seeded.

import { createRng } from './rng.js';
import { createRepo, commit, stage } from './ontology.js';

const N = (id, type, label, props = {}) => ({ kind: 'addNode', node: { id, type, label, props } });
const E = (from, rel, to) => ({ kind: 'addEdge', edge: { id: `${from}-${rel}-${to}`, from, rel, to } });

export function seedOntology() {
  const ops = [
    N('site-nk', 'Site', 'Northkoping Cell Plant', { location: 'Northkoping, SE', capacityGWh: 16 }),
    N('wc-elec', 'Workcenter', 'Electrode'),
    N('wc-asm', 'Workcenter', 'Cell Assembly'),
    N('wc-cast', 'Workcenter', 'Housing Casting'),
    N('ln-cut1', 'Line', 'Cutting Line 1'),
    N('ln-weld2', 'Line', 'Welding Line 2'),
    N('ln-dc1', 'Line', 'Die-cast Line 1'),
    N('m-cut01', 'Machine', 'Notching Cutter C-01', { vendor: 'Kestrel', model: 'NX-400' }),
    N('m-weld03', 'Machine', 'Tab Welder W-03', { vendor: 'Sonora', model: 'US-20k' }),
    N('m-dc02', 'Machine', 'Die-caster DC-02', { vendor: 'Halvard', model: 'HC-1600' }),
    N('p-notch', 'Process', 'Electrode notching'),
    N('p-weld', 'Process', 'Ultrasonic tab welding'),
    N('p-shot', 'Process', 'High-pressure die casting'),
    N('mat-anode', 'Material', 'Anode sheet (graphite)', { behaviour: 'stretchy' }),
    N('mat-cathode', 'Material', 'Cathode sheet (NMC)', { behaviour: 'stiff' }),
    N('mat-al', 'Material', 'AlSi10Mg melt'),
    N('plc-cut', 'PLC', 'PLC Cutter-01', { protocol: 'OPC UA' }),
    N('plc-dc', 'PLC', 'PLC DC-02', { protocol: 'OPC UA' }),
    N('plc-weld', 'PLC', 'PLC Welder-03', { protocol: 'Modbus TCP' }),
    N('sig-tension', 'Signal', 'Front stock tension', { unit: 'N·10⁻¹' }),
    N('sig-tab', 'Signal', 'Tab width deviation', { unit: 'µm' }),
    N('sig-power', 'Signal', 'Median welding power', { unit: 'W' }),
    N('sig-ph', 'Signal', 'Hydraulic pressure', { unit: 'bar' }),
    N('sig-pm', 'Signal', 'Metal pressure', { unit: 'bar' }),
    N('sig-vel', 'Signal', 'Plunger velocity', { unit: 'm/s' }),
    N('doc-sop-cut', 'Document', 'SOP-114 Cutter changeover'),
    N('doc-man-dc', 'Document', 'DC-02 maintenance manual'),
    N('mdl-friction', 'Model', 'Plunger friction virtual sensor', { version: '1.3' }),
    E('site-nk', 'contains', 'wc-elec'),
    E('site-nk', 'contains', 'wc-asm'),
    E('site-nk', 'contains', 'wc-cast'),
    E('wc-elec', 'contains', 'ln-cut1'),
    E('wc-asm', 'contains', 'ln-weld2'),
    E('wc-cast', 'contains', 'ln-dc1'),
    E('ln-cut1', 'contains', 'm-cut01'),
    E('ln-weld2', 'contains', 'm-weld03'),
    E('ln-dc1', 'contains', 'm-dc02'),
    E('m-cut01', 'runs', 'p-notch'),
    E('m-weld03', 'runs', 'p-weld'),
    E('m-dc02', 'runs', 'p-shot'),
    E('p-notch', 'consumes', 'mat-anode'),
    E('p-notch', 'consumes', 'mat-cathode'),
    E('p-shot', 'consumes', 'mat-al'),
    E('m-cut01', 'controlledBy', 'plc-cut'),
    E('m-dc02', 'controlledBy', 'plc-dc'),
    E('m-weld03', 'controlledBy', 'plc-weld'),
    E('plc-cut', 'emits', 'sig-tension'),
    E('plc-cut', 'emits', 'sig-tab'),
    E('plc-weld', 'emits', 'sig-power'),
    E('plc-dc', 'emits', 'sig-ph'),
    E('plc-dc', 'emits', 'sig-pm'),
    E('plc-dc', 'emits', 'sig-vel'),
    E('doc-sop-cut', 'describes', 'm-cut01'),
    E('doc-man-dc', 'describes', 'm-dc02'),
    E('mdl-friction', 'reads', 'sig-ph'),
    E('mdl-friction', 'reads', 'sig-pm'),
    E('mdl-friction', 'reads', 'sig-vel'),
    E('mdl-friction', 'monitors', 'm-dc02'),
  ];
  let repo = createRepo();
  const base = ops.filter((o) => !o.node?.id?.startsWith('mdl-') && !o.edge?.from?.startsWith('mdl-'));
  for (const op of base) repo = stage(repo, op);
  repo = commit(repo, { message: 'Import site hierarchy from MES', author: 'ingest-agent@tiles', date: '2026-09-02T08:10:00Z' });
  for (const op of ops.filter((o) => !base.includes(o))) repo = stage(repo, op);
  repo = commit(repo, { message: 'Register plunger friction virtual sensor', author: 'lena@tiles.dev', date: '2026-09-18T14:32:00Z' });
  // A stray node left behind by an ingest, so the health check has something to find.
  repo = stage(repo, N('sig-legacy', 'Signal', 'TEMP_TAG_0042', {}));
  repo = commit(repo, { message: 'Agentic ingestion: historian tags batch 7', author: 'ingest-agent@tiles', date: '2026-09-29T06:05:00Z' });
  return repo;
}

// Cutter batches. One setting (front stock tension) fails the two materials in
// opposite directions: anode stretches when tension is high, cathode tears
// when it is low. Pooled together the effect almost cancels out.
export const CUTTER_VARIABLES = [
  { key: 'tension', label: 'Front stock tension', unit: 'N·10⁻¹' },
  { key: 'speed', label: 'Line speed', unit: 'm/min' },
  { key: 'humidity', label: 'Dry-room dew point', unit: '°C' },
  { key: 'bladeAge', label: 'Blade age', unit: 'k cuts' },
  { key: 'rollDiameter', label: 'Roll diameter', unit: 'mm' },
];

export const TENSION_TARGET = { anode: 1006, cathode: 1478 };

export function generateCutterBatches({ seed = 11, count = 720 } = {}) {
  const rng = createRng(seed);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const material = i % 2 ? 'cathode' : 'anode';
    const target = TENSION_TARGET[material];
    // Operators run one shared tension band, so both materials drift toward the middle.
    const tension = target + (1240 - target) * rng.range(0, 1.1) + rng.normal(0, 45);
    const speed = rng.normal(42, 3);
    const humidity = rng.normal(-42, 2.5);
    const bladeAge = rng.range(0, 120);
    const rollDiameter = rng.range(180, 620);
    const strain = material === 'anode' ? (tension - target) / 55 : (target - tension) / 60;
    const tabDev = Math.max(0, 6 + 9 * strain + 0.03 * bladeAge + rng.normal(0, 6));
    rows.push({
      id: `B${String(i + 1).padStart(4, '0')}`,
      material,
      tension,
      speed,
      humidity,
      bladeAge,
      rollDiameter,
      tabDev,
      ng: tabDev > 40,
    });
  }
  return rows;
}

// Welder power over time; the cathode tip wears and power climbs in its last day.
export function generateWeldPower({ seed = 5, hours = 96 } = {}) {
  const rng = createRng(seed);
  const series = [];
  const swapAt = 72; // scheduled tip swap (cycle counter)
  const wearStart = 48;
  for (let h = 0; h < hours; h++) {
    const wear = h >= wearStart && h < swapAt ? 0.12 * ((h - wearStart) / (swapAt - wearStart)) ** 1.5 : 0;
    series.push({
      hour: h,
      anode: 1450 * (1 + rng.normal(0, 0.008)),
      cathode: 1620 * (1 + wear + rng.normal(0, 0.008)),
    });
  }
  return { series, swapAt, wearStart };
}
