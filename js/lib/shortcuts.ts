// Keyboard shortcuts (U4.03): g then a letter goes to a page, ? lists every shortcut, and a page's
// own keys (a to acknowledge, e to edit, / to search it) are the `aria-keyshortcuts` of its buttons
// and fields, so the key, its tooltip and what screen readers announce are one thing. None of them
// while typing in a field, with Ctrl, ⌘ or Alt held, or while a dialog is open; all of them can be
// turned off (WCAG 2.1.4: single-key shortcuts get in the way of speech input and some screen readers).

import { esc } from './dom.ts';
import { infoDialog } from './overlay.ts';
import { load, save } from './store.ts';

// The pages g reaches, by the letter after it.
export const GO_KEYS: readonly (readonly [string, string])[] = [
  ['h', 'home'],
  ['c', 'chat'],
  ['f', 'shopfloor'],
  ['p', 'plant'],
  ['o', 'ontology'],
  ['r', 'reviews'],
  ['w', 'warnings'],
  ['s', 'signals'],
  ['e', 'explorer'],
  ['x', 'correlate'],
  ['i', 'insights'],
  ['a', 'apps'],
  ['d', 'documents'],
  ['m', 'import'],
  ['t', 'settings'],
];
const GO = new Map(GO_KEYS);

// The keys a page gives its buttons and fields, and what they do there.
export const PAGE_KEYS: readonly (readonly [string, string])[] = [
  ['/', 'Search the page (the command palette where the page has no search)'],
  ['a', 'Acknowledge the warning open'],
  ['s', 'Assign the warning open to me'],
  ['r', 'Resolve the warning open: choose its outcome'],
  ['n', 'Open the next warning, after acting on one'],
  ['e', 'Edit the insight or app open'],
  ['Ctrl Z', 'Undo the last change staged to the ontology (⌘ Z on a Mac)'],
  ['Ctrl Shift Z', 'Redo it (or Ctrl Y)'],
  ['← → ↑ ↓', 'Move between nodes on the ontology canvas'],
];

// On or off for this browser; kept in memory too, for when storage is blocked.
const KEY = 'shortcuts';
let on: boolean | undefined;
export const shortcutsOn = (): boolean => (on ??= load<boolean>(KEY, true) !== false);
export function setShortcutsOn(value: boolean): void {
  on = value;
  save(KEY, value);
}

// What a button or field takes for its page's key: the attribute, or nothing while shortcuts are off
// (so nothing announces a key that does nothing). For a component's `attrs`, or for raw markup.
export const keyAttrs = (key: string): Record<string, string> => (shortcutsOn() ? { 'aria-keyshortcuts': key } : {});
export const keyAttr = (key: string): string => (shortcutsOn() ? ` aria-keyshortcuts="${esc(key)}"` : '');

// Whether a key press may be a shortcut: not typed into a field, no modifier but Shift, no dialog
// open, not taken already, and shortcuts on.
export function forShortcut(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
  return !typing(e.target) && !document.querySelector('dialog[open]') && shortcutsOn();
}

// Where keys are text: a field typed in, a select (letters pick options), an editable element. A
// checkbox, radio or button with the focus is not.
const NOT_TYPED = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);
export function typing(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t instanceof HTMLInputElement) return !NOT_TYPED.has(t.type);
  return Boolean(t.closest('textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

const visible = (el: Element): boolean =>
  typeof el.checkVisibility === 'function' ? el.checkVisibility() : (el as HTMLElement).offsetParent !== null;

// The element of `root` that takes `key`: the first shown and enabled one whose aria-keyshortcuts
// lists it.
export function keyTarget(root: ParentNode, key: string): HTMLElement | null {
  const all = root.querySelectorAll<HTMLElement>(`[aria-keyshortcuts~="${CSS.escape(key)}"]`);
  return (
    [...all].find(
      (el) => visible(el) && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true',
    ) ?? null
  );
}

// The words for a key in the list and in tooltips.
export const keyLabel = (key: string): string => (key === ' ' ? 'Space' : key);
const kbd = (keys: string): string =>
  keys
    .split(' ')
    .map((k) => `<kbd>${esc(keyLabel(k))}</kbd>`)
    .join(' ');

export interface ShortcutOptions {
  root: HTMLElement; // where pages draw (#view)
  go(page: string): void;
  title(page: string): string | null; // the page's name; null for one not in the menu
  palette(): void; // / where the page has no search
  changed(): void; // shortcuts turned on or off: the page drawn again, for its aria-keyshortcuts
}

// The list `?` (or the command palette) shows, and the switch that turns single-key shortcuts off.
export function shortcutsHtml(o: Pick<ShortcutOptions, 'title'>, mac: boolean): string {
  const row = (keys: string, does: string): string =>
    `<tr><th scope="row" class="nowrap">${kbd(keys)}</th><td>${esc(does)}</td></tr>`;
  const table = (caption: string, rows: string): string =>
    `<div class="table-wrap"><table class="small shortcuts"><caption>${esc(caption)}</caption><tbody>${rows}</tbody></table></div>`;
  const pages = GO_KEYS.flatMap(([k, page]) => {
    const t = o.title(page);
    return t ? [row(`g ${k}`, t)] : [];
  }).join('');
  return `<div class="shortcut-list">
    ${table('Anywhere', row(mac ? '⌘ K' : 'Ctrl K', 'Open the command palette') + row('?', 'Show this list'))}
    ${table('Go to a page: g, then', pages)}
    ${table(
      'In a list of records',
      row('j', 'Open the next') + row('k', 'Open the previous') + row('Enter', 'Open the one with the focus'),
    )}
    ${table('On a page', PAGE_KEYS.map(([k, does]) => row(k, does)).join(''))}
    </div>
    <label class="row gap-2"><input type="checkbox" name="single-keys" data-single-keys ${shortcutsOn() ? 'checked' : ''} /> Use single-key shortcuts</label>
    <p class="small soft">Turn them off if they get in the way of a screen reader or speech input. ${mac ? '⌘ K' : 'Ctrl K'} works either way, and finds this list as “Keyboard shortcuts”.</p>`;
}

// How long g waits for its letter.
const CHORD_MS = 1500;

export function installShortcuts(o: ShortcutOptions): { show(): void } {
  let chord: ReturnType<typeof setTimeout> | undefined;
  let showing = false;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);

  const show = (): void => {
    if (showing) return;
    // Chosen in the command palette: once the palette has gone (it fades out), so the focus it gives
    // back doesn't leave this list.
    if (document.querySelector('dialog.palette')) return void requestAnimationFrame(show);
    showing = true;
    void infoDialog(
      {
        title: 'Keyboard shortcuts',
        body: 'Not while typing in a field.',
        contentHtml: shortcutsHtml(o, mac),
        wide: true,
      },
      (dialog) => {
        dialog.querySelector<HTMLInputElement>('[data-single-keys]')?.addEventListener('change', (e) => {
          setShortcutsOn((e.target as HTMLInputElement).checked);
          o.changed();
        });
      },
    ).then(() => (showing = false));
  };

  // Turned on or off in another tab: this one follows.
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== `tiles:${KEY}`) return; // null: storage cleared
    on = undefined;
    o.changed();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' || e.repeat) return; // on the way to ? or a capital, or held: g still waits
    const pending = chord !== undefined;
    clearTimeout(chord);
    chord = undefined;
    if (!forShortcut(e)) return;
    if (pending && e.key !== '?') {
      // The letter after g is g's, whether or not it names a page (not j's or a's on this page).
      if (e.key.length !== 1) return;
      e.preventDefault();
      const page = GO.get(e.key.toLowerCase());
      if (page && o.title(page) !== null) o.go(page);
      return;
    }
    if (e.key === 'g') {
      e.preventDefault();
      chord = setTimeout(() => (chord = undefined), CHORD_MS);
      return;
    }
    if (e.key === '?') {
      e.preventDefault();
      show();
      return;
    }
    const target = keyTarget(o.root, e.key);
    if (e.key === '/') {
      e.preventDefault();
      if (target) {
        target.focus();
        if (target instanceof HTMLInputElement) target.select();
      } else o.palette();
      return;
    }
    if (target) {
      e.preventDefault();
      // A field takes the focus (the warning's outcome, U5.04); a button or link is pressed.
      if (target.matches('input, select, textarea')) target.focus();
      else target.click();
    }
  });
  return { show };
}
