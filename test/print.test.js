// Print (U6.05): the app's address the stylesheet writes before Tiles' own links.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { printBase } from '../js/lib/print.ts';

test('the address printed before a link is the app’s, as a CSS string, from http(s) only', () => {
  assert.equal(printBase('https://tiles.example.com/app/?api=x#/warnings'), '"https://tiles.example.com/app/?api=x"');
  assert.equal(printBase('http://127.0.0.1:5173/'), '"http://127.0.0.1:5173/"');
  assert.equal(printBase('https://example.com/"quoted"#/x'), '"https://example.com/\\"quoted\\""');
  assert.equal(printBase('file:///C:/Users/someone/tiles/index.html#/warnings'), null);
});
