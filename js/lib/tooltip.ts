// Tooltips (U4.05's component, after shadcn/ui's Tooltip): any element with data-tooltip="…" shows
// it above itself on hover (after a short wait) or keyboard focus (at once), and is described by
// it for screen readers. Escape, leaving or scrolling hides it. One tooltip element serves the page.
// A button or link with a keyboard shortcut (aria-keyshortcuts, U4.03) shows its key there too, after
// its tooltip or, without one, its name; screen readers have the key from the attribute already.
import { keyLabel } from './shortcuts.ts';

let tip: HTMLElement | null = null;
let target: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function element(): HTMLElement {
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'tooltip';
    tip.className = 'tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

const nameOf = (el: HTMLElement): string => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();

function show(el: HTMLElement): void {
  const text = el.dataset.tooltip ?? '';
  const keys = el.getAttribute('aria-keyshortcuts') ?? '';
  const key = /^\S$/.test(keys) ? keys : null; // one key (Ctrl K and the like are written beside them)
  if (!text && !key) return;
  const t = element();
  t.textContent = text || nameOf(el);
  if (key) {
    const k = document.createElement('kbd');
    k.textContent = keyLabel(key);
    k.setAttribute('aria-hidden', 'true'); // the attribute says it already: not read twice
    t.append(' ', k);
  }
  t.hidden = false;
  t.dataset.state = 'open';
  // Added to what already describes it, not instead; not when it only repeats the element's name.
  const described = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const named = nameOf(el) === text.trim();
  if (text && !named && !described.includes('tooltip'))
    el.setAttribute('aria-describedby', [...described, 'tooltip'].join(' '));
  target = el;
  watch();
  const r = el.getBoundingClientRect();
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  const below = r.top < h + 12; // no room above: below instead
  t.dataset.side = below ? 'bottom' : 'top';
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  t.style.left = `${left + window.scrollX}px`;
  t.style.top = `${(below ? r.bottom + 8 : r.top - h - 8) + window.scrollY}px`;
}

// A re-render can take the element away without a pointerout or focusout: the tooltip goes with it.
function watch(): void {
  requestAnimationFrame(() => {
    if (!target) return;
    if (!target.isConnected) hide();
    else watch();
  });
}

function hide(): void {
  clearTimeout(timer);
  if (target) {
    const rest = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((t) => t && t !== 'tooltip');
    if (rest.length) target.setAttribute('aria-describedby', rest.join(' '));
    else target.removeAttribute('aria-describedby');
  }
  target = null;
  if (tip) {
    tip.hidden = true;
    delete tip.dataset.state;
  }
}

// A field's key isn't shown: its tooltip would cover what is typed (? lists it).
const owner = (e: Event): HTMLElement | null =>
  e.target instanceof Element
    ? e.target.closest<HTMLElement>('[data-tooltip], button[aria-keyshortcuts], a[aria-keyshortcuts]')
    : null;

export function installTooltips(root: Document = document): void {
  // Hover is a mouse's or a pen's: a finger taps (below), and its pointerout before the click would
  // hide what the tap shows.
  root.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = owner(e);
    if (!el || el === target) return;
    hide();
    timer = setTimeout(() => show(el), 400);
  });
  root.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch') return;
    if (owner(e) && !(e.relatedTarget instanceof Node && owner(e)?.contains(e.relatedTarget))) hide();
  });
  root.addEventListener('focusin', (e) => {
    const el = owner(e);
    if (el && (el as Element).matches(':focus-visible')) show(el);
  });
  root.addEventListener('focusout', hide);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && target) hide();
  });
  window.addEventListener('scroll', hide, { passive: true });
  // A tap (or a click) on a glossary term (U4.05) shows its definition, and another hides it; any
  // other click hides the tooltip.
  root.addEventListener('click', (e) => {
    const word = e.target instanceof Element ? e.target.closest<HTMLElement>('.term[data-tooltip]') : null;
    if (word && word !== target) {
      hide();
      show(word);
    } else hide();
  });
}
