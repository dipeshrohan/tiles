// DOM helpers that need no DOM: the page a hash names.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { routeOf } from '../js/lib/dom.ts';

test('routeOf reads the page a hash names as the router does', () => {
  assert.equal(routeOf('#/warnings'), 'warnings');
  assert.equal(routeOf('#/Settings'), 'settings');
  assert.equal(routeOf('#/insights/12'), 'insights');
  assert.equal(routeOf('#/explorer?signals=a,b'), 'explorer');
  assert.equal(routeOf('#warnings'), 'warnings');
  assert.equal(routeOf(''), 'home');
  assert.equal(routeOf('#/'), 'home');
});
