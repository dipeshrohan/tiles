import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  appNumberFromHash,
  configSummary,
  defaultConfig,
  factText,
  paramField,
  readConfig,
  resultChart,
  statusBadge,
} from '../js/lib/apps.ts';

// As GET /app-templates describes the SPC template (trimmed).
const SPC = {
  id: 'spc-limits',
  version: 1,
  title: 'SPC limits',
  summary: 'Is the process in control?',
  params: [
    {
      name: 'signal',
      label: 'Signal',
      kind: 'signal',
      default: null,
      minimum: null,
      maximum: null,
      choices: [],
      optional: false,
      help: '',
    },
    {
      name: 'sigmas',
      label: 'Limits at (sigma)',
      kind: 'number',
      default: 3,
      minimum: 1,
      maximum: 6,
      choices: [],
      optional: false,
      help: '',
    },
    {
      name: 'points',
      label: 'Points',
      kind: 'integer',
      default: null,
      minimum: 1,
      maximum: null,
      choices: [],
      optional: true,
      help: '',
    },
    {
      name: 'side',
      label: 'Side',
      kind: 'choice',
      default: 'both',
      minimum: null,
      maximum: null,
      choices: [
        ['both', 'both sides'],
        ['up', 'above'],
      ],
      optional: false,
      help: '',
    },
    {
      name: 'rules',
      label: 'Rules',
      kind: 'choices',
      default: ['a', 'b'],
      minimum: null,
      maximum: null,
      choices: [
        ['a', 'Rule A'],
        ['b', 'Rule B <1>'],
      ],
      optional: false,
      help: '',
    },
  ],
};
const SIGNALS = [{ id: 's1', tag: 'oven.zone2_temp', unit: '°C' }];

test('app numbers come from the address', () => {
  assert.equal(appNumberFromHash('#/apps/12'), 12);
  assert.equal(appNumberFromHash('#/apps/12?x=1'), 12);
  assert.equal(appNumberFromHash('#/apps'), null);
  assert.equal(appNumberFromHash('#/apps/0'), null);
  assert.equal(appNumberFromHash('#/insights/3'), null);
});

test('settings become form fields with the template’s limits, escaped', () => {
  assert.deepEqual(defaultConfig(SPC), { signal: null, sigmas: 3, points: null, side: 'both', rules: ['a', 'b'] });
  const signal = paramField(SPC.params[0], 's1', SIGNALS);
  assert.match(signal, /<select id="app-param-signal" name="signal" required>/);
  assert.match(signal, /<option value="s1" selected>oven.zone2_temp \(°C\)<\/option>/);
  // A signal no longer listed stays chosen.
  assert.match(paramField(SPC.params[0], 'gone', SIGNALS), /<option value="gone" selected>/);
  assert.match(
    paramField(SPC.params[1], 3, []),
    /type="number" name="sigmas" value="3" step="any" min="1" max="6" required/,
  );
  assert.match(paramField(SPC.params[2], null, []), /step="1" min="1" {2}\/>/);
  assert.match(paramField(SPC.params[3], 'up', []), /<option value="up" selected>above<\/option>/);
  const rules = paramField(SPC.params[4], ['b'], []);
  assert.match(rules, /value="a" {2}\/> Rule A/);
  assert.match(rules, /value="b" checked \/> Rule B &lt;1&gt;/);
});

test('the form is read back and checked as the API checks it', () => {
  const ok = readConfig(SPC, { signal: 's1', sigmas: '2.5', points: '', side: 'up', rules: ['b'] });
  assert.deepEqual(ok, { config: { signal: 's1', sigmas: 2.5, points: null, side: 'up', rules: ['b'] }, problems: [] });
  const bad = readConfig(SPC, { signal: '', sigmas: '9', points: '1.5', side: 'sideways', rules: [] });
  // Each on its field (U2.07).
  assert.deepEqual(bad.problems, [
    { name: 'signal', message: 'Signal is needed' },
    { name: 'sigmas', message: 'Limits at (sigma) must be from 1 to 6' },
    { name: 'points', message: 'Points must be a whole number' },
    { name: 'side', message: 'Side: choose one' },
    { name: 'rules', message: 'Rules: choose at least one' },
  ]);
});

test('a result becomes a chart, a badge, facts and the settings in words', () => {
  const r = {
    status: 'alert',
    headline: 'Out of control',
    tag: 'oven.zone2_temp',
    unit: '°C',
    start: '2026-09-01T00:00:00Z',
    end: '2026-09-02T00:00:00Z',
    gap_seconds: 5400,
    points: [{ at: '2026-09-01T00:00:00Z', value: 100 }],
    levels: [{ label: 'upper limit', value: 103 }],
    spans: [{ from: '2026-09-01T10:00:00Z', to: '2026-09-01T11:00:00Z', label: 'a point beyond a control limit' }],
  };
  const chart = resultChart(r);
  assert.deepEqual(chart.points, [{ t: Date.parse('2026-09-01T00:00:00Z'), v: 100, lo: 100, hi: 100 }]);
  assert.equal(chart.gap, 5_400_000);
  assert.equal(chart.title, 'oven.zone2_temp (°C): Out of control');
  assert.deepEqual(chart.levels, [{ v: 103, label: 'upper limit' }]);
  assert.equal(chart.spans[0].to - chart.spans[0].from, 3_600_000);
  assert.equal(statusBadge('alert'), '<span class="badge bad">Alert</span>');
  assert.equal(factText({ label: 'x', value: 0.1234, format: 'percent' }), '12.3%');
  assert.equal(factText({ label: 'x', value: 0.01234, format: 'number' }), '0.0123');
  assert.equal(factText({ label: 'x', value: 1234.56, format: 'number' }), '1,234.6');
  assert.deepEqual(
    configSummary(SPC, { signal: 's1', sigmas: 3, points: null, side: 'up', rules: ['a', 'b'] }, 'oven.zone2_temp'),
    ['Signal: oven.zone2_temp', 'Limits at (sigma): 3', 'Points: none', 'Side: above', 'Rules: Rule A; Rule B <1>'],
  );
});
