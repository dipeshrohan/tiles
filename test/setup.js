// Each test file starts with the English catalogue loaded, as index.html loads js/messages-en.js
// before the app (U6.01).
import { readFileSync } from 'node:fs';

globalThis.TILES_MESSAGES = {
  en: JSON.parse(readFileSync(new URL('../js/i18n/en.json', import.meta.url), 'utf8')),
};

// And the glossary's definitions, as a page has them once js/glossary-data.js is loaded (U4.05).
new Function('window', readFileSync(new URL('../js/glossary-data.js', import.meta.url), 'utf8'))(globalThis);
