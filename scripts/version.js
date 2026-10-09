// Tiles' one version (T6.04), kept the same in every place that states it.
//
//   node scripts/version.js check          every place agrees, and CHANGELOG.md has its section
//   node scripts/version.js set 1.2.3      writes 1.2.3 everywhere (then add its changelog section)
//   node scripts/version.js notes 1.2.3    prints that version's changelog section (release notes);
//                                          with --released, refuses a section still marked Unreleased
//
// See docs/releasing.md.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

// Each place: a file and a pattern whose first group is the version. The patterns are anchored on
// what surrounds the version, so a dependency that happens to share it is never touched.
export const PLACES = [
  { file: 'package.json', pattern: /^ {2}"version": "([^"]+)"/m },
  { file: 'package-lock.json', pattern: /^ {2}"version": "([^"]+)"/m },
  { file: 'package-lock.json', pattern: /^ {4}"": \{\n {6}"name": "tiles",\n {6}"version": "([^"]+)"/m },
  { file: 'api/pyproject.toml', pattern: /^\[project\]\nname = "tiles-api"\nversion = "([^"]+)"/m },
  { file: 'api/uv.lock', pattern: /^name = "tiles-api"\nversion = "([^"]+)"\nsource = \{ editable = "\." \}/m },
  { file: 'edge/pyproject.toml', pattern: /^\[project\]\nname = "tiles-edge"\nversion = "([^"]+)"/m },
  { file: 'edge/uv.lock', pattern: /^name = "tiles-edge"\nversion = "([^"]+)"\nsource = \{ editable = "\." \}/m },
  { file: 'edge/src/tiles_edge/__init__.py', pattern: /^__version__ = "([^"]+)"/m },
  { file: 'deploy/helm/tiles/Chart.yaml', pattern: /^version: (\S+)$/m },
  { file: 'deploy/helm/tiles/Chart.yaml', pattern: /^appVersion: ['"]([^'"]+)['"]$/m },
];

const read = (file) => readFileSync(join(root, file), 'utf8');

// What each place says: [{ file, version }] (version null when the pattern isn't found).
export function found(readFile = read) {
  return PLACES.map(({ file, pattern }) => ({ file, version: readFile(file).match(pattern)?.[1] ?? null }));
}

// The text with the place's version replaced.
export function replaceVersion(text, pattern, next) {
  const m = text.match(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'd')); // d: group offsets
  if (!m) throw new Error(`version not found by ${pattern}`);
  const [start, end] = m.indices[1];
  return text.slice(0, start) + next + text.slice(end);
}

// The heading line of a version's section (`## [1.2.0] - 2026-10-01`, or `- Unreleased` until then).
export function changelogHeading(changelog, version) {
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\].*$`, 'm');
  return changelog.match(heading)?.[0] ?? null;
}

// A version's section of a Keep a Changelog file: the text under `## [x.y.z]`, without the heading.
export function changelogSection(changelog, version) {
  const lines = changelog.split('\n');
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .replace(/^\[(Unreleased|\d+\.\d+\.\d+[^\]]*)\]: \S+$/gm, '') // the versions' links at the end of the file
    .trim();
  return body || null;
}

function check() {
  const places = found();
  const versions = new Set(places.map((p) => p.version));
  const problems = [];
  if (versions.size !== 1 || places[0].version === null) {
    for (const p of places) problems.push(`${p.file}: ${p.version ?? 'version not found'}`);
    problems.unshift('The version differs between files (node scripts/version.js set <version> writes them all):');
  }
  const version = places[0].version;
  if (version && !SEMVER.test(version)) problems.push(`${version} isn't a semantic version`);
  if (version && !changelogSection(read('CHANGELOG.md'), version)) {
    problems.push(`CHANGELOG.md has no section for ${version}`);
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(version);
}

function set(next) {
  if (!SEMVER.test(next ?? '')) throw new Error(`Not a semantic version: ${next}`);
  const files = new Map();
  for (const { file, pattern } of PLACES) {
    files.set(file, replaceVersion(files.get(file) ?? read(file), pattern, next));
  }
  for (const [file, text] of files) writeFileSync(join(root, file), text);
  console.log(`${next} in ${files.size} files. Add a "## [${next}]" section to CHANGELOG.md.`);
}

function notes(version, { released = false } = {}) {
  const changelog = read('CHANGELOG.md');
  if (released && /Unreleased/i.test(changelogHeading(changelog, version ?? '') ?? 'Unreleased')) {
    console.error(`CHANGELOG.md's section for ${version} isn't dated: replace "Unreleased" with the release date`);
    process.exit(1);
  }
  const section = changelogSection(changelog, version ?? '');
  if (!section) {
    console.error(`CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  console.log(section);
}

// Run as a command (paths compared after resolving links, as Node does for import.meta.url).
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const [action, arg, flag] = process.argv.slice(2);
  if (action === 'check') check();
  else if (action === 'set') set(arg);
  else if (action === 'notes') notes(arg, { released: flag === '--released' });
  else {
    console.error('usage: node scripts/version.js check | set <version> | notes <version>');
    process.exit(2);
  }
}
