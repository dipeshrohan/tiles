// A picture of the page as the person sees it (U4.09's feedback), made without a library: the page
// is copied, with its stylesheet's rules, into an SVG's <foreignObject>, drawn on a canvas and kept
// as a JPEG. Open dialogs (the feedback form itself), tooltips and scripts are left out; typed values
// are kept. Null when it can't be made: a stylesheet the page may not read (opened from file://), or
// a browser that won't draw it.

const MAX_WIDTH = 1600; // px: a wider window is scaled down
export const MAX_BYTES = 2 * 1024 * 1024; // what the API takes, decoded

// The stylesheet's rules as text, `:root` made an attribute selector of the same weight (inside the
// SVG, `:root` would be the <svg>); null when one can't be read.
export function stylesText(sheets: ArrayLike<CSSStyleSheet> = document.styleSheets): string | null {
  let css = '';
  for (const sheet of Array.from(sheets)) {
    try {
      css += `${Array.from(sheet.cssRules, (r) => r.cssText).join('\n')}\n`;
    } catch {
      return null;
    }
  }
  return css.replace(/:root\b/g, '[data-shot-root]');
}

// Whether the stylesheets can be read here (not from file://), without reading them out.
export function canCapture(sheets: ArrayLike<CSSStyleSheet> = document.styleSheets): boolean {
  try {
    for (const sheet of Array.from(sheets)) void sheet.cssRules;
    return true;
  } catch {
    return false;
  }
}

// The decoded size of a base64 data URL.
export const dataUrlBytes = (url: string): number => {
  const data = url.slice(url.indexOf(',') + 1);
  return Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
};

// The page copied for the picture: what is typed and chosen kept, panes scrolled as they are (their
// content moved by the rules in `css`), canvases as images, and what isn't the page (dialogs,
// tooltips, scripts) left out.
function copyOfPage(): { copy: HTMLElement; css: string } {
  const page = document.documentElement;
  const copy = page.cloneNode(true) as HTMLElement;
  // First, while the copy's elements still match the page's one for one.
  let css = '';
  const all = page.querySelectorAll('*');
  copy.querySelectorAll('*').forEach((el, i) => {
    const from = all[i];
    if (!from || from === document.body || (!from.scrollTop && !from.scrollLeft)) return;
    el.setAttribute('data-shot-scroll', String(i));
    css += `[data-shot-scroll="${i}"]>*{translate:${-from.scrollLeft}px ${-from.scrollTop}px}`; // i18n-ok (CSS)
  });
  const fields = page.querySelectorAll('input, textarea, select, canvas');
  copy.querySelectorAll('input, textarea, select, canvas').forEach((el, i) => {
    const from = fields[i];
    if (from instanceof HTMLInputElement && el instanceof HTMLInputElement) {
      if (from.type === 'checkbox' || from.type === 'radio') el.toggleAttribute('checked', from.checked);
      else if (from.type !== 'password' && from.type !== 'file') el.setAttribute('value', from.value);
    } else if (from instanceof HTMLTextAreaElement) el.textContent = from.value;
    else if (from instanceof HTMLSelectElement && el instanceof HTMLSelectElement)
      Array.from(el.options).forEach((o, j) => o.toggleAttribute('selected', j === from.selectedIndex));
    else if (from instanceof HTMLCanvasElement) {
      try {
        const img = document.createElement('img');
        img.src = from.toDataURL();
        img.width = from.clientWidth;
        img.height = from.clientHeight;
        el.replaceWith(img);
      } catch {
        el.remove();
      }
    }
  });
  copy
    .querySelectorAll(
      'script, link, style, noscript, iframe, dialog, .tooltip, [role="tooltip"], .tour-spot, .tour-pop',
    )
    .forEach((el) => el.remove());
  copy.setAttribute('data-shot-root', '');
  return { copy, css };
}

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The picture of the page could not be drawn')); // i18n-ok (caught: never shown)
    img.src = src;
  });

// The window's part of the page as a JPEG data URL, or null.
export async function capturePage(): Promise<string | null> {
  const css = stylesText();
  if (css === null) return null;
  const width = window.innerWidth;
  const height = window.innerHeight;
  // The page scrolled as it is: fixed parts (the top bar, the menu) stay where they are. Nothing
  // moves in a picture: an entrance that starts unseen would stay unseen.
  const view = `[data-shot-root]{width:${width}px;height:${height}px;overflow:hidden}body{margin-top:-${Math.round(window.scrollY)}px}*,*::before,*::after{animation:none!important;transition:none!important}`;
  const { copy, css: scrolled } = copyOfPage();
  const head = copy.querySelector('head') ?? copy.insertBefore(document.createElement('head'), copy.firstChild);
  const style = document.createElement('style');
  style.textContent = css + view + scrolled;
  head.append(style);
  const xhtml = new XMLSerializer().serializeToString(copy);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  try {
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    const scale = Math.min(1, MAX_WIDTH / width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.6, 0.4]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.startsWith('data:image/jpeg') && dataUrlBytes(url) <= MAX_BYTES) return url;
    }
    return null;
  } catch {
    return null;
  }
}
