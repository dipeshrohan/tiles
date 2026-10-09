// Tiles' one version (T6.04), kept the same in every place that states it.
//
//   node scripts/version.js check          every place agrees, and CHANGELOG.md has its section
//   node scripts/version.js set 1.2.3      writes 1.2.3 everywhere (then add its changelog section)
//   node scripts/version.js notes 1.2.3    prints that version's changelog section (release notes)
//
// See docs/releasing.md.

import { readFileSync, writeFileSync } from 'node:fs';
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
  const m = text.match(pattern);
  if (!m) throw new Error(`version not found by ${pattern}`);
  const start = m.index + m[0].lastIndexOf(m[1]);
  return text.slice(0, start) + next + text.slice(start + m[1].length);
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
    .replace(/\n\[[^\]]+\]: \S+/g, '') // link references at the end of the file
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

function notes(version) {
  const section = changelogSection(read('CHANGELOG.md'), version ?? '');
  if (!section) {
    console.error(`CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  console.log(section);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [action, arg] = process.argv.slice(2);
  if (action === 'check') check();
  else if (action === 'set') set(arg);
  else if (action === 'notes') notes(arg);
  else {
    console.error('usage: node scripts/version.js check | set <version> | notes <version>');
    process.exit(2);
  }
}
