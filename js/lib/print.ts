// Print (U6.05): what the stylesheet can't do alone. Before printing, each link in the page gets
// its full address (shown after its text by css/styles.css, so a printed record still says where
// its links go) and folded details are opened; after, both are put back.

const opened = new WeakSet<HTMLDetailsElement>();

// Whether a link's address says something its text doesn't: not a button, a record's row, or a
// link that already reads as its address.
export function printsHref(a: HTMLAnchorElement): boolean {
  if (a.matches('.btn, .row-open') || a.closest('.chart-tools')) return false;
  if (!/^(https?|file):/.test(a.href)) return false;
  const text = (a.textContent ?? '').trim();
  return text !== a.href && text !== a.getAttribute('href');
}

export function beforePrint(root: ParentNode): void {
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    if (printsHref(a)) a.dataset.printHref = a.href;
  });
  root.querySelectorAll<HTMLDetailsElement>('details:not([open])').forEach((d) => {
    d.open = true;
    opened.add(d);
  });
}

export function afterPrint(root: ParentNode): void {
  root.querySelectorAll<HTMLAnchorElement>('a[data-print-href]').forEach((a) => delete a.dataset.printHref);
  root.querySelectorAll<HTMLDetailsElement>('details[open]').forEach((d) => {
    if (opened.has(d)) d.open = false;
    opened.delete(d);
  });
}

export function installPrint(root: () => ParentNode | null): void {
  window.addEventListener('beforeprint', () => {
    const r = root();
    if (r) beforePrint(r);
  });
  window.addEventListener('afterprint', () => {
    const r = root();
    if (r) afterPrint(r);
  });
}
