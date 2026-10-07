import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRepo,
  stage,
  commit,
  revert,
  discard,
  workingGraph,
  healthCheck,
  pathTo,
  applyOp,
} from '../js/lib/ontology.js';
import { seedOntology } from '../js/lib/data.js';

const node = (id, type = 'Machine', props = { vendor: 'x' }) => ({
  kind: 'addNode',
  node: { id, type, label: id, props },
});
const edge = (from, rel, to) => ({ kind: 'addEdge', edge: { id: `${from}-${rel}-${to}`, from, rel, to } });

test('staged changes are visible in the working graph but not in head', () => {
  const repo = stage(createRepo(), node('a'));
  assert.ok(workingGraph(repo).nodes.a);
  assert.equal(repo.head.nodes.a, undefined);
  assert.equal(discard(repo).staged.length, 0);
});

test('commit records stats and revert restores the previous graph', () => {
  let repo = createRepo();
  repo = stage(repo, node('a'));
  repo = stage(repo, node('b'));
  repo = stage(repo, edge('a', 'feeds', 'b'));
  repo = commit(repo, { message: 'first', author: 't' });
  const before = JSON.stringify(repo.head);
  repo = stage(repo, { kind: 'setProp', id: 'a', key: 'vendor', value: 'y' });
  repo = stage(repo, node('c'));
  repo = commit(repo, { message: 'second', author: 't' });
  assert.deepEqual(repo.history[0].stats, { nodes: 1, edges: 0, props: 1 });
  repo = revert(repo, repo.history[0].id, { author: 't' });
  assert.equal(JSON.stringify(repo.head), before);
  assert.equal(repo.history[0].message, 'Revert "second"');
});

test('revert survives a JSON round trip (persisted repos)', () => {
  let repo = createRepo();
  repo = commit(stage(repo, node('a')), { message: 'a', author: 't' });
  repo = commit(stage(repo, { kind: 'setProp', id: 'a', key: 'note', value: 'hi' }), { message: 'note', author: 't' });
  repo = JSON.parse(JSON.stringify(repo));
  repo = revert(repo, repo.history[0].id, { author: 't' });
  assert.equal(repo.head.nodes.a.props.note, undefined);
});

test('invalid operations are rejected', () => {
  const repo = stage(createRepo(), node('a'));
  assert.throws(() => stage(repo, node('a')), /already exists/);
  assert.throws(() => stage(repo, edge('a', 'feeds', 'missing')), /missing node/);
  assert.throws(
    () =>
      applyOp(workingGraph(stage(stage(repo, node('b')), edge('a', 'feeds', 'b'))), { kind: 'removeNode', id: 'a' }),
    /relationship/,
  );
  assert.throws(() => commit(createRepo(), { message: 'x', author: 't' }), /Nothing to commit/);
  assert.throws(() => commit(repo, { message: '  ', author: 't' }), /message/);
});

test('health check finds orphans, duplicates and missing props', () => {
  let repo = createRepo();
  for (const op of [
    node('a'),
    node('b', 'Machine', {}),
    node('lonely'),
    edge('a', 'feeds', 'b'),
    { kind: 'addEdge', edge: { id: 'dup', from: 'a', rel: 'feeds', to: 'b' } },
  ]) {
    repo = stage(repo, op);
  }
  const kinds = healthCheck(workingGraph(repo)).issues.map((i) => `${i.kind}:${i.ref}`);
  assert.ok(kinds.includes('orphan:lonely'));
  assert.ok(kinds.includes('duplicate:dup'));
  assert.ok(kinds.includes('missing-prop:b'));
});

test('seed ontology has a full site hierarchy and one orphan tag', () => {
  const graph = workingGraph(seedOntology());
  assert.deepEqual(
    pathTo(graph, 'm-dc02').map((n) => n.type),
    ['Site', 'Workcenter', 'Line', 'Machine'],
  );
  const orphans = healthCheck(graph).issues.filter((i) => i.kind === 'orphan');
  assert.deepEqual(
    orphans.map((o) => o.ref),
    ['sig-legacy'],
  );
});
