import { test } from 'vitest';
import assert from 'node:assert/strict';
import { importSummary } from '../js/views/ontology.ts';

const none = { add_nodes: 0, remove_nodes: 0, set_props: 0, remove_props: 0, add_edges: 0, remove_edges: 0 };

test('an import is summed up in words, plurals and all', () => {
  assert.equal(
    importSummary({ ...none, add_nodes: 2, set_props: 1, remove_edges: 3 }),
    '2 new nodes, 1 property set, 3 relationships removed',
  );
  assert.equal(importSummary(none), 'nothing to change: the ontology already matches the file');
});
