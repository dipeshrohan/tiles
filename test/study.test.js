// The usability study's scoring (U6.07, docs/ui/research/README.md): SUS, success without help,
// median times, and the measures against their targets and the baseline.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { readCsv, readRound, report, score, sus, TASKS } from '../scripts/study.js';

test('SUS scores the standard way', () => {
  expect(sus([3, 3, 3, 3, 3, 3, 3, 3, 3, 3])).toBe(50);
  expect(sus([5, 1, 5, 1, 5, 1, 5, 1, 5, 1])).toBe(100);
  expect(sus([1, 5, 1, 5, 1, 5, 1, 5, 1, 5])).toBe(0);
  expect(() => sus([3, 3, 3])).toThrow(/ten answers/);
  expect(() => sus([6, 3, 3, 3, 3, 3, 3, 3, 3, 3])).toThrow(/1 to 5/);
});

test('the CSV reader keeps quoted commas, quotes and new lines', () => {
  const rows = readCsv('\uFEFFa,b\r\n1,"x, ""y""\nz"\n\n2,\n');
  expect(rows).toEqual([
    { a: '1', b: 'x, "y"\nz' },
    { a: '2', b: '' },
  ]);
});

test('a round counts only successes without help, and their median time', () => {
  const round = readRound('test/fixtures/study/baseline');
  const triage = round.tasks.find((t) => t.key === 'triage');
  expect(triage).toMatchObject({ tried: 2, success: 0.5, seconds: 200 });
  expect(round.tasks.find((t) => t.key === 'plot')?.seconds).toBe(120);
  expect(round.sus).toBe(62.5);
  expect(round.participants).toBe(2);
});

test('the report compares a round with the baseline and its targets', () => {
  const md = report(readRound('test/fixtures/study/round'), readRound('test/fixtures/study/baseline'));
  expect(md).toContain('| SUS (mean of 2) | 62.5 | 91.3 | ≥ 75.0 | met |');
  expect(md).toContain('| Triage a warning: median time | 200 s | 140 s | ≤ 140 s | met |');
  expect(md).toContain('| Find a signal and plot it: median time | 120 s | 95 s | ≤ 84 s | not met |');
  expect(md).toContain('| Reach a first useful page as a new user: median time (2) | – | 115 s | ≤ 120 s | met |');
  expect(md).toContain('| Say from Home what needs you now (2) | – | 50% | ≥ 90% | not met |');
  expect(md).toContain('| Set up a new site: success without help (0) | – | – | ≥ 90% | not measured |');
});

test('the SUS target is 10 above a baseline over 65', () => {
  const base = score({ tasks: [], susRows: [{ participant: 'P1', ...answers([4, 2, 4, 2, 4, 2, 4, 2, 4, 2]) }] });
  const now = score({ tasks: [], susRows: [{ participant: 'P2', ...answers([4, 2, 5, 1, 4, 2, 4, 2, 4, 2]) }] });
  expect(report(now, base)).toContain('| SUS (mean of 1) | 75.0 | 80.0 | ≥ 85.0 | not met |');
});

test('a malformed row is refused with its line', () => {
  const row = { participant: 'P1', role: 'engineer', task: 'triage', outcome: 'done', seconds: '10' };
  expect(() => score({ tasks: [row], susRows: [] })).toThrow(/row 2: outcome/);
  expect(() => score({ tasks: [{ ...row, task: 'nap', outcome: 'success' }], susRows: [] })).toThrow(/unknown task/);
  expect(() => score({ tasks: [{ ...row, outcome: 'success', seconds: '' }], susRows: [] })).toThrow(/seconds/);
});

test('every task key in the script is a task the README describes', () => {
  const readme = readFileSync('docs/ui/research/README.md', 'utf8');
  for (const t of TASKS) expect(readme).toContain(`| \`${t.key}\` |`);
});

function answers(list) {
  return Object.fromEntries(list.map((a, i) => [`q${i + 1}`, String(a)]));
}
