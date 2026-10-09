// Every relative link in the documentation leads somewhere: the file exists and, for a link to a
// heading (#…), the heading (or an explicit <a id> / <a name>) does, with the anchor GitHub makes.
// Links in code (fenced, inline) and in HTML comments don't count. Only the files git tracks are read.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const tracked = () =>
  execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);

// The text outside fenced code (``` and ~~~) and HTML comments; `prose` also drops inline code.
const unfenced = (text) => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
export const prose = (text) => unfenced(text).replace(/`[^`\n]*`/g, '');

// The anchors a page has: GitHub's for each heading (lower case, punctuation dropped, spaces to
// dashes; a repeat gets the first free -1, -2, …), and explicit <a id> / <a name>.
export function anchors(text) {
  const out = new Set();
  for (const line of unfenced(text).split('\n')) {
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const base = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    let slug = base;
    for (let n = 1; out.has(slug); n++) slug = `${base}-${n}`;
    out.add(slug);
  }
  for (const [, id] of text.matchAll(/<a\s[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) out.add(id);
  return out;
}

// Every link target in a page: inline links and images, reference definitions, HTML href and src.
export function targets(text) {
  const p = prose(text);
  return [
    ...[...p.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1] ?? m[2]),
    ...[...p.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/gm)].map((m) => m[1]),
    ...[...p.matchAll(/<(?:a|img)\s[^>]*\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
  ];
}

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

test('anchors are made as GitHub makes them', () => {
  const a = anchors(
    '# Tiles: 6-month roadmap\n## 1. Sign-in\n## A\n## A 1\n## A\n```\n# not a heading\n```\n~~~\n# nor this\n~~~\n### `code` & more\n<a id="retention"></a>',
  );
  assert.deepEqual([...a], ['tiles-6-month-roadmap', '1-sign-in', 'a', 'a-1', 'a-2', 'code--more', 'retention']);
});

test('links are found inline, in definitions and in HTML, but not in code or comments', () => {
  const t = targets(
    '[a](one.md) ![i](img.png "title") [b](<two words.md>)\n[ref]: three.md "T"\n<a href="four.md">x</a> <img src="five.png">\n' +
      '`[no](code.md)`\n```\n[no](fence.md)\n```\n~~~\n[no](tilde.md)\n~~~\n<!-- [no](comment.md) -->',
  );
  assert.deepEqual(t, ['one.md', 'img.png', 'two words.md', 'three.md', 'four.md', 'five.png']);
});

test('every relative link in the documentation resolves', () => {
  const broken = [];
  for (const file of tracked()) {
    const path = join(ROOT, file);
    for (const target of targets(readFileSync(path, 'utf8'))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue; // https:, mailto:
      const where = `${file} → ${target}`;
      const [rawPath, rawAnchor] = target.split('#');
      const linked = decode(rawPath ?? '');
      const anchor = rawAnchor === undefined ? undefined : decode(rawAnchor);
      if (linked === null || anchor === null) {
        broken.push(`${where} (a malformed escape)`);
        continue;
      }
      const to = linked ? resolve(dirname(path), linked) : path;
      if (!existsSync(to)) broken.push(`${where} (no such file)`);
      else if (anchor && to.endsWith('.md') && !anchors(readFileSync(to, 'utf8')).has(anchor))
        broken.push(`${where} (no such heading)`);
    }
  }
  assert.deepEqual(broken, []);
});
