import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { advisories, problems } from '../scripts/npm-audit.js';

const report = {
  vulnerabilities: {
    picomatch: {
      via: [{ name: 'picomatch', severity: 'high', title: 'ReDoS', url: 'https://github.com/advisories/GHSA-aaaa' }],
    },
    vite: { via: ['picomatch'] }, // names another package's advisory: counted once
    fast: { via: [{ name: 'fast', severity: 'moderate', title: 'Spoofing', url: 'https://x/GHSA-bbbb' }] },
  },
};

test('each advisory is read once, with its id from the link', () => {
  assert.deepEqual(
    advisories(report).map((a) => [a.id, a.severity]),
    [
      ['GHSA-aaaa', 'high'],
      ['GHSA-bbbb', 'moderate'],
    ],
  );
});

test('a severe advisory fails unless allowed; an allowance expires and must still match', () => {
  const found = advisories(report);
  assert.equal(problems(found, [], '2026-11-17').length, 1); // the high one; moderate passes
  assert.deepEqual(problems(found, [{ id: 'GHSA-aaaa', until: '2026-12-15' }], '2026-11-17'), []);
  assert.match(problems(found, [{ id: 'GHSA-aaaa', until: '2026-11-01' }], '2026-11-17').join(), /look at it again/);
  assert.match(problems([], [{ id: 'GHSA-aaaa', until: '2026-12-15' }], '2026-11-17').join(), /no longer reported/);
});

test('every allowance says what, why and until when', () => {
  const allowed = JSON.parse(readFileSync(new URL('../scripts/npm-audit-allow.json', import.meta.url), 'utf8'));
  for (const a of allowed) {
    assert.match(a.id, /^GHSA-/);
    assert.ok(a.package && a.reason.length > 40, a.id);
    assert.match(a.until, /^\d{4}-\d{2}-\d{2}$/);
  }
});
