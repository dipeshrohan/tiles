// Every relative link in the documentation leads somewhere: the file exists and, for a link to a
// heading (#…), the heading does (as GitHub makes its anchor). Links into code blocks don't count.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SKIP = new Set([
  'node_modules',
  '.git',
  '.venv',
  '.terraform',
  'test-results',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
]);

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

// The text outside fenced and inline code.
const prose = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

// GitHub's anchor for a heading: lower case, punctuation dropped, spaces to dashes; repeats get -1, -2…
export function anchors(text) {
  const seen = new Map();
  const out = new Set();
  for (const line of text.replace(/```[\s\S]*?```/g, '').split('\n')) {
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const base = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

test('anchors are made as GitHub makes them', () => {
  const a = anchors(
    '# Tiles: 6-month roadmap\n## 1. Sign-in\n## Images\n## Images\n```\n# not a heading\n```\n### `code` & more',
  );
  assert.deepEqual([...a], ['tiles-6-month-roadmap', '1-sign-in', 'images', 'images-1', 'code--more']);
});

test('every relative link in the documentation resolves', () => {
  const broken = [];
  for (const file of markdownFiles(ROOT)) {
    const text = readFileSync(file, 'utf8');
    for (const [, target] of prose(text).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:
      const [path, anchor] = target.split('#');
      const to = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
      const where = `${relative(ROOT, file)} → ${target}`;
      if (!existsSync(to)) {
        broken.push(`${where} (no such file)`);
        continue;
      }
      if (anchor && to.endsWith('.md') && !anchors(readFileSync(to, 'utf8')).has(decodeURIComponent(anchor)))
        broken.push(`${where} (no such heading)`);
    }
  }
  assert.deepEqual(broken, []);
});
