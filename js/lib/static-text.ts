// The page's own words (U6.01): index.html's fixed text (the skip link, the search button, the top
// bar's labels) is shown before the app runs, in English. Each element names its message with
// `data-i18n` (its text), `data-i18n-label` (its aria-label), `data-i18n-title` (its title) or
// `data-i18n-tooltip` (its tooltip), and this puts the messages in at start-up, before the first
// render. A key the catalogue doesn't have leaves the element as it is.
import { tKnown } from './i18n.ts';

// What each attribute sets on its element.
const PARTS = [
  ['data-i18n', null],
  ['data-i18n-label', 'aria-label'],
  ['data-i18n-title', 'title'],
  ['data-i18n-tooltip', 'data-tooltip'],
] as const;

export function translateStatic(root: ParentNode): void {
  for (const [attr, target] of PARTS)
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      const key = el.getAttribute(attr);
      const text = key ? tKnown(key) : null;
      if (text === null) continue;
      if (target) el.setAttribute(target, text);
      else el.textContent = text;
    }
}
