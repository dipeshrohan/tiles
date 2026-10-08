// The warnings inbox's logic (T3.08): filters, actions, the chart's time, and how a warning reads.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  actionsFor,
  activityText,
  chartRange,
  DEFAULT_FILTERS,
  howFar,
  payload,
  queryFor,
  when,
} from '../js/lib/warnings.ts';
import { timeChart } from '../js/lib/svg.ts';

const H = 3_600_000;
const T0 = Date.parse('2026-08-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('the filters become the API query, leaving out what is not narrowed', () => {
  assert.deepEqual(queryFor(DEFAULT_FILTERS), { status: 'unresolved' });
  assert.deepEqual(queryFor({ show: 'resolved', who: 'me', signal: 'open' }), {
    status: 'resolved',
    assignee: 'me',
    state: 'open',
  });
  assert.deepEqual(queryFor({ show: 'all', who: 'none', signal: 'ended' }), {
    status: 'all',
    assignee: 'none',
    state: 'ended',
  });
});

test('engineers and admins act as the workflow allows; viewers only look', () => {
  assert.deepEqual(actionsFor({ status: 'raised' }, 'engineer'), ['acknowledge', 'assign', 'resolve', 'comment']);
  assert.deepEqual(actionsFor({ status: 'acknowledged' }, 'admin'), ['assign', 'resolve', 'comment']);
  assert.deepEqual(actionsFor({ status: 'resolved' }, 'engineer'), ['reopen', 'comment']);
  assert.deepEqual(actionsFor({ status: 'raised' }, 'viewer'), []);
  assert.deepEqual(actionsFor({ status: 'raised' }, null), []);
});

test('the chart shows the warning with the signal before it and a little after, up to now', () => {
  const w = { started_at: iso(T0), last_at: iso(T0 + 2 * H), ended_at: iso(T0 + 2 * H + 60_000) };
  const end = T0 + 2 * H + 60_000;
  const pad = 2 * (end - T0);
  assert.deepEqual(chartRange(w, T0 + 100 * H), { from: T0 - pad, to: end + pad / 2, start: T0, end });
  // Still out: it ends at its last reading, and the chart doesn't run past now.
  const open = { started_at: iso(T0), last_at: iso(T0 + 10 * 60_000), ended_at: null };
  const r = chartRange(open, T0 + 20 * 60_000);
  assert.deepEqual(r, { from: T0 - H, to: T0 + 20 * 60_000, start: T0, end: T0 + 10 * 60_000 });
});

test('a warning reads as how far out it went', () => {
  const w = { peak: 4009.83, baseline: 1850, threshold: 2650, side: 'above' };
  assert.equal(howFar(w), 'Peak 4,010, above the threshold of 2,650 (baseline 1,850; 2.7× the allowed spread)');
  assert.equal(
    howFar({ peak: 0.12, baseline: 0.5, threshold: 0.3, side: 'below' }),
    'Peak 0.12, below the threshold of 0.3 (baseline 0.5; 1.9× the allowed spread)',
  );
});

test('activity reads as sentences', () => {
  const a = (action, extra = {}) => ({
    at: iso(T0),
    action,
    actor: 'eng',
    assignee: null,
    outcome: null,
    note: '',
    ...extra,
  });
  assert.deepEqual(
    [
      a('raised', { actor: null }),
      a('acknowledged'),
      a('assigned', { assignee: 'eng2' }),
      a('unassigned'),
      a('resolved', { outcome: 'false_alarm' }),
      a('reopened'),
      a('commented'),
    ].map(activityText),
    [
      'Raised by the detector',
      'eng acknowledged it',
      'eng assigned it to eng2',
      'eng unassigned it',
      'eng resolved it: false alarm',
      'eng reopened it',
      'eng commented',
    ],
  );
});

test('the payload lists what the detector saw and how it was set', () => {
  const rows = payload({
    signal_tag: 'dc1.friction',
    detector: 'dc1-friction',
    side: 'above',
    peak: 4009.83,
    threshold: 2650,
    baseline: 1850,
    readings: 82,
    started_at: iso(T0),
    last_at: iso(T0 + H),
    ended_at: null,
    detector_config: { window: 200, flat_spread: 1 },
  });
  assert.deepEqual(rows.slice(0, 3), [
    ['Signal', 'dc1.friction'],
    ['Detector', 'dc1-friction'],
    ['Side', 'above'],
  ]);
  assert.deepEqual(rows.slice(-3), [
    ['Back in', 'still out'],
    ['Detector window', '200'],
    ['Detector flat spread', '1'],
  ]);
});

test('the chart draws reference levels in view and shades the warning', () => {
  const points = [0, 1, 2].map((i) => ({ t: T0 + i * H, v: 10 + i, lo: 10 + i, hi: 10 + i }));
  const svg = timeChart({
    points,
    from: T0,
    to: T0 + 2 * H,
    gap: 2 * H,
    levels: [{ v: 50, label: 'threshold <x>' }],
    spans: [{ from: T0 + H, to: T0 + 5 * H }],
  });
  assert.equal((svg.match(/class="level"/g) ?? []).length, 1);
  assert.match(svg, /threshold &lt;x&gt;/);
  // The level at 50 is in view: the top tick is at least 50.
  const ticks = [...svg.matchAll(/class="tick"[^>]*text-anchor="end">([\d.,]+)</g)].map((m) =>
    Number(m[1].replace(/,/g, '')),
  );
  assert.ok(Math.max(...ticks) >= 50, ticks.join());
  // The span is clipped to the axis: from the middle to the right edge.
  const [, x, width] = svg.match(/class="span" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/);
  const plain = timeChart({ points, from: T0, to: T0 + 2 * H, gap: 2 * H });
  assert.doesNotMatch(plain, /class="span"|class="level"/);
  assert.ok(Number(x) > 100 && Number(x) + Number(width) <= 900, `${x} ${width}`);
});

test('times read as minutes or hours ago today, else as a date and time', () => {
  const now = T0 + 20 * H;
  assert.equal(when(iso(now - 20_000), now), 'just now');
  assert.equal(when(iso(now - 57 * 60_000), now), '57 min ago');
  assert.equal(when(iso(now - 3 * H - 1), now), '3 h ago');
  assert.match(when(iso(now - 13 * H), now), /^\d+ Aug 2026, \d\d:\d\d$/);
  assert.match(when(iso(now + H), now), /2026/); // a clock ahead: no "ago"
});

test('labels of reference levels close together are kept apart', () => {
  const points = [0, 1].map((i) => ({ t: T0 + i * H, v: 4000 * i, lo: 4000 * i, hi: 4000 * i }));
  const svg = timeChart({
    points,
    from: T0,
    to: T0 + H,
    gap: 2 * H,
    levels: [
      { v: 1810, label: 'threshold' },
      { v: 1800, label: 'baseline' },
    ],
  });
  const ys = [
    ...svg.matchAll(/<text class="axis" x="[\d.]+" y="([\d.]+)" text-anchor="end">(threshold|baseline)</g),
  ].map((m) => Number(m[1]));
  assert.equal(ys.length, 2);
  assert.ok(Math.abs(ys[0] - ys[1]) >= 12, ys.join());
});
