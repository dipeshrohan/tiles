// Micro-interactions (U3.04, docs/ui/motion.md): what changes on a page drawn again moves a little,
// so the eye follows it. A row added to a list fades in and one removed fades out; a number ticks to
// its new value; the highlight of a selected tab or row moves from where it was. Only when a page is
// drawn again in place (js/lib/morph.ts), never on a new page, and never when less motion is asked
// for. Each uses the motion tokens, and only opacity and transform.

import { lessMotion } from './dom.ts';
import type { MorphHooks } from './morph.ts';

const token = (name: string, fallback: number): number => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ms = Number.parseFloat(v);
  return Number.isFinite(ms) ? ms : fallback;
};
const ease = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'ease';

// Rows that come and go: a fade (and a short rise) in, a quicker fade out; then the row goes.
export const rowMotion: MorphHooks = {
  enter(el) {
    if (lessMotion() || typeof el.animate !== 'function') return;
    el.animate(
      [
        { opacity: 0, transform: 'translateY(-4px)' },
        { opacity: 1, transform: 'none' },
      ],
      {
        duration: token('--dur', 200),
        easing: ease('--ease-out'),
      },
    );
  },
  leave(el) {
    if (lessMotion() || typeof el.animate !== 'function' || !el.isConnected) return false;
    el.setAttribute('inert', '');
    el.setAttribute('aria-hidden', 'true');
    const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: token('--dur-fast', 120),
      easing: ease('--ease-in'),
      fill: 'forwards',
    });
    const remove = () => el.remove();
    fade.finished.then(remove, remove);
    return true;
  },
};

// What a highlight sat on, and what a number said, before the page was drawn again.
const HIGHLIGHT = '.tab.active, .seg button.active, .review-row.sel';
const HIGHLIGHTED_IN = '.tabs, .seg, .review-list';
const NUMBERS = '.kpi .value, [data-tick]';

export interface Before {
  highlights: Map<Element, DOMRect>;
  numbers: Map<Element, string>;
}

export function before(root: Element): Before {
  const highlights = new Map<Element, DOMRect>();
  for (const group of root.querySelectorAll(HIGHLIGHTED_IN)) {
    const on = group.querySelector(`:scope > :is(${HIGHLIGHT})`);
    if (on) highlights.set(group, on.getBoundingClientRect());
  }
  const numbers = new Map<Element, string>();
  for (const el of root.querySelectorAll(NUMBERS)) {
    // A count still going is where it was going: it stops, and the new one starts from there.
    numbers.set(el, running.get(el)?.to ?? el.textContent ?? '');
    running.delete(el);
  }
  return { highlights, numbers };
}

// After the page is drawn again: moves the highlights and ticks the numbers that changed.
export function after(root: Element, was: Before): void {
  if (lessMotion()) return;
  for (const [group, from] of was.highlights) {
    if (!group.isConnected || !root.contains(group)) continue;
    const on = group.querySelector<HTMLElement>(`:scope > :is(${HIGHLIGHT})`);
    if (on) glide(on, from);
  }
  for (const [el, text] of was.numbers) {
    if (el.isConnected && el.textContent !== text) tick(el, text, el.textContent ?? '');
  }
}

// The highlight (the element's ::before, css/styles.css) slides and stretches from the old place.
function glide(on: HTMLElement, from: DOMRect): void {
  const to = on.getBoundingClientRect();
  if (!to.width || !to.height || (from.x === to.x && from.y === to.y && from.width === to.width)) return;
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  on.animate(
    [
      {
        transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        transformOrigin: 'top left',
      },
      { transform: 'none', transformOrigin: 'top left' },
    ],
    { duration: token('--dur', 200), easing: ease('--ease-out'), pseudoElement: '::before' },
  );
}

// A number counts from its old value to its new one, as written (prefix, separators, decimals,
// suffix kept). Text that isn't one number, or changes its unit, just changes.
const NUMBER = /^(\D*?)(-?\d[\d,]*(?:\.\d+)?)(\D*)$/;
// A count under way, with the text it counts to (drawn again meanwhile, that is where it was going).
const running = new WeakMap<Element, { to: string }>();

export function parseNumber(
  text: string,
): { prefix: string; value: number; decimals: number; grouped: boolean; suffix: string } | null {
  const m = NUMBER.exec(text.trim());
  if (!m) return null;
  const [, prefix = '', digits = '', suffix = ''] = m;
  const value = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return { prefix, value, decimals: digits.split('.')[1]?.length ?? 0, grouped: digits.includes(','), suffix };
}

export function formatNumber(n: number, like: { decimals: number; grouped: boolean }): string {
  return n.toLocaleString('en-GB', {
    minimumFractionDigits: like.decimals,
    maximumFractionDigits: like.decimals,
    useGrouping: like.grouped,
  });
}

function tick(el: Element, from: string, to: string): void {
  const a = parseNumber(from);
  const b = parseNumber(to);
  if (!a || !b || a.prefix !== b.prefix || a.suffix !== b.suffix || a.value === b.value) return;
  const duration = token('--dur-slow', 320);
  const start = performance.now();
  const run = { to };
  running.set(el, run);
  const frame = (now: number) => {
    if (running.get(el) !== run || !el.isConnected) return; // drawn again, or gone: stop
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3; // fast, then settling, as --ease-out
    el.textContent = t < 1 ? `${b.prefix}${formatNumber(a.value + (b.value - a.value) * eased, b)}${b.suffix}` : to;
    if (t < 1) requestAnimationFrame(frame);
    else running.delete(el);
  };
  requestAnimationFrame(frame);
}
