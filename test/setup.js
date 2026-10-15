// Each test file starts with the English catalogue loaded, as index.html loads js/messages-en.js
// before the app (U6.01).
import { readFileSync } from 'node:fs';

globalThis.TILES_MESSAGES = {
  en: JSON.parse(readFileSync(new URL('../js/i18n/en.json', import.meta.url), 'utf8')),
};
