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
