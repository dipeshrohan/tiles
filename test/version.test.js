import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLACES, SEMVER, changelogSection, found, replaceVersion } from '../scripts/version.js';

test('every place states the same version, and the changelog has its section', () => {
  const places = found();
  assert.equal(places.length, PLACES.length);
  for (const p of places) assert.notEqual(p.version, null, `${p.file}: version not found`);
  assert.equal(new Set(places.map((p) => p.version)).size, 1, JSON.stringify(places));
  const version = places[0].version;
  assert.match(version, SEMVER);
  assert.ok(changelogSection(readFileSync('CHANGELOG.md', 'utf8'), version), `CHANGELOG.md lacks ${version}`);
});

test('setting a version changes only the version, not a dependency that shares it', () => {
  const lock = [
    '[[package]]\nname = "anyio"\nversion = "0.1.0"\nsource = { registry = "https://pypi.org/simple" }',
    '[[package]]\nname = "tiles-api"\nversion = "0.1.0"\nsource = { editable = "." }',
  ].join('\n\n');
  const { pattern } = PLACES.find((p) => p.file === 'api/uv.lock');
  const next = replaceVersion(lock, pattern, '1.2.3');
  assert.match(next, /name = "anyio"\nversion = "0\.1\.0"/);
  assert.match(next, /name = "tiles-api"\nversion = "1\.2\.3"/);
  assert.throws(() => replaceVersion('nothing here', pattern, '1.2.3'), /version not found/);
});

test('release notes are the changelog section of the version', () => {
  const changelog = [
    '# Changelog',
    '## [Unreleased]',
    '- next',
    '## [1.2.0] - 2026-10-01',
    '### Fixed',
    '- a bug',
    '## [1.1.0] - 2026-09-01',
    '- older',
    '[1.2.0]: https://example.com/1.2.0',
  ].join('\n');
  assert.equal(changelogSection(changelog, '1.2.0'), '### Fixed\n- a bug');
  assert.equal(changelogSection(changelog, '1.1.0'), '- older');
  assert.equal(changelogSection(changelog, '1.2'), null); // not a prefix match
  assert.equal(changelogSection(changelog, '9.9.9'), null);
});

test('versions are semantic', () => {
  for (const ok of ['0.1.0', '1.20.3', '2.0.0-rc.1']) assert.match(ok, SEMVER);
  for (const bad of ['1.2', '01.2.3', 'v1.2.3', '1.2.3.4']) assert.doesNotMatch(bad, SEMVER);
});
