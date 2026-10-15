// The message catalogue (U6.01): every word a page shows comes from `js/i18n/<locale>.json` by a
// key, so Tiles can speak another language without its pages changing. Messages are ICU-style,
// with no dependency:
//   "Hello {name}"                                            a value put in
//   "{count, plural, one {# warning} other {# warnings}}"     by Intl.PluralRules (=0, =1… first)
//   "{role, select, viewer {Read only} other {Can edit}}"     by a value's text
// A key missing from a locale falls back to English. Keys are typed from en.json: a key that
// isn't there doesn't compile. `scripts/check-i18n.js` (in `npm run lint`) keeps the locales in
// step and finds text written straight into a view.

import en from '../i18n/en.json';
import { esc } from './dom.ts';

export type MessageKey = keyof typeof en;
export type Params = Readonly<Record<string, string | number>>;
type Catalogue = Readonly<Partial<Record<string, string>>>;

const catalogues = new Map<string, Catalogue>([['en', en]]);
let locale = 'en';

// Adds a locale's messages (German in U6.03; a test's own).
export function addCatalogue(code: string, messages: Catalogue): void {
  catalogues.set(code, messages);
}

export function setLocale(code: string): void {
  locale = catalogues.has(code) ? code : 'en';
}
export const currentLocale = (): string => locale;

const messageOf = (key: MessageKey): string => catalogues.get(locale)?.[key] ?? (en as Catalogue)[key] ?? key;

// A message as text (escape it with esc() where it goes into HTML).
export function t(key: MessageKey, params: Params = {}): string {
  return formatMessage(messageOf(key), params, locale);
}

// A message as HTML: its own words escaped, its values put in as they are: built markup (a glossary
// term, a <b>), or text the caller escaped.
export function tHtml(key: MessageKey, params: Params = {}): string {
  return formatMessage(messageOf(key), params, locale, true);
}

const plurals = new Map<string, Intl.PluralRules>();
const pluralRule = (code: string): Intl.PluralRules => {
  let rule = plurals.get(code);
  if (!rule) plurals.set(code, (rule = new Intl.PluralRules(code)));
  return rule;
};
// `#` in a plural is its number, written as the language writes numbers (1,430 in English).
const numbers = new Map<string, Intl.NumberFormat>();
const countText = (code: string, value: unknown): string => {
  if (typeof value !== 'number') return String(value ?? '');
  let format = numbers.get(code);
  if (!format) numbers.set(code, (format = new Intl.NumberFormat(code)));
  return format.format(value);
};

// The index of the brace closing the one at `open`.
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

// A plural's or select's cases: `one {…} other {…}` as [selector, text] pairs.
function cases(text: string): [string, string][] {
  const out: [string, string][] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const end = closing(text, open);
    if (end < 0) break;
    out.push([text.slice(i, open).trim(), text.slice(open + 1, end)]);
    i = end + 1;
  }
  return out;
}

export function formatMessage(message: string, params: Params, code = locale, html = false): string {
  const words = (text: string): string => (html ? esc(text) : text);
  let out = '';
  let i = 0;
  while (i < message.length) {
    const open = message.indexOf('{', i);
    if (open < 0) {
      out += words(message.slice(i));
      break;
    }
    out += words(message.slice(i, open));
    const end = closing(message, open);
    if (end < 0) {
      out += words(message.slice(open));
      break;
    }
    const inner = message.slice(open + 1, end);
    const [name = '', kind, ...rest] = inner.split(',');
    const value = params[name.trim()];
    if (kind === undefined) out += value === undefined ? `{${inner}}` : String(value);
    else {
      const body = rest.join(',');
      const options = cases(body);
      const pick = (sel: string) => options.find(([k]) => k === sel)?.[1];
      let chosen: string | undefined;
      if (kind.trim() === 'plural') {
        const n = Number(value);
        chosen = pick(`=${n}`) ?? pick(pluralRule(code).select(n)) ?? pick('other');
        chosen = chosen?.replace(/#/g, countText(code, value));
      } else chosen = pick(String(value)) ?? pick('other');
      out += formatMessage(chosen ?? '', params, code, html);
    }
    i = end + 1;
  }
  return out;
}
