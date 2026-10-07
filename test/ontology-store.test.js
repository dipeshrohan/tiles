import { test } from 'vitest';
import assert from 'node:assert/strict';
import { localStore, remoteStore, pickSite, historyOps, safeWorkingGraph } from '../js/lib/ontology-store.ts';
import { applyOps, createRepo, emptyGraph, stage, workingGraph } from '../js/lib/ontology.ts';
import { seedOntology } from '../js/lib/data.ts';

const site = { id: 's1', slug: 'plant-1', name: 'Plant 1', org: 'demo' };
const node = (id) => ({ kind: 'addNode', node: { id, type: 'Line', label: id, props: {} } });

// A stand-in for the API client that records calls and serves a fixed repo.
function fakeApi(served = { head: emptyGraph(), staged: [], history: [] }, sites = [site]) {
  const calls = [];
  const rec =
    (name, result) =>
    async (...args) => {
      calls.push([name, ...args]);
      return typeof result === 'function' ? result(...args) : result;
    };
  return {
    calls,
    sites: rec('sites', sites),
    ontology: {
      graph: rec('graph', (_s, view) => (view === 'head' ? served.head : workingGraph(served))),
      staged: rec('staged', () => served.staged),
      history: rec('history', () => served.history),
      stage: rec('stage', []),
      stageMany: rec('stageMany', []),
      discard: rec('discard', undefined),
      commit: rec('commit', {}),
      revert: rec('revert', {}),
    },
  };
}

test('local store applies changes in this browser', async () => {
  let repo = await localStore.stage(createRepo(), [node('a'), node('b')]);
  assert.equal(repo.staged.length, 2);
  repo = await localStore.commit(repo, 'two lines', 'me');
  assert.deepEqual(Object.keys(repo.head.nodes), ['a', 'b']);
  repo = await localStore.revert(repo, repo.history[0].id, 'me');
  assert.deepEqual(repo.head.nodes, {});
  assert.equal((await localStore.discard(stage(repo, node('c')))).staged.length, 0);
});

test('remote store loads head, staged ops and history from the API', async () => {
  const served = { head: applyOps(emptyGraph(), [node('a')]).graph, staged: [node('b')], history: [{ id: 'c1' }] };
  const api = fakeApi(served);
  const repo = await remoteStore(api, site).load();
  assert.deepEqual(repo, served);
  assert.deepEqual(
    api.calls.map((c) => c.slice(0, 3)),
    [
      ['graph', 's1', 'head'],
      ['staged', 's1'],
      ['history', 's1', { limit: 500 }],
    ],
  );
});

test('remote store checks a whole batch before sending any of it', async () => {
  const api = fakeApi();
  const store = remoteStore(api, site);
  await assert.rejects(store.stage(createRepo(), [node('a'), node('a')]), /already exists/);
  assert.equal(api.calls.filter((c) => c[0] === 'stageMany').length, 0);
  await store.stage(createRepo(), [node('a'), node('b')]);
  // One all-or-nothing request, so a failure can't leave half a batch staged.
  const batches = api.calls.filter((c) => c[0] === 'stageMany');
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0][2].map((op) => op.node.id),
    ['a', 'b'],
  );
});

test('remote commit, revert and discard call the API and reload', async () => {
  const api = fakeApi();
  const store = remoteStore(api, site);
  await store.commit(createRepo(), 'msg', 'me');
  await store.revert(createRepo(), 'c9', 'me');
  await store.discard(createRepo());
  const writes = api.calls.filter((c) => ['commit', 'revert', 'discard'].includes(c[0]));
  assert.deepEqual(writes, [
    ['commit', 's1', 'msg'],
    ['revert', 's1', 'c9'],
    ['discard', 's1'],
  ]);
  assert.equal(api.calls.filter((c) => c[0] === 'graph').length, 3);
});

test('pickSite prefers the saved site, falls back to the first, and explains an empty API', async () => {
  const other = { ...site, id: 's2', name: 'Plant 2' };
  assert.equal((await pickSite(fakeApi(undefined, [site, other]), 's2')).id, 's2');
  assert.equal((await pickSite(fakeApi(undefined, [site, other]), 'gone')).id, 's1');
  await assert.rejects(pickSite(fakeApi(undefined, [])), /no sites yet/);
});

test('replaying the demo history rebuilds the demo graph', () => {
  const seed = seedOntology();
  const { graph } = applyOps(emptyGraph(), historyOps(seed));
  assert.deepEqual(graph, seed.head);
});

test('staged ops that no longer fit the head are reported, not thrown', () => {
  const head = applyOps(emptyGraph(), [node('a')]).graph;
  const ok = safeWorkingGraph({ head, history: [], staged: [node('b')] });
  assert.equal(ok.conflict, null);
  assert.deepEqual(Object.keys(ok.graph.nodes), ['a', 'b']);
  // Someone removed node a; our staged setProp on it no longer applies.
  const stale = safeWorkingGraph({
    head: emptyGraph(),
    history: [],
    staged: [{ kind: 'setProp', id: 'a', key: 'k', value: 1 }],
  });
  assert.equal(stale.conflict, 'Node a not found');
  assert.deepEqual(stale.graph, emptyGraph());
});
