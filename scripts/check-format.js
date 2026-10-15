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

// A locale written in, the browser's (none, or undefined), across line breaks too:
// toLocale(Date|Time)String('…' | undefined | ), new Intl.X('…' | undefined), localeCompare(x, '…').
const FIXED = [
  /\.toLocale(?:Date|Time)?String\(\s*(?:['"`]|undefined\b|\))/g,
  /\bIntl\.\w+\(\s*(?:['"`]|undefined\b)/g,
  /\.localeCompare\([^()]*?,\s*['"`]/g,
  // A percentage put together by hand: `${(x * 100).toFixed(1)}%` (percent() writes it the language's way).
  /toFixed\(\d*\)\}\s*%/g,
];

export function findFixed(src) {
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  const hits = FIXED.flatMap((re) => [...src.matchAll(re)].map((m) => m.index));
  return [...new Set(hits.map(lineOf))]
    .sort((a, b) => a - b)
    .map((line) => ({ line, text: src.split('\n')[line - 1].trim() }));
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
