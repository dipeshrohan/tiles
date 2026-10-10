import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  changeFrom,
  latest,
  qualityBadge,
  qualityDetail,
  resultsTable,
  sourceLabel,
  suggestionRow,
  untouched,
} from '../js/views/signals.ts';
import { deliveryState, describeAudit } from '../js/views/settings.ts';

const SIG = {
  id: 's1',
  tag: 'press1.temperature',
  unit: '°C',
  sample_rate_hz: 10,
  source: 'edge:press-shop-edge',
  description: 'Platen, upper',
  node_id: null,
  node_label: null,
  created_at: '2026-10-01T00:00:00Z',
  last_at: '2026-10-08T06:00:00Z',
  last_value: 21.50000001,
  range_min: null,
  range_max: null,
  stuck_after_s: null,
  event_kind: null,
  asset: null,
  quality: null,
};

const REPORT = {
  badge: 'warn',
  checked_at: '2026-10-08T06:00:00Z',
  window_hours: 24,
  first_at: '2026-10-07T06:00:00Z',
  last_at: '2026-10-08T06:00:00Z',
  readings: 1430,
  period_s: 60,
  coverage: 0.99395,
  gaps: 1,
  longest_gap_s: 600,
  stuck_runs: 0,
  longest_stuck_s: null,
  out_of_range: 0,
  source_flagged: 0,
  issues: [{ check: 'gaps', severity: 'warn', message: '1 gap(s) longer than 3 min; the longest 10 min <b>' }],
};

test('where a signal comes from, in words', () => {
  assert.equal(sourceLabel('edge:press-shop-edge'), 'Edge agent press-shop-edge');
  assert.equal(sourceLabel('import:line:2.csv'), 'Import line:2.csv');
  assert.equal(sourceLabel('manual'), 'Entered by hand');
});

test('the latest reading, with its unit', () => {
  assert.match(latest(SIG), /^21\.5 °C · /);
  assert.match(latest({ ...SIG, last_value: 'running' }), /^running · /);
  assert.match(latest({ ...SIG, last_value: true }), /^true · /);
  assert.equal(latest({ ...SIG, last_at: null, last_value: null }), '—');
});

test('the edit form sends only what changed; blanks clear', () => {
  const same = { unit: '°C', rate: '10', description: 'Platen, upper', node: '' };
  assert.deepEqual(changeFrom(same, SIG), {});
  assert.deepEqual(changeFrom({ ...same, unit: ' ', rate: '2,5', node: 'sig-1' }, SIG), {
    unit: null,
    sample_rate_hz: 2.5,
    node_id: 'sig-1',
  });
  assert.deepEqual(changeFrom({ ...same, rate: '' }, SIG), { sample_rate_hz: null });
  assert.equal(changeFrom({ ...same, rate: '0' }, SIG), 'The sample rate is a number of readings per second, above 0.');
  assert.equal(
    changeFrom({ ...same, rate: 'fast' }, SIG),
    'The sample rate is a number of readings per second, above 0.',
  );
});

test('the expected range and stuck limit are numbers, sent only when changed', () => {
  const same = { unit: '°C', rate: '10', description: 'Platen, upper', node: '', min: '', max: '', stuck: '' };
  assert.deepEqual(changeFrom(same, SIG), {});
  assert.deepEqual(changeFrom({ ...same, min: '-10', max: '250,5', stuck: '90' }, SIG), {
    range_min: -10,
    range_max: 250.5,
    stuck_after_s: 5400,
  });
  const set = { ...SIG, range_min: -10, range_max: 250.5, stuck_after_s: 5400 };
  assert.deepEqual(changeFrom({ ...same, min: '-10', max: '250.5', stuck: '90' }, set), {});
  assert.deepEqual(changeFrom(same, set), { range_min: null, range_max: null, stuck_after_s: null });
  assert.equal(
    changeFrom({ ...same, min: '5', max: '5' }, SIG),
    "The expected range's minimum must be below its maximum.",
  );
  assert.equal(changeFrom({ ...same, max: 'hot' }, SIG), 'The expected range is two numbers (either may be blank).');
  assert.equal(
    changeFrom({ ...same, stuck: '0' }, SIG),
    'Stuck after is a number of minutes, above 0 and at most 30 days.',
  );
});

test('quality badges and the report behind them', () => {
  assert.match(qualityBadge(null), /class="badge"[^>]*>Not checked</);
  assert.match(qualityBadge({ ...REPORT, badge: 'bad' }), /class="badge bad"[^>]*>Problems</);
  assert.match(qualityBadge({ ...REPORT, badge: 'unknown', issues: [] }), />No data</);
  const badge = qualityBadge(REPORT);
  assert.match(badge, />Warnings</);
  assert.match(badge, /title="1 gap\(s\) longer than 3 min; the longest 10 min &lt;b&gt;"/);
  const detail = qualityDetail(REPORT);
  assert.match(
    detail,
    /1,430 reading\(s\) in the 24 h up to the latest, expected every 60 s, 99\.3% of the time covered/,
  );
  assert.match(detail, /warning<\/span> 1 gap\(s\)[^<]*&lt;b&gt;/);
  assert.match(qualityDetail({ ...REPORT, badge: 'good', issues: [] }), /No gaps, stuck values/);
  assert.match(
    qualityDetail({ ...REPORT, readings: 0, period_s: null, coverage: null, issues: [] }),
    /No readings to check/,
  );
});

test('signal changes read as sentences in the audit log', () => {
  const e = {
    action: 'signal.update',
    before: {},
    after: { tag: 'press1.temperature', unit: '°C', node_id: 'sig-1' },
    entity_type: 'signal',
    entity_id: 's1',
  };
  assert.equal(describeAudit(e), 'Changed unit, ontology link of signal press1.temperature');
  assert.equal(
    describeAudit({ ...e, after: { tag: 'oven.temp', range_min: 0, stuck_after_s: 600 } }),
    'Changed expected minimum, stuck limit of signal oven.temp',
  );
  assert.equal(
    describeAudit({
      ...e,
      action: 'signal.quality_check',
      entity_type: 'site',
      after: { hours: 24, checked: 5, good: 3, warn: 1, bad: 1, unknown: 0 },
    }),
    'Checked the quality of 5 signal(s): 3 good, 1 with warnings, 1 with problems',
  );
});

test('the ontology link: the node, a node with an empty label, or one that is gone', () => {
  const ctx = { ui: (_id, defaults) => defaults, state: { repo: { head: { nodes: {} } } } };
  const row = (extra) => resultsTable(ctx, { total: 1, signals: [{ ...SIG, ...extra }] }, false);
  assert.match(row({ node_id: 'sig-1', node_label: 'Platen <b>' }), /<a href="#\/ontology">Platen &lt;b&gt;<\/a>/);
  assert.match(row({ node_id: 'sig-1', node_label: '' }), /<a href="#\/ontology">sig-1<\/a>/);
  assert.match(row({ node_id: 'sig-1', node_label: null }), /missing node/);
});

test('text fields left as they were are not sent, even when stored with spaces', () => {
  const spaced = { ...SIG, unit: 'kg ', description: ' Platen ' };
  const form = { unit: 'kg ', rate: '20', description: ' Platen ', node: '' };
  assert.deepEqual(changeFrom(form, spaced), { sample_rate_hz: 20 });
  assert.deepEqual(changeFrom({ ...form, unit: ' t ' }, spaced), { unit: 't', sample_rate_hz: 20 });
});

test('an input still showing what was rendered is untouched, line breaks aside', () => {
  assert.equal(untouched({ value: 'Zone 1upper', defaultValue: 'Zone 1\nupper' }), true);
  assert.equal(untouched({ value: 'kg', defaultValue: 'kg' }), true);
  assert.equal(untouched({ value: 'kg2', defaultValue: 'kg' }), false);
});

test('a stuck limit read back from minutes is not an edit', () => {
  const same = { unit: '°C', rate: '10', description: 'Platen, upper', node: '', min: '', max: '' };
  for (const seconds of [31, 62, 123, 3600]) {
    const minutes = String(+(seconds / 60).toPrecision(12));
    assert.deepEqual(changeFrom({ ...same, stuck: minutes }, { ...SIG, stuck_after_s: seconds }), {}, String(seconds));
  }
});

test('a mapping suggestion shows what it would do and why, with actions for editors only', () => {
  const s = {
    signal_id: 's1',
    tag: 'press1.temperature',
    kind: 'create',
    score: 0.8,
    node_id: 'signal-press1-temperature',
    node_label: 'Press 1 <b>temperature</b>',
    reasons: ['emitted by PLC Press 1: the tag names Press 1 & co'],
    ops: [],
  };
  const row = suggestionRow(s, true);
  assert.match(row, /New node<\/span> Press 1 &lt;b&gt;temperature&lt;\/b&gt;/);
  assert.match(row, />80%</);
  assert.match(row, /<li>emitted by PLC Press 1: the tag names Press 1 &amp; co<\/li>/);
  assert.match(row, /data-accept="s1"\s*>Stage node</);
  assert.match(suggestionRow(s, true, true), /<button[^>]* disabled data-accept="s1">/); // while Link all runs
  assert.match(suggestionRow({ ...s, kind: 'link' }, true), /Link to<\/span>[\s\S]*>Link</);
  assert.doesNotMatch(suggestionRow(s, false), /data-accept/);
});

test('a message reads as sent, waiting, retrying or given up, with why', () => {
  const d = { sent_at: null, failed_at: null, attempts: 0, last_error: null };
  assert.match(deliveryState(d), />Waiting</);
  assert.match(deliveryState({ ...d, sent_at: '2026-10-08T10:00:00Z', attempts: 1 }), /badge good">Sent/);
  assert.match(
    deliveryState({ ...d, attempts: 2, last_error: 'timed out <x>' }),
    /title="timed out &lt;x&gt;">Retrying/,
  );
  assert.match(
    deliveryState({ ...d, attempts: 6, failed_at: '2026-10-08T10:00:00Z', last_error: '550' }),
    /badge bad" title="550">Gave up/,
  );
});

test('the edit form marks an event stream and its asset, sending only what changed', () => {
  const same = { unit: '°C', rate: '10', description: 'Platen, upper', node: '', events: '', asset: '' };
  assert.deepEqual(changeFrom(same, SIG), {});
  assert.deepEqual(changeFrom({ ...same, events: 'downtime', asset: ' DC-01 ' }, SIG), {
    event_kind: 'downtime',
    asset: 'DC-01',
  });
  const marked = { ...SIG, event_kind: 'scrap', asset: 'DC-01' };
  assert.deepEqual(changeFrom({ ...same, events: 'scrap', asset: 'DC-01' }, marked), {});
  assert.deepEqual(changeFrom({ ...same, events: '', asset: '' }, marked), { event_kind: null, asset: null });
  // Fields the form leaves out are left alone.
  assert.deepEqual(changeFrom({ unit: '°C', rate: '10', description: 'Platen, upper', node: '' }, marked), {});
});
