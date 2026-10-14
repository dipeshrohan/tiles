// Writes js/help-data.js: the user guide (docs/guides/user.md) cut at its headings and made HTML
// at build time, so each page's help (U4.04) works offline and from file://, with no Markdown parser
// in the browser. The build runs it (helpPlugin, in vite.config.js; `npm run dev` again when the guide
// changes) and fails when a page has no help: PAGE_HELP names the guide's section for each page in
// js/views/. test/help.test.js fails when the file is stale.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const GUIDE = 'docs/guides/user.md';

// Each page's help: the guide's heading (its anchor, as GitHub makes it) for the page's id.
export const PAGE_HELP = {
  home: 'home',
  chat: 'copilot',
  shopfloor: 'shopfloor',
  plant: 'plant',
  ontology: 'ontology-builder',
  reviews: 'change-reviews',
  warnings: 'warnings',
  performance: 'warning-performance',
  quality: 'factory-physics-and-process--quality-demo-pages',
  physics: 'factory-physics-and-process--quality-demo-pages',
  signals: 'signals-and-data-quality',
  explorer: 'data-explorer',
  correlate: 'correlation-finder',
  insights: 'insights',
  apps: 'app-studio',
  documents: 'documents',
  import: 'import-data',
  design: 'design-studio',
  onboarding: 'set-up-a-site',
  settings: 'settings',
  styleguide: 'about-and-the-style-guide',
  help: 'finding-your-way',
  glossary: 'glossary',
};

// GitHub's anchor for a heading: lower case, punctuation dropped, spaces to dashes; a repeat gets -1, -2…
export function slugger() {
  const seen = new Set();
  return (title) => {
    const base = title
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    let slug = base;
    for (let n = 1; seen.has(slug); n++) slug = `${base}-${n}`;
    seen.add(slug);
    return slug;
  };
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Documents the app has a page for: a link to one opens that page.
const APP_PAGES = { '../ui/glossary.md': '#/glossary' };

// Inline Markdown: code, links, bold and italics. A link to a heading of this guide opens it on the
// Help page, one to a document the app shows opens its page; a link to another document keeps its
// words only.
export function inline(text) {
  const code = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, words, href) => {
    if (href.startsWith('#')) return `<a href="#/help/${href.slice(1)}">${words}</a>`;
    if (href in APP_PAGES) return `<a href="${APP_PAGES[href]}">${words}</a>`;
    if (/^https:\/\//.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${words}</a>`;
    return words;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${escapeHtml(code[Number(n)])}</code>`);
}

const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

// Block Markdown as the guide writes it: paragraphs, lists (nested by indentation, items continued on
// indented lines), tables and quotes.
export function blocks(lines) {
  const out = [];
  let i = 0;
  const list = (indent) => {
    const ordered = /^\d/.test(LIST.exec(lines[i])[2]);
    const items = [];
    while (i < lines.length) {
      const m = LIST.exec(lines[i]);
      if (!m || m[1].length < indent) break;
      if (m[1].length > indent) {
        const last = items.at(-1);
        if (last) last.push(list(m[1].length));
        continue;
      }
      if (/^\d/.test(m[2]) !== ordered) break;
      const item = [inline(m[3])];
      i++;
      while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && /^\s/.test(lines[i])) {
        item[0] += ` ${inline(lines[i].trim())}`;
        i++;
      }
      items.push(item);
      // A blank line between items of the same list keeps it going.
      if (i < lines.length && !lines[i].trim()) {
        const next = lines.slice(i).findIndex((l) => l.trim());
        const m2 = next < 0 ? null : LIST.exec(lines[i + next]);
        if (m2 && m2[1].length >= indent) i += next;
      }
    }
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag}>${items.map((parts) => `<li>${parts.join('')}</li>`).join('')}</${tag}>`;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      i++; // a blank line, or a rule between sections (the help draws its own)
    } else if (LIST.test(line)) {
      out.push(list(LIST.exec(line)[1].length));
    } else if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (row) =>
        row
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => inline(c.trim()));
      const [head = '', , ...body] = rows;
      out.push(
        `<div class="table-wrap"><table class="small"><thead><tr>${cells(head)
          .map((c) => `<th scope="col">${c}</th>`)
          .join('')}</tr></thead><tbody>${body
          .map(
            (r) =>
              `<tr>${cells(r)
                .map((c, n) => (n === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`))
                .join('')}</tr>`,
          )
          .join('')}</tbody></table></div>`,
      );
    } else if (line.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${blocks(quote)}</blockquote>`);
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^[|>]/.test(lines[i]))
        para.push(lines[i++].trim());
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return out.join('');
}

// The guide's sections, in order: each heading (## and ###) with its own text up to the next heading.
// The title's introduction is the first, at level 1; the table of contents is left out (the Help page
// has its own).
export function sections(markdown) {
  const slug = slugger();
  const out = [];
  let current = null;
  let body = [];
  const close = () => {
    if (current) out.push({ ...current, html: blocks(body), text: plain(body.join(' ')) });
    body = [];
  };
  for (const line of markdown.split('\n')) {
    const m = /^(#{1,3})\s+(.*?)\s*$/.exec(line);
    if (m) {
      close();
      const level = m[1].length;
      current = { slug: slug(m[2]), title: m[2], level };
    } else body.push(line);
  }
  close();
  return out.filter((s) => s.slug !== 'contents');
}

// Words to search a section by: its text without Markdown, cut short.
const plain = (text) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*|>#_]/g, ' ')
    .replace(/^\s*[-\d.]+\s/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);

// Each page in js/views/ (the id of the View it declares), so a new page without help fails the build;
// a View whose id can't be read fails it too.
export function pageIds() {
  const dir = join(ROOT, 'js/views');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      if (!/:\s*View\s*=\s*\{/.test(text)) return [];
      const m = /:\s*View\s*=\s*\{[\s\S]*?\bid:\s*['"`]([\w-]+)['"`]/.exec(text);
      if (!m?.[1]) throw new Error(`js/views/${f} declares a View whose id scripts/help.js can't read`);
      return [m[1]];
    });
}

export function generate() {
  const all = sections(readFileSync(join(ROOT, GUIDE), 'utf8'));
  const known = new Set(all.map((s) => s.slug));
  const missing = pageIds().filter((id) => !(id in PAGE_HELP));
  if (missing.length)
    throw new Error(`No help for ${missing.join(', ')}: add the page to PAGE_HELP in scripts/help.js`);
  const broken = Object.entries(PAGE_HELP).filter(([, slug]) => !known.has(slug));
  if (broken.length)
    throw new Error(`${GUIDE} has no heading for ${broken.map(([id, slug]) => `${id} (#${slug})`).join(', ')}`);
  // A classic script (js/lib/help.ts loads it), so it loads from file:// too.
  return `// Generated by scripts/help.js from ${GUIDE}: don't edit, change the guide and run \`npm run build\`.
window.tilesHelp = ${JSON.stringify({ sections: all, pages: PAGE_HELP })};
`;
}

// For vite.config.js: writes the help next to the bundle as a build starts, and again when the guide
// changes under `npm run dev`; a page without help fails the build.
export function helpPlugin(outDir) {
  return {
    name: 'tiles-help',
    apply: 'build',
    buildStart() {
      this.addWatchFile(join(ROOT, GUIDE));
      writeFileSync(join(resolve(ROOT, outDir), 'help-data.js'), generate());
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(ROOT, 'js/help-data.js'), generate());
  console.log('js/help-data.js: written');
}
