import { describe, expect, it } from 'vitest';
import { laneChart } from '../js/lib/svg.ts';
import { itemsOf, lanesOf, rangeOf } from '../js/lib/timeline.ts';

const tl = {
  machine: 'dc1',
  label: 'Die caster 1',
  asset: 'DC-01',
  start: '2026-10-10T00:00:00Z',
  end: '2026-10-17T00:00:00Z',
  signals: [],
  more_signals: false,
  warnings: [
    {
      id: 'w1',
      detector: 'friction',
      tag: 'dc1.friction',
      started_at: '2026-10-12T08:00:00Z',
      ended_at: '2026-10-12T09:00:00Z',
      status: 'resolved',
      outcome: 'true_alarm',
    },
    {
      id: 'w2',
      detector: 'friction',
      tag: 'dc1.friction',
      started_at: '2026-10-16T08:00:00Z',
      ended_at: null,
      status: 'open',
      outcome: null,
    },
  ],
  events: [
    { at: '2026-10-12T10:00:00Z', kind: 'downtime', code: 'DT-SEIZURE', tag: 'mes.dc1', planned: false },
    { at: '2026-10-13T10:00:00Z', kind: 'downtime', code: 'PM', tag: 'mes.dc1', planned: true },
    { at: '2026-10-14T10:00:00Z', kind: 'scrap', code: '3', tag: 'mes.scrap', planned: false },
  ],
  planned: [{ id: 'p1', asset: null, starts_at: '2026-10-13T09:00:00Z', ends_at: '2026-10-13T11:00:00Z', reason: '' }],
  changes: [
    { at: '2026-10-11T07:00:00Z', kind: 'ontology', action: 'New PLC', subject: '#4', author: 'Ana' },
    { at: '2026-10-15T07:00:00Z', kind: 'detector', action: 'detector.update', subject: 'friction', author: 'Ben' },
    { at: '2026-10-15T08:00:00Z', kind: 'signal', action: 'signal.later', subject: 'dc1.friction', author: 'Ben' },
  ],
  more: false,
};

describe('machine timeline (T10.01)', () => {
  it('puts everything in time order, in words', () => {
    const items = itemsOf(tl);
    expect(items.map((i) => [i.kind, i.what, i.detail])).toEqual([
      ['change', 'New PLC', 'Plant model change #4 by Ana'],
      ['warning', 'friction', 'dc1.friction, resolved as a true alarm'],
      ['downtime', 'DT-SEIZURE', 'mes.dc1'],
      ['planned', 'Planned stop', 'Whole site'],
      ['downtime', 'PM', 'mes.dc1, planned downtime'],
      ['scrap', '3', 'mes.scrap'],
      ['change', 'Detector friction changed', 'Ben'],
      ['change', 'signal.later', 'Ben'], // an action this version doesn't know, as it is
      ['warning', 'friction', 'dc1.friction, open'],
    ]);
    // A warning still out runs to the range's end.
    expect(items.at(-1).to).toBe(Date.parse(tl.end));
  });
  it('makes lanes of them', () => {
    const lanes = lanesOf(itemsOf(tl));
    expect(lanes.map((l) => [l.label, l.marks.length])).toEqual([
      ['Warnings', 2],
      ['Stops', 2],
      ['Other events', 1],
      ['Planned stops', 1],
      ['Changes', 3],
    ]);
    expect(lanes[0].marks[0]).toMatchObject({
      from: Date.parse('2026-10-12T08:00:00Z'),
      to: Date.parse('2026-10-12T09:00:00Z'),
    });
    expect(lanes[1].marks[0].to).toBeUndefined(); // an instant
  });
  it('draws the lanes on the time axis, named and summed up', () => {
    const svg = laneChart({
      lanes: lanesOf(itemsOf(tl)),
      from: Date.parse(tl.start),
      to: Date.parse(tl.end),
      title: 'What happened on Die caster 1',
    });
    expect(svg).toContain('role="img"');
    expect(svg).toMatch(
      /aria-label="What happened on Die caster 1\. from [^"]*; Warnings: 2; Stops: 2; Other events: 1; Planned stops: 1; Changes: 3"/,
    );
    expect((svg.match(/<rect /g) ?? []).length).toBe(3); // two warnings and the planned stop
    expect((svg.match(/<circle /g) ?? []).length).toBe(6);
    expect(svg).toContain('<title>');
  });
  it('asks for the range ending now', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    expect(rangeOf('day', now)).toEqual({ from: '2026-10-16T12:00:00.000Z', to: '2026-10-17T12:00:00.000Z' });
    expect(rangeOf('month', now).from).toBe('2026-09-17T12:00:00.000Z');
  });
});
