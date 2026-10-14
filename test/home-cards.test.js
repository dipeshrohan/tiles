import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  agentProblems,
  CARDS,
  cleanCards,
  homeRole,
  machinesOut,
  moveCard,
  myWarnings,
  needsOf,
  qualityProblems,
  reviewsForMe,
  ROLE_CARDS,
  shiftStart,
  shiftSummary,
  staleSignals,
} from '../js/lib/home-cards.ts';
import { WORK_ROLES } from '../js/lib/welcome.ts';

const w = (o) => ({
  id: o.id,
  signal_tag: o.id,
  status: 'raised',
  ended_at: null,
  assignee_id: null,
  started_at: '2026-10-14T10:00:00Z',
  acknowledged_at: null,
  ...o,
});

test('each role has its cards, from the welcome or else the site role', () => {
  for (const r of WORK_ROLES) assert.ok(ROLE_CARDS[r.id], r.id); // every welcome role
  for (const cards of Object.values(ROLE_CARDS)) for (const id of cards) assert.ok(CARDS.some((c) => c.id === id));
  assert.equal(homeRole('shift-lead', 'viewer'), 'shift-lead');
  assert.equal(homeRole(null, 'admin'), 'admin');
  assert.equal(homeRole(null, 'engineer'), 'engineer');
  assert.equal(homeRole('pilot', 'viewer'), 'maintenance');
  assert.equal(homeRole(null, null), 'maintenance');
});

test('cards as kept: known ones, once each, in order; moved within bounds; their needs', () => {
  assert.deepEqual(cleanCards(['reviews', 'nope', 'reviews', 'agents', 7]), ['reviews', 'agents']);
  assert.equal(cleanCards(null), null);
  assert.deepEqual(cleanCards([]), []);
  assert.deepEqual(moveCard(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
  assert.deepEqual(moveCard(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveCard(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
  assert.deepEqual(needsOf(['machines-out', 'freshness']), ['open-warnings', 'signals']);
});

test('my warnings: assigned to me, not resolved, still out first', () => {
  const list = [
    w({ id: 'a', assignee_id: 'me', ended_at: '2026-10-14T11:00:00Z', started_at: '2026-10-14T12:00:00Z' }),
    w({ id: 'b', assignee_id: 'me' }),
    w({ id: 'c', assignee_id: 'me', status: 'resolved' }),
    w({ id: 'd', assignee_id: 'you' }),
  ];
  assert.deepEqual(
    myWarnings(list, 'me').map((x) => x.id),
    ['b', 'a'],
  );
  assert.deepEqual(myWarnings(list, null), []);
});

test('machines out: the ones with a signal still out', () => {
  const tiles = [
    { id: 'm1', state: 'out' },
    { id: 'm2', state: 'taken' },
    { id: 'm3', state: 'ok' },
  ];
  assert.deepEqual(
    machinesOut(tiles).map((t) => t.id),
    ['m1'],
  );
});

test('the shift under way starts at 06:00, 14:00 or 22:00, and counts what was raised since', () => {
  const at = (h, m = 0) => new Date(2026, 9, 14, h, m);
  assert.equal(shiftStart(at(13, 59)).getTime(), at(6).getTime());
  assert.equal(shiftStart(at(14)).getTime(), at(14).getTime());
  assert.equal(shiftStart(at(23, 5)).getTime(), at(22).getTime());
  assert.equal(shiftStart(at(3)).getTime(), new Date(2026, 9, 13, 22).getTime());
  const start = at(6);
  const s = shiftSummary(
    [
      w({ id: 'old', started_at: at(5).toISOString() }),
      w({ id: 'new', started_at: at(9).toISOString() }),
      w({ id: 'ack', started_at: at(8).toISOString(), status: 'acknowledged' }),
      w({ id: 'done', started_at: at(7).toISOString(), status: 'resolved' }),
    ],
    start,
  );
  assert.deepEqual(
    s.raised.map((x) => x.id),
    ['new', 'ack', 'done'],
  );
  assert.equal(s.acknowledged, 2);
  assert.deepEqual(
    s.waiting.map((x) => x.id),
    ['new'],
  );
});

test('reviews for me: open, not mine, asked of me or anyone, waiting longest first', () => {
  const r = (o) => ({ status: 'open', author_id: 'ana', reviewer_id: null, created_at: '2026-10-14T10:00:00Z', ...o });
  const list = [
    r({ number: 1, created_at: '2026-10-14T12:00:00Z' }),
    r({ number: 2, author_id: 'me' }),
    r({ number: 3, reviewer_id: 'bo' }),
    r({ number: 4, reviewer_id: 'me', created_at: '2026-10-14T09:00:00Z' }),
    r({ number: 5, status: 'approved' }),
  ];
  assert.deepEqual(
    reviewsForMe(list, 'me').map((x) => x.number),
    [4, 1],
  );
});

test('stale signals: nothing for 15 min, or ten sample periods; events left out; stalest first', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const s = (tag, minutes, o = {}) => ({
    tag,
    last_at: minutes === null ? null : new Date(now - minutes * 60_000).toISOString(),
    sample_rate_hz: null,
    event_kind: null,
    ...o,
  });
  const out = staleSignals(
    [
      s('fresh', 5),
      s('old', 20),
      s('older', 120),
      s('never', null),
      s('slow', 20, { sample_rate_hz: 1 / 300 }), // every 5 min: 50 min before it is stale
      s('downtime', 600, { event_kind: 'downtime' }),
    ],
    now,
  );
  assert.deepEqual(
    out.map((x) => x.tag),
    ['older', 'old', 'never'],
  );
});

test('agents and quality: what needs someone, worst first', () => {
  assert.deepEqual(
    agentProblems([
      { name: 'b', status: 'never seen' },
      { name: 'a', status: 'online' },
      { name: 'c', status: 'offline' },
    ]).map((a) => a.name),
    ['c', 'b'],
  );
  assert.deepEqual(
    qualityProblems([
      { tag: 'x', quality: { badge: 'warn' } },
      { tag: 'y', quality: { badge: 'bad' } },
      { tag: 'z', quality: { badge: 'good' } },
      { tag: 'w', quality: null },
    ]).map((s) => s.tag),
    ['y', 'x'],
  );
});
