// The message catalogues (U6.01) as classic scripts beside the bundle: js/messages-<code>.js from
// js/i18n/<code>.json, each adding its messages to window.TILES_MESSAGES. index.html loads English
// before the bundle (so the first page has its words, from file:// too); another language is added
// when chosen (js/lib/i18n.ts's loadLanguage). Kept out of the bundle, whose size is budgeted, and
// read by the browser as data. Written by the build (messagesPlugin in vite.config.js) and by
// `node scripts/messages.js`; test/messages.test.js checks they are current.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const DIR = 'js/i18n';

export const locales = () =>
  readdirSync(join(ROOT, DIR))
    .filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();

export function generate(code) {
  const messages = JSON.parse(readFileSync(join(ROOT, DIR, `${code}.json`), 'utf8'));
  // JSON is a JavaScript expression; </script> can't end a classic script file, but escape `<` anyway.
  const data = JSON.stringify(messages).replace(/</g, '\\u003c');
  return `// Generated from ${DIR}/${code}.json by scripts/messages.js. Do not edit; run \`npm run build\`.
(window.TILES_MESSAGES = window.TILES_MESSAGES || {})[${JSON.stringify(code)}] = ${data};
`;
}

export const fileOf = (code) => `messages-${code}.js`;

export function writeAll(outDir = 'js') {
  for (const code of locales()) writeFileSync(join(resolve(ROOT, outDir), fileOf(code)), generate(code));
}

export function messagesPlugin(outDir) {
  return {
    name: 'tiles-messages',
    apply: 'build',
    buildStart() {
      for (const code of locales()) this.addWatchFile(join(ROOT, DIR, `${code}.json`));
      writeAll(outDir);
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeAll();
  console.log(
    `${locales()
      .map((c) => `js/${fileOf(c)}`)
      .join(', ')}: written`,
  );
}
