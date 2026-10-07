// Shared ontology parity suite: test/fixtures/ontology-parity.json is also
// run by the Python API (api/tests/test_ontology_parity.py), so both
// implementations must give identical results.
// Regenerate expectations: UPDATE_FIXTURES=1 npx vitest run test/ontology-parity.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRepo, stage, commit, revert, discard, workingGraph, healthCheck } from '../js/lib/ontology.ts';

const file = new URL('./fixtures/ontology-parity.json', import.meta.url);
const suite = JSON.parse(readFileSync(file, 'utf8'));
const update = process.env.UPDATE_FIXTURES === '1';

// Runs a case and returns what both implementations must agree on. Commit ids
// are random, so history is compared without them.
export function runCase(steps) {
  let repo = createRepo();
  const errors = [];
  for (const step of steps) {
    try {
      if ('stage' in step) repo = stage(repo, step.stage);
      else if ('discard' in step) repo = discard(repo);
      else if ('commit' in step) repo = commit(repo, step.commit);
      else if ('revert' in step) {
        const target = repo.history[step.revert];
        repo = revert(repo, target ? target.id : `missing-${step.revert}`, { author: step.author, date: step.date });
      } else throw new Error(`Unknown step ${JSON.stringify(step)}`);
      errors.push(null);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  const working = workingGraph(repo);
  return {
    errors,
    head: repo.head,
    working,
    staged: repo.staged,
    history: repo.history.map(({ id: _id, ...rest }) => rest),
    health: healthCheck(working),
  };
}

for (const c of suite.cases) {
  test(`parity: ${c.name}`, () => {
    const actual = JSON.parse(JSON.stringify(runCase(c.steps)));
    if (update) c.expect = actual;
    else assert.deepEqual(actual, c.expect);
    // Steps marked as errors must fail, and only those.
    assert.deepEqual(
      actual.errors.map((e) => e !== null),
      c.steps.map((s) => s.error === true),
    );
  });
}

test('parity fixtures are up to date', () => {
  if (update) writeFileSync(file, JSON.stringify(suite, null, 2) + '\n');
  assert.ok(suite.cases.every((c) => c.expect));
});
