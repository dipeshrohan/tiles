// The glossary's definitions (U4.05): js/glossary-data.js, made by scripts/glossary.js, is a classic
// script loaded the first time a definition is wanted (a term pointed at, focused or tapped, or the
// Glossary page), as help is (js/lib/help.ts): it works from file://, and the bundle keeps only each
// term's name (js/lib/glossary-data.ts).
import { GLOSSARY, type GlossaryKey } from './glossary-data.ts';
import { loadKept } from './help.ts';

// globalThis: the unit tests have the definitions without a window (test/setup.js).
const kept = (): Window['tilesGlossary'] => (globalThis as { tilesGlossary?: Window['tilesGlossary'] }).tilesGlossary;

export const glossaryLoaded = (): boolean => kept() !== undefined;

export const loadGlossary = (src = 'js/glossary-data.js') => loadKept('tilesGlossary', src, 'glossary.fileFailed');

// Asked for when the browser is idle, once a page shows a term or the palette opens, so a term
// Tabbed to has its definition at once (a description added after the focus isn't read out). Once
// at a time; after a failure, asked again only on a new page, after RETRY_MS or back online, not on
// every redraw.
const RETRY_MS = 30_000;
let preloading = false;
let failedAt = -Infinity;
if (typeof window !== 'undefined') window.addEventListener('online', () => (failedAt = -Infinity));
export function preloadGlossary(newPage = false): void {
  if (glossaryLoaded() || preloading) return;
  if (!newPage && Date.now() - failedAt < RETRY_MS) return;
  preloading = true;
  const go = (): void =>
    void loadGlossary()
      .then(
        () => {},
        () => (failedAt = Date.now()), // a term or the Glossary page says so when it is wanted
      )
      .finally(() => (preloading = false));
  if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 2000 });
  else setTimeout(go, 200);
}

// A term's definition and its group; null and '' until they are loaded.
export const definition = (key: GlossaryKey): string | null => kept()?.[key]?.text ?? null;
export const groupOf = (key: GlossaryKey): string => kept()?.[key]?.group ?? '';

// What a term's tooltip says: its definition, after the term's name when other words show it ("d"
// for Cohen's d); null until the definitions are loaded.
export function termTip(key: GlossaryKey, shown: string): string | null {
  const text = definition(key);
  if (text === null) return null;
  const name = GLOSSARY[key].term;
  return shown.trim().toLowerCase() === name.toLowerCase() ? text : `${name}: ${text}`;
}
