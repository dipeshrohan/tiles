// The ROI report's browser side (T6.01): the form as the API's request, on the site's clock.
import { afterEach, expect, test } from 'vitest';
import { setTimeZone } from '../js/lib/format.ts';
import { change, defaultPeriods, fileName, roiRequest } from '../js/lib/roi.ts';

afterEach(() => setTimeZone(null));

const form = (extra = {}) => ({
  baselineFrom: '2026-03-01',
  baselineTo: '2026-03-31',
  pilotFrom: '2026-04-01',
  pilotTo: '2026-04-30',
  ...extra,
});

test('each period runs from its first day to the end of its last, on the site clock', () => {
  setTimeZone('Europe/Berlin');
  const r = roiRequest(form(), 8, ['DT-SEIZURE']);
  // Berlin moves to summer time on 29 March: the baseline starts at +01:00 and ends at +02:00.
  expect(r).toMatchObject({
    baseline_start: '2026-02-28T23:00:00.000Z',
    baseline_end: '2026-03-31T22:00:00.000Z',
    pilot_start: '2026-03-31T22:00:00.000Z',
    pilot_end: '2026-04-30T22:00:00.000Z',
    horizon_hours: 8,
    codes: ['DT-SEIZURE'],
    hours_per_stop: null,
    currency: null,
    baseline_parts: null,
  });
});

test('amounts, the source and the currency are sent as numbers and trimmed text', () => {
  const r = roiRequest(
    form({
      hoursPerStop: '2.5',
      hoursSource: ' MES ',
      costPerHour: '1000',
      currency: 'eur',
      baselineParts: '40000',
      pilotParts: '5000',
    }),
    4,
    [],
  );
  expect(r).toMatchObject({
    hours_per_stop: 2.5,
    hours_source: 'MES',
    cost_per_hour: 1000,
    cost_per_scrap: null,
    currency: 'EUR',
    baseline_parts: 40000,
    pilot_parts: 5000,
  });
});

test('wrong fields are named', () => {
  const names = (f) => roiRequest(f, 8, []).map((e) => e.name);
  expect(names(form({ pilotFrom: '' }))).toEqual(['pilotFrom']);
  expect(names(form({ baselineTo: '2026-02-01' }))).toEqual(['baselineTo']);
  expect(names(form({ baselineTo: '2026-04-01' }))).toEqual(['baselineTo']); // overlaps the pilot
  expect(names(form({ pilotTo: '2026-03-01' }))).toEqual(['pilotTo']);
  expect(names(form({ costPerHour: '-1', currency: 'euro' }))).toEqual(['costPerHour', 'currency']);
  expect(names(form({ pilotParts: '5000' }))).toEqual(['baselineParts']); // both or neither
  expect(names(form({ baselineParts: '0', pilotParts: 'x' }))).toEqual(['pilotParts', 'baselineParts']);
  expect(roiRequest(form({ baselineTo: '2026-03-31' }), 8, [])).not.toBeInstanceOf(Array); // the day before is fine
});

test('the first periods are the last 30 days and the 90 before them', () => {
  setTimeZone('UTC');
  expect(defaultPeriods(Date.parse('2026-10-15T09:00:00Z'))).toEqual({
    baselineFrom: '2026-06-18',
    baselineTo: '2026-09-15',
    pilotFrom: '2026-09-16',
    pilotTo: '2026-10-15',
  });
});

test('the change from the baseline, and the file named by the pilot days on the site clock', () => {
  expect(change(0.5, 0.125)).toBe(-0.75);
  expect(change(0, 1)).toBeNull();
  expect(change(null, 1)).toBeNull();
  setTimeZone('Europe/Berlin');
  const pilot = { start: '2026-05-31T22:00:00Z', end: '2026-06-30T22:00:00Z' };
  expect(fileName({ periods: { pilot } })).toBe('roi-2026-06-01-2026-06-30.md');
});
