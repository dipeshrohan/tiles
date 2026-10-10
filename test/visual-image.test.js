// The visual regression baselines (U1.08) are made in the Playwright container: CI's job and
// `npm run test:visual` must use the image for the playwright version in package.json.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const { devDependencies } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

test("CI's visual job uses the Playwright image of package.json's version", () => {
  const images = [...ci.matchAll(/mcr\.microsoft\.com\/playwright:v([\d.]+)-noble/g)].map((m) => m[1]);
  assert.deepEqual(images, [devDependencies.playwright]);
});
