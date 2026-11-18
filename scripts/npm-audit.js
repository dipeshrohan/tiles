// The npm dependencies' advisories (CI's Dependency and container scanning job): a high or critical
// one fails the build, as Trivy's do for the images, unless no release fixes it yet and it is in
// scripts/npm-audit-allow.json with why it can wait and the date to look again. An entry past that
// date, or one that matches nothing any more, fails too, so the list stays short and true.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const SEVERE = new Set(['high', 'critical']);

// Every advisory of `npm audit --json`, once each: its GHSA id, package, severity and title.
export function advisories(report) {
  const seen = new Map();
  for (const v of Object.values(report.vulnerabilities ?? {}))
    for (const via of v.via)
      if (typeof via === 'object') {
        const id = via.url.split('/').pop();
        seen.set(id, { id, name: via.name, severity: via.severity, title: via.title });
      }
  return [...seen.values()];
}

// What fails: severe advisories not allowed, allowed ones past their date, and allowed ones gone.
export function problems(found, allowed, today) {
  const ids = new Set(found.map((a) => a.id));
  const ok = new Set(allowed.filter((a) => a.until >= today).map((a) => a.id));
  return [
    ...found
      .filter((a) => SEVERE.has(a.severity) && !ok.has(a.id))
      .map((a) => `${a.id} (${a.severity}, ${a.name}): ${a.title}`),
    ...allowed.filter((a) => a.until < today).map((a) => `${a.id}: allowed until ${a.until}; look at it again`),
    ...allowed.filter((a) => !ids.has(a.id)).map((a) => `${a.id}: allowed but no longer reported; remove it`),
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let out;
  try {
    out = execFileSync('npm', ['audit', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = e.stdout; // npm audit exits 1 when it finds anything
  }
  const allowed = JSON.parse(readFileSync(join(root, 'scripts/npm-audit-allow.json'), 'utf8'));
  const found = advisories(JSON.parse(out));
  const failed = problems(found, allowed, new Date().toISOString().slice(0, 10));
  for (const a of found) console.log(`${a.severity.padEnd(8)} ${a.id} ${a.name}: ${a.title}`);
  for (const p of failed) console.error(p);
  if (failed.length) process.exit(1);
}
