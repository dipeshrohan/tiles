// Print (U6.05): what the stylesheet can't do alone. It writes Tiles' own links (#/…) out after the
// app's address, which it can't know: set here as --print-base, from http(s) only (from file:// it
// would print a local path, so those links print without one). And a browser without
// ::details-content gets folded details opened while printing, folded again after.

const opened = new WeakSet<HTMLDetailsElement>();

// The app's address for the stylesheet, a CSS string; null when it isn't one to print.
export function printBase(href: string): string | null {
  const base = href.split('#')[0] ?? '';
  return /^https?:\/\//.test(base) ? JSON.stringify(base) : null;
}

export function installPrint(root: () => ParentNode | null): void {
  const base = printBase(location.href);
  if (base) document.documentElement.style.setProperty('--print-base', base);
  if (CSS.supports('selector(::details-content)')) return;
  window.addEventListener('beforeprint', () => {
    root()
      ?.querySelectorAll<HTMLDetailsElement>('details:not([open])')
      .forEach((d) => {
        d.open = true;
        opened.add(d);
      });
  });
  window.addEventListener('afterprint', () => {
    root()
      ?.querySelectorAll<HTMLDetailsElement>('details[open]')
      .forEach((d) => {
        if (opened.has(d)) d.open = false;
      });
  });
}
