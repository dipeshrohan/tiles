// Catalogue words put into HTML are escaped (U6.01): `t()` gives text, so where its result lands in
// a template that builds markup it goes through `esc()` (or the message is said with `tHtml()`,
// which escapes its own words). A translation can hold `<`, `&` or quotes, and a message's values
// are often a person's or the plant's data. Found with TypeScript's parser: a `t(…)` whose value
// reaches a `${…}` of a template with a tag in it, or a value of `tHtml()`, through `?:`, `||`, `??`
// or brackets only.
// `node scripts/i18n-escape.js --fix` wraps each in `esc()`; test/i18n-escape.test.js keeps it so.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = join(import.meta.dirname, '..');
const walk = (dir) =>
  readdirSync(join(root, dir)).flatMap((f) => {
    const path = `${dir}/${f}`;
    if (statSync(join(root, path)).isDirectory()) return walk(path);
    return /\.ts$/.test(f) ? [path] : [];
  });

const isHtml = (template) => {
  const texts = ts.isNoSubstitutionTemplateLiteral(template)
    ? [template.text]
    : [template.head.text, ...template.templateSpans.map((s) => s.literal.text)];
  return texts.some((s) => /<\/?[a-z]/i.test(s));
};

// The `t(…)` calls in a source whose words reach markup unescaped: [{ start, end, line }].
export function unescaped(source, file = 'x.ts') {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
      let at = node;
      let up = node.parent;
      // Through what passes the value on as it is.
      while (
        up &&
        (ts.isParenthesizedExpression(up) ||
          (ts.isConditionalExpression(up) && up.condition !== at) ||
          (ts.isBinaryExpression(up) &&
            [
              ts.SyntaxKind.BarBarToken,
              ts.SyntaxKind.QuestionQuestionToken,
              ts.SyntaxKind.AmpersandAmpersandToken,
            ].includes(up.operatorToken.kind) &&
            (up.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken || up.right === at)))
      ) {
        at = up;
        up = up.parent;
      }
      // A value for tHtml(), which puts its values in as they are.
      const tHtmlValue =
        up &&
        ts.isPropertyAssignment(up) &&
        up.initializer === at &&
        ts.isObjectLiteralExpression(up.parent) &&
        ts.isCallExpression(up.parent.parent) &&
        ts.isIdentifier(up.parent.parent.expression) &&
        up.parent.parent.expression.text === 'tHtml';
      if (tHtmlValue || (up && ts.isTemplateSpan(up) && up.expression === at && isHtml(up.parent))) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push({ start: node.getStart(sf), end: node.getEnd(), line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

export const FILES = () => ['js/app.ts', ...walk('js/views'), ...walk('js/lib')];

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const fix = process.argv.includes('--fix');
  let count = 0;
  for (const f of FILES()) {
    let src = readFileSync(join(root, f), 'utf8');
    const hits = unescaped(src, f);
    count += hits.length;
    if (!fix) for (const h of hits) console.error(`${f}:${h.line}: t() into HTML without esc()`);
    else if (hits.length) {
      for (const h of [...hits].reverse())
        src = `${src.slice(0, h.start)}esc(${src.slice(h.start, h.end)})${src.slice(h.end)}`;
      writeFileSync(join(root, f), src);
    }
  }
  console.error(`${count} t() into HTML without esc()${fix ? ': wrapped' : ''}`);
  if (count && !fix) process.exit(1);
}
