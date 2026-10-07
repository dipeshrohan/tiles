export const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

export const fmt = (n, digits = 0) =>
  Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '–';

export const signed = (n, digits = 0) => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n), digits)}`;

export const timeAgo = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
