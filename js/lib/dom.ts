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

// Attach the same listener to every element matching `sel`.
export function onAll<K extends keyof HTMLElementEventMap>(
  root: ParentNode,
  sel: string,
  type: K,
  handler: (el: HTMLElement, event: HTMLElementEventMap[K]) => void,
): void {
  root.querySelectorAll<HTMLElement>(sel).forEach((el) => el.addEventListener(type, (e) => handler(el, e)));
}

// Submit handler for a form found by selector, if present.
// The handler also gets the button that submitted the form, when there is one.
export function onSubmit(
  root: ParentNode,
  sel: string,
  handler: (form: HTMLFormElement, submitter: HTMLElement | null) => void,
): void {
  root.querySelector<HTMLFormElement>(sel)?.addEventListener('submit', (e) => {
    e.preventDefault();
    handler(e.currentTarget as HTMLFormElement, e.submitter);
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
