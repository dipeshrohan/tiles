// The language Tiles is shown in (U6.03): English, German, and a pseudo-locale for testing layouts.
// Chosen with ?lang=<code> (kept), in Settings, or by the browser's languages; English otherwise.
// A language's messages are a classic script, js/messages-<code>.js (scripts/messages.js), added to
// the page when it is chosen, so they work from file:// and stay out of the bundle. The
// pseudo-locale is made here from English: accented and 40% longer, in brackets, so text that was
// never put in the catalogue, cut off or overflowing shows at once (the visual tests run in it).

import { addCatalogue, currentLocale, setLocale } from './i18n.ts';
import { load, save } from './store.ts';

// Each named in its own language.
export const LANGUAGES: readonly { code: string; name: string }[] = [
  { code: 'en', name: 'English' }, // i18n-ok
  { code: 'de', name: 'Deutsch' }, // i18n-ok
];
export const PSEUDO = 'en-XA';
const KEY = 'language';
const known = (code: string | null | undefined): code is string =>
  Boolean(code) && (code === PSEUDO || LANGUAGES.some((l) => l.code === code));

// ?lang= (and kept for next time), the one chosen before, else the browser's first we have.
export function chosenLanguage(
  search: string = typeof location === 'undefined' ? '' : location.search,
  browser: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages,
): string {
  const asked = new URLSearchParams(search).get('lang');
  if (known(asked)) {
    save(KEY, asked);
    return asked;
  }
  const kept = load<string | null>(KEY, null);
  if (known(kept)) return kept;
  for (const tag of browser) {
    const base = tag.split('-')[0]?.toLowerCase();
    if (known(base)) return base;
  }
  return 'en';
}

export const keepLanguage = (code: string): void => save(KEY, code);

type Messages = Record<string, Record<string, string> | undefined>;
const messages = (): Messages => (globalThis as { TILES_MESSAGES?: Messages }).TILES_MESSAGES ?? {};

// Where the bundle came from, so a catalogue loads beside it (also from file://).
function scriptBase(): string {
  const bundle = document.querySelector<HTMLScriptElement>('script[src*="tiles.bundle.js"]');
  return bundle ? bundle.src.replace(/tiles\.bundle\.js.*$/, '') : 'js/';
}

const loading = new Map<string, Promise<void>>();
function loadScript(code: string): Promise<void> {
  let p = loading.get(code);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${scriptBase()}messages-${code}.js`;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`messages-${code}.js`));
      document.head.append(s);
    });
    loading.set(code, p);
    p.catch(() => loading.delete(code)); // tried again next time
  }
  return p;
}

// Shows the page in a language: its messages loaded (once) and set; English if they can't be.
export async function useLanguage(code: string): Promise<string> {
  if (code === PSEUDO) {
    if (!messages()[PSEUDO]) addCatalogue(PSEUDO, pseudoCatalogue(messages().en ?? {}));
  } else if (code !== 'en' && !messages()[code]) {
    try {
      await loadScript(code);
    } catch {
      code = 'en';
    }
  }
  setLocale(code);
  if (typeof document !== 'undefined') document.documentElement.lang = code === PSEUDO ? 'en' : currentLocale();
  return currentLocale();
}

// ---- the pseudo-locale --------------------------------------------------------------------------

const ACCENTED: Readonly<Record<string, string>> = Object.fromEntries(
  [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c, i) => [
    c,
    [...'àƀçđéƒĝĥîĵķĺɱñöþǫŕšţûṽŵẋýžÀßÇÐÉƑĜĤÎĴĶĹṀÑÖÞǪŔŠŢÛṼŴẊÝŽ'][i] ?? c, // i18n-ok
  ]),
);

const closing = (text: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
};

// A message's words accented, its ICU structure ({values}, plural and select keys, #) as it was.
function accent(message: string): string {
  let out = '';
  let i = 0;
  while (i < message.length) {
    const open = message.indexOf('{', i);
    const words = message.slice(i, open < 0 ? undefined : open);
    out += [...words].map((c) => ACCENTED[c] ?? c).join('');
    if (open < 0) break;
    const end = closing(message, open);
    if (end < 0) return out + message.slice(open);
    const inner = message.slice(open + 1, end);
    const [name, kind, ...rest] = inner.split(',');
    if (kind === undefined) out += `{${inner}}`;
    else {
      // The options: `key {body}` pairs, each body accented in turn.
      const body = rest.join(',');
      let opts = '';
      let k = 0;
      while (k < body.length) {
        const o = body.indexOf('{', k);
        if (o < 0) break;
        const e = closing(body, o);
        if (e < 0) break;
        opts += `${body.slice(k, o)}{${accent(body.slice(o + 1, e))}}`;
        k = e + 1;
      }
      out += `{${name},${kind},${opts}}`;
    }
    i = end + 1;
  }
  return out;
}

// Accented, 40% longer and in brackets: "[Śàṽé ·····]".
export function pseudo(message: string): string {
  const text = accent(message);
  const length = message.replace(/\{[^{}]*\}/g, '').length;
  return `[${text}${length ? ` ${'·'.repeat(Math.max(1, Math.round(length * 0.4)))}` : ''}]`;
}

export const pseudoCatalogue = (english: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(english).map(([k, v]) => [k, pseudo(v)]));
