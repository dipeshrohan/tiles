import { noteSent } from './morph.ts';
import { checkOnSubmit } from './forms.ts';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

export const fmt = (n: number, digits = 0): string =>
  Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '–';

export const signed = (n: number, digits = 0): string => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n), digits)}`;

export const timeAgo = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E | null =>
  root.querySelector<E>(sel);
export const $$ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E[] => [
  ...root.querySelectorAll<E>(sel),
];

// Like querySelector, but throws when the element is missing so a broken
// template fails loudly instead of silently doing nothing.
// Tells screen-reader users something the page shows has changed (through #announcer, a live region
// that stays put while pages re-render).
export function announce(message: string): void {
  const region = typeof document === 'undefined' ? null : document.querySelector('#announcer');
  if (region) region.textContent = message;
}

export function need<E extends Element = HTMLElement>(root: ParentNode, sel: string): E {
  const el = root.querySelector<E>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
}

// Value of a named control in a form (input, select or textarea).
export function field(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    return el.value;
  }
  throw new Error(`Form has no field ${name}`);
}

// Listeners a page adds as it binds (U3.03). A page drawn again keeps its elements (js/lib/morph.ts),
// so the listeners of its last binding are dropped before it binds again: every listener a view adds
// passes `{ signal: bound() }` (test/morph.test.js checks the views do).
let binding = new AbortController();
export const bound = (): AbortSignal => binding.signal;
export function rebind(): AbortSignal {
  binding.abort();
  binding = new AbortController();
  return binding.signal;
}

// Attach the same listener to every element matching `sel`.
export function onAll<K extends keyof HTMLElementEventMap>(
  root: ParentNode,
  sel: string,
  type: K,
  handler: (el: HTMLElement, event: HTMLElementEventMap[K]) => void,
): void {
  root
    .querySelectorAll<HTMLElement>(sel)
    .forEach((el) => el.addEventListener(type, (e) => handler(el, e), { signal: bound() }));
}

// How a scroll the app starts should move: smoothly, unless the system or Tiles (data-motion,
// U6.06) asks for less motion (docs/ui/motion.md). CSS can't reach a scroll started from script.
export function scrollBehavior(): ScrollBehavior {
  const reduce =
    document.documentElement.dataset.motion === 'reduce' ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  return reduce ? 'auto' : 'smooth';
}

// Puts a button already on the page into (or out of) its busy state, as button({ busy }) in ui.ts
// draws it: disabled, aria-busy, a spinner over its label (which keeps its width).
export function setBusy(el: HTMLButtonElement, busy: boolean): void {
  el.disabled = busy;
  el.classList.toggle('busy', busy);
  const label = el.querySelector('.btn-label');
  if (busy) {
    el.setAttribute('aria-busy', 'true');
    if (!label)
      el.innerHTML = `<span class="btn-label">${el.innerHTML}</span><span class="btn-spinner" aria-hidden="true"></span>`;
  } else {
    el.removeAttribute('aria-busy');
    if (label) el.innerHTML = label.innerHTML;
  }
}

// Submit handler for a form found by selector, if present.
// The handler also gets the button that submitted the form, when there is one. A handler that
// returns a promise (its request) holds the form while it runs (U2.08): the button that sent it is
// busy, and sending it again does nothing until it is done.
export function onSubmit(
  root: ParentNode,
  sel: string,
  handler: (form: HTMLFormElement, submitter: HTMLElement | null) => unknown,
): void {
  const form = root.querySelector<HTMLFormElement>(sel);
  if (!form) return;
  form.noValidate = true; // checked here instead, with errors on the fields (U2.07)
  form.addEventListener(
    'submit',
    (e) => {
      e.preventDefault();
      if (sending.has(form)) return;
      if (!checkOnSubmit(form)) return;
      noteSent(form); // what it holds now is sent: drawn again, its fields show the page's (U3.03)
      const button =
        e.submitter instanceof HTMLButtonElement
          ? e.submitter
          : form.querySelector<HTMLButtonElement>('button[type=submit], button:not([type])');
      hold(form, button, handler(form, e.submitter));
    },
    { signal: bound() },
  );
}

// A button's click handler that returns a promise holds the button the same way: busy, and not
// pressed twice (a double click sends one request).
export function onAction(root: ParentNode, sel: string, handler: (el: HTMLButtonElement) => unknown): void {
  root.querySelectorAll<HTMLButtonElement>(sel).forEach((el) =>
    el.addEventListener(
      'click',
      () => {
        if (sending.has(el)) return;
        hold(el, el, handler(el));
      },
      { signal: bound() },
    ),
  );
}

// What is being sent: a form or a button whose request hasn't answered. Kept here, not in a data-
// attribute, which a page drawn again would lose (U3.03), letting a second click through.
const sending = new WeakSet<HTMLElement>();

// The button shows it is busy until the request answers. A page drawn again meanwhile shows what the
// page says (the morph puts the button back to its HTML), and the page's own state keeps it right.
function hold(owner: HTMLElement, button: HTMLButtonElement | null, work: unknown): void {
  if (!(work instanceof Promise)) return;
  sending.add(owner);
  const wasDisabled = button?.disabled ?? false;
  const drawn = bound(); // aborted when the page is drawn again
  if (button) setBusy(button, true);
  // A failure is still reported as before (unhandled, so the console and error capture see it).
  void work.finally(() => {
    sending.delete(owner);
    if (button?.isConnected && !drawn.aborted) {
      setBusy(button, false);
      button.disabled = wasDisabled;
    }
  });
}

// Hands the browser a file to save, made here (e.g. an export fetched with credentials).
export function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The page a hash names, as the router reads it: "#/Warnings?x=1" is "warnings". */
export const routeOf = (hash: string): string => (hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'home').toLowerCase();

/** Calls `fn` with the hash of every navigation. Each event carries its own URL: by the time the
 * events of two quick navigations run (away and straight back), `location.hash` already reads the
 * second, so a page reading it would miss that you left. An event made by code has no URL: it
 * stays on the current page. */
export function onNavigate(fn: (hash: string) => void): void {
  if (typeof window !== 'undefined')
    window.addEventListener('hashchange', (e) => fn(e.newURL ? new URL(e.newURL).hash : location.hash));
}
