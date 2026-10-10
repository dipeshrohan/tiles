// Keeps inline styles out of the browser app's HTML (U1.03): pages use the stylesheet's components
// and utilities. A style attribute is allowed only when its values are computed (`${…}`, like a
// chart's width or a node type's colour), and there are at most MAX of those. Run by `npm run lint`;
// exits 1 and names each one otherwise. (Styles set from code, `el.style.top = …`, aren't HTML.)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX = 20;
const root = join(import.meta.dirname, '..');
const SKIP = new Set(['js/tiles.bundle.js', 'js/lib/icon-data.ts']);

const walk = (dir) =>
  readdirSync(join(root, dir)).flatMap((f) => {
    const path = `${dir}/${f}`;
    if (statSync(join(root, path)).isDirectory()) return walk(path);
    return /\.[jt]s$/.test(f) && !SKIP.has(path) ? [path] : [];
  });

// The ${…} expressions in a template (braces and strings inside them counted) and what's left.
function split(value) {
  const parts = [];
  let text = '';
  for (let i = 0; i < value.length; i++) {
    if (!value.startsWith('${', i)) {
      text += value[i];
      continue;
    }
    let depth = 1;
    let quote = null;
    let j = i + 2;
    for (; j < value.length && depth; j++) {
      const c = value[j];
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    parts.push(value.slice(i + 2, j - 1));
    text += '\u0000';
    i = j - 1;
  }
  return { parts, text };
}

// Computed: every declaration's value has an expression in it and nothing fixed beside it but a unit
// or a function's name ("${w}px", "rotate(${a}deg)"): no digits, no var(), and no expression that
// yields a fixed declaration ("${x ? 'gap:8px' : ''}").
export function computed(value) {
  const { parts, text } = split(value);
  if (!parts.length) return false;
  if (parts.some((p) => /(['"`])[^'"`]*:[^'"`]*\1/.test(p))) return false;
  return text
    .split(';')
    .filter((d) => d.trim())
    .every((d) => {
      const at = d.indexOf(':');
      if (at < 0) return d.trim() === '\u0000';
      const v = d.slice(at + 1);
      return v.includes('\u0000') && !/\d|var\(/.test(v.replaceAll('\u0000', ''));
    });
}

// Every style attribute in the app's source: double or single quoted, over lines, quotes inside its
// ${…} expressions skipped.
export function inlineStyles(files = walk('js')) {
  const found = [];
  for (const file of files) {
    const src = readFileSync(join(root, file), 'utf8');
    for (const m of src.matchAll(/\sstyle=(["'])/g)) {
      const quote = m[1];
      const start = m.index + m[0].length;
      let end = start;
      while (end < src.length && src[end] !== quote) {
        if (src.startsWith('${', end)) {
          const { parts } = split(src.slice(end));
          end += (parts[0]?.length ?? 0) + 3;
        } else end++;
      }
      const value = src.slice(start, end);
      const line = src.slice(0, m.index + 1).split('\n').length;
      found.push({ where: `${relative(root, join(root, file))}:${line}`, value, ok: computed(value) });
    }
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
