// A scroll started from script follows reduced motion, the system's or Tiles' own (U3.01).
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { scrollBehavior } from '../js/lib/dom.ts';

const saved = { document: globalThis.document, matchMedia: globalThis.matchMedia };
afterEach(() => Object.assign(globalThis, saved));

const page = (motion, systemReduces) => {
  globalThis.document = { documentElement: { dataset: motion ? { motion } : {} } };
  globalThis.matchMedia = (q) => ({ matches: systemReduces && q.includes('reduce') });
};

test('smooth unless less motion is asked for', () => {
  page(undefined, false);
  assert.equal(scrollBehavior(), 'smooth');
  page(undefined, true);
  assert.equal(scrollBehavior(), 'auto');
  page('reduce', false);
  assert.equal(scrollBehavior(), 'auto');
});
