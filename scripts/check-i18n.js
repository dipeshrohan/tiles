// The message catalogue's check (U6.01), run by `npm run lint`:
// - every locale in js/i18n/ has exactly English's keys, and every key English has is used;
// - a view moved to the catalogue writes no words of its own: a text node between tags, or a
//   quoted phrase (a capital, then words), is reported with its file and line. Views not moved yet
//   are listed in scripts/i18n-pending.json; the list only shrinks.
// `// i18n-ok` at the end of a line lets that line through (a tag name, a unit, a format).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

const walk = (dir) =>
  readdirSync(join(root, dir)).flatMap((f) => {
    const path = `${dir}/${f}`;
    if (statSync(join(root, path)).isDirectory()) return walk(path);
    return /\.ts$/.test(f) ? [path] : [];
  });

// The literal text of a source file: each quoted string and each static part of a template, with
// its line, and whether an expression comes right before or after it (`${…}`). Comments skipped.
export function pieces(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const stack = []; // open templates, by the depth of braces in their expression
  let depth = 0;
  const take = (quote) => {
    // From after the opening quote to the closing one (or, in a template, to the next `${`).
    let text = '';
    const start = line;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        text += src[i + 1] ?? '';
        i++;
        continue;
      }
      if (c === '\n') line++;
      if (c === quote) {
        i++;
        return { text, line: start, end: 'quote' };
      }
      if (quote === '`' && c === '$' && src[i + 1] === '{') {
        i += 2;
        return { text, line: start, end: 'expr' };
      }
      text += c;
    }
    return { text, line: start, end: 'eof' };
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const stop = close < 0 ? src.length : close + 2;
      line += (src.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      const p = take(c);
      out.push({ text: p.text, line: p.line, quoted: true, before: false, after: false });
      continue;
    }
    if (c === '`') {
      i++;
      const p = take('`');
      out.push({ text: p.text, line: p.line, quoted: false, before: false, after: p.end === 'expr' });
      if (p.end === 'expr') {
        stack.push(depth);
        depth = 0;
      }
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (depth === 0 && stack.length) {
        // Back in the template after its expression.
        i++;
        const p = take('`');
        out.push({ text: p.text, line: p.line, quoted: false, before: true, after: p.end === 'expr' });
        if (p.end !== 'expr') depth = stack.pop() ?? 0;
        else depth = 0;
        continue;
      }
      depth--;
    }
    i++;
  }
  return out;
}

// Words a person would read: two letters or more, not only digits, signs and arrows.
const WORDS = /[A-Za-z]{2,}/;
const ATTRS = /\b(?:aria-label|title|placeholder|alt|data-tooltip)="([^"]*)"/g;
const LABEL_ARG =
  /(?:button|linkButton|toast|title|label|body|lead|eyebrow|placeholder|message|confirm|heading|says|description)\s*[:(,]\s*$/;

// Files whose words are content, translated as content rather than as messages: the glossary
// (made from docs/ui/glossary.md), the demo plant's data, the style guide's code samples, icons.
export const CONTENT = new Set([
  'js/lib/glossary-data.ts',
  'js/lib/data.ts',
  'js/lib/styleguide.ts',
  'js/lib/icon-data.ts',
  'js/lib/i18n.ts',
]);

export function findText(src) {
  const lines = src.split('\n');
  // The line up to a piece's opening quote.
  const rowBefore = (p, text) => {
    const row = lines[p.line - 1] ?? '';
    const at = row.indexOf(text);
    return at > 0 ? row.slice(0, at - 1) : '';
  };
  const ok = (line) => /\/\/ i18n-ok\b/.test(lines[line - 1] ?? '');
  const found = [];
  const add = (line, text) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t && WORDS.test(t) && !ok(line)) found.push({ line, text: t });
  };
  const all = pieces(src);
  all.forEach((p) => {
    const text = p.text;
    if (/[<>]/.test(text)) {
      // Markup: the text between tags, and at the ends next to an expression.
      const runs = text.split(/<[^<>]*>/);
      runs.forEach((whole, j) => {
        const first = j === 0;
        const last = j === runs.length - 1;
        let run = whole;
        // A tag begun before an expression ends in this part (`… ${x} /> Words`), or one begins in it
        // and ends after the next (`Words <a href="${x}">`): the words are past or before it.
        if (first && p.before && run.includes('>')) run = run.slice(run.lastIndexOf('>') + 1);
        if (last && p.after && run.includes('<')) run = run.slice(0, run.indexOf('<'));
        if (first && !p.before && !text.trimStart().startsWith('<')) return; // not after a tag
        if (last && !p.after && !text.trimEnd().endsWith('>')) return;
        // A run cut by an unclosed tag (an attribute list) is not text.
        if (/[<>"=]/.test(run)) return;
        add(p.line, run);
      });
      for (const m of text.matchAll(ATTRS)) if (!/^\s*$/.test(m[1])) add(p.line, m[1]);
      return;
    }
    // A sentence or label: a capital, a word, then more words (or one word where words go: a label, a
    // table's headers).
    if (/^[A-Z][A-Za-z’']*[a-z][A-Za-z’']*(?:[ ,.:?!…][^]*)?$/.test(text) || /^[A-Z]{2,}\s+[a-z]/.test(text)) {
      const row = lines[p.line - 1] ?? '';
      const at = row.indexOf(text);
      const before = at > 0 ? row.slice(0, at - 1) : ''; // up to the opening quote
      if (text.includes(' ') || text.endsWith('…') || LABEL_ARG.test(before) || /\bheaders\s*:\s*\[/.test(row))
        add(p.line, text);
    } else if (
      p.quoted &&
      /\b(?:placeholder|lead|body|title|label|message|description)\s*:\s*$/.test(rowBefore(p, text)) &&
      /[a-z]{2,}/.test(text)
    )
      add(p.line, text); // what goes in a label, whatever its first letter: `placeholder: 'e.g. …'`
    else if (!p.quoted && (p.before || p.after) && /(^|\s)[a-z]{2,}\s+[a-z]{2,}/.test(text) && !/[{};=]/.test(text))
      add(p.line, text); // words around an expression: `${n} warnings waiting`
  });
  return found;
}

// The keys index.html names for its fixed words (`data-i18n`, `data-i18n-label`…), put in by
// js/lib/static-text.ts at start-up.
export function htmlKeys(html) {
  return new Set([...html.matchAll(/\sdata-i18n(?:-[a-z]+)?="([^"]+)"/g)].map((m) => m[1]));
}

export function check() {
  const problems = [];
  const en = JSON.parse(read('js/i18n/en.json'));
  const keys = Object.keys(en);
  for (const f of readdirSync(join(root, 'js/i18n')).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
    const other = Object.keys(JSON.parse(read(`js/i18n/${f}`)));
    for (const k of keys.filter((k) => !other.includes(k))) problems.push(`js/i18n/${f}: missing ${k}`);
    for (const k of other.filter((k) => !keys.includes(k))) problems.push(`js/i18n/${f}: not in English: ${k}`);
  }
  // Every key is used somewhere (a key named whole, or a family named by its prefix: `t(`warnings.status.${s}`)`).
  const code = walk('js')
    .filter((f) => f !== 'js/tiles.bundle.js')
    .map(read)
    .join('\n');
  const fromHtml = htmlKeys(read('index.html'));
  for (const k of keys) {
    if (fromHtml.has(k)) continue;
    // `api.*` are the API's error codes (errors.py), checked by api/tests/test_errors.py.
    if (k.startsWith('api.')) continue;
    const family = k.slice(0, k.lastIndexOf('.') + 1);
    if (!code.includes(`'${k}'`) && !code.includes(`"${k}"`) && !code.includes(`\`${family}\${`))
      problems.push(`js/i18n/en.json: ${k} is not used`);
  }
  const pending = new Set(JSON.parse(read('scripts/i18n-pending.json')));
  for (const f of ['js/app.ts', ...walk('js/views'), ...walk('js/lib')].filter(
    (f) => !pending.has(f) && !CONTENT.has(f),
  ))
    for (const { line, text } of findText(read(f))) problems.push(`${f}:${line}: "${text}" is not from the catalogue`);
  for (const f of pending)
    if (!statSync(join(root, f), { throwIfNoEntry: false })) problems.push(`${f}: listed as pending, but gone`);
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = check();
  for (const p of problems) console.error(p);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s): words on pages come from js/i18n/en.json (U6.01).`);
    process.exit(1);
  }
}
