// Numbers and dates are written as the person's language writes them (U6.02): through
// js/lib/format.ts, never with a locale written into the code (`toLocaleString('en-GB')`,
// `new Intl.NumberFormat('en-US')`). A locale held in a const (reading parts to parse, not to show)
// is the one way round it. In `npm run lint`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const walk = (dir) =>
  readdirSync(join(root, dir)).flatMap((f) => {
    const path = `${dir}/${f}`;
    if (statSync(join(root, path)).isDirectory()) return walk(path);
    return /\.ts$/.test(f) ? [path] : [];
  });

// toLocaleString('…'), toLocaleDateString('…'), toLocaleTimeString('…'), new Intl.X('…'), Intl.X('…').
const FIXED = /\.toLocale(?:Date|Time)?String\(\s*['"`]|\bIntl\.\w+\(\s*['"`]/;
// …and toLocaleString() with no locale at all: the browser's, not the person's chosen one.
const BROWSER = /\.toLocale(?:Date|Time)?String\(\s*\)/;

export function findFixed(src) {
  return src
    .split('\n')
    .flatMap((line, i) => (FIXED.test(line) || BROWSER.test(line) ? [{ line: i + 1, text: line.trim() }] : []));
}

export function check() {
  return ['js/app.ts', ...walk('js/views'), ...walk('js/lib')]
    .filter((f) => f !== 'js/lib/format.ts')
    .flatMap((f) => findFixed(readFileSync(join(root, f), 'utf8')).map((h) => `${f}:${h.line}: ${h.text}`));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = check();
  for (const p of problems) console.error(p);
  if (problems.length) {
    console.error(
      `\n${problems.length} number(s) or date(s) written with a fixed locale: use js/lib/format.ts (U6.02).`,
    );
    process.exit(1);
  }
}
