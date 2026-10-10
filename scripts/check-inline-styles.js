// Keeps inline styles out of the browser app (U1.03): pages use the stylesheet's components and
// utilities. A style attribute is allowed only when its whole value is computed (`style="${…}"` or
// one made of `${…}` values, like a chart's width or a node type's colour), and there are at most
// MAX of those. Run by `npm run lint`; exits 1 and names each one otherwise.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX = 20;
const root = join(import.meta.dirname, '..');
const files = ['js/views', 'js/lib'].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.ts') && f !== 'icon-data.ts')
    .map((f) => join(root, dir, f)),
);

// A value is computed when, with its ${…} parts taken out, only property names and punctuation are left:
// "max-width:${w}px" is, "gap:8px" isn't.
export const computed = (value) => {
  if (!value.includes('${')) return false;
  const fixed = value.replace(/\$\{[^}]*\}/g, '');
  return !/:\s*[^;\s]/.test(fixed.replace(/:\s*(px|%|em|rem)?(;|$)/g, ':$2'));
};

export function inlineStyles() {
  const found = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(/\sstyle="([^"]*)"/g)) {
          found.push({ where: `${relative(root, file)}:${i + 1}`, value: m[1], ok: computed(m[1]) });
        }
      });
  }
  return found;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const found = inlineStyles();
  const fixed = found.filter((f) => !f.ok);
  for (const f of fixed) console.error(`${f.where}: inline style "${f.value}": use a class (css/styles.css utilities)`);
  if (found.length > MAX) console.error(`${found.length} inline styles; at most ${MAX}, all computed`);
  if (fixed.length || found.length > MAX) process.exit(1);
}
