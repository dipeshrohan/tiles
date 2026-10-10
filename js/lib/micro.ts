// Micro-interactions (U3.04, docs/ui/motion.md): what changes on a page drawn again moves a little,
// so the eye follows it. A row added to a list fades in and one removed fades out; a number ticks to
// its new value; the highlight of a selected tab or row moves from the one selected before; a section
// someone opens fades its content in. Only when a page is drawn again in place (js/lib/morph.ts),
// never on a new page, and never when less motion is asked for. Each uses the motion tokens, and
// only opacity and transform.

import { fmt, lessMotion } from './dom.ts';
import type { MorphHooks } from './morph.ts';

interface Tokens {
  fast: number;
  standard: number;
  slow: number;
  in: string;
  out: string;
}
// Read once per drawing (before()), not per animation.
let tokens: Tokens = { fast: 120, standard: 200, slow: 320, in: 'ease-in', out: 'ease-out' };
function readTokens(): Tokens {
  const css = getComputedStyle(document.documentElement);
  const ms = (name: string, fallback: number) => {
    const v = Number.parseFloat(css.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  const curve = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    fast: ms('--dur-fast', 120),
    standard: ms('--dur', 200),
    slow: ms('--dur-slow', 320),
    in: curve('--ease-in', 'ease-in'),
    out: curve('--ease-out', 'ease-out'),
  };
}

const canAnimate = (el: Element): boolean => typeof el.animate === 'function';

// Rows that come and go: a fade (and a short rise) in, a quicker fade out; then the row goes. The
// morph calls these for a few rows at a time only (a list replaced just changes).
export const rowMotion: MorphHooks = {
  enter(el) {
    if (lessMotion() || !canAnimate(el)) return;
    el.animate(
      [
        { opacity: 0, transform: 'translateY(-4px)' },
        { opacity: 1, transform: 'none' },
      ],
      {
        duration: tokens.standard,
        easing: tokens.out,
      },
    );
  },
  leave(el) {
    if (lessMotion() || !canAnimate(el) || !el.isConnected) return false;
    el.setAttribute('inert', '');
    el.setAttribute('aria-hidden', 'true');
    const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: tokens.fast,
      easing: tokens.in,
      fill: 'forwards',
    });
    const remove = () => el.remove();
    fade.finished.then(remove, remove);
    return true;
  },
};

// What a highlight sat on (and where, inside its group), and what a number said, before the page was
// drawn again.
const HIGHLIGHT = '.tab.active, .seg button.active, .review-row.sel';
const HIGHLIGHTED_IN = '.tabs, .seg, .review-list';
const NUMBERS = '.kpi .value, [data-tick]';

export interface Before {
  highlights: Map<Element, { on: Element; at: DOMRect }>;
  numbers: Map<Element, string>;
}

// Where things were: nothing with less motion (nothing will move, so nothing is measured).
export function before(root: Element): Before | null {
  if (lessMotion()) return null;
  tokens = readTokens();
  const highlights = new Map<Element, { on: Element; at: DOMRect }>();
  for (const group of root.querySelectorAll(HIGHLIGHTED_IN)) {
    const on = group.querySelector(`:scope > :is(${HIGHLIGHT})`);
    if (on) highlights.set(group, { on, at: within(on, group) });
  }
  const numbers = new Map<Element, string>();
  for (const el of root.querySelectorAll(NUMBERS)) {
    // A count still going is where it was going: it stops, and the new one starts from there.
    numbers.set(el, running.get(el)?.to ?? el.textContent ?? '');
    running.delete(el);
  }
  return { highlights, numbers };
}

// An element's box inside its group, so the group moving on the page doesn't count as a change.
function within(el: Element, group: Element): DOMRect {
  const a = el.getBoundingClientRect();
  const g = group.getBoundingClientRect();
  return new DOMRect(a.x - g.x, a.y - g.y, a.width, a.height);
}

// After the page is drawn again: moves the highlights that moved to another element, and ticks the
// numbers that changed.
export function after(root: Element, was: Before | null): void {
  if (!was || lessMotion()) return;
  for (const [group, from] of was.highlights) {
    if (!group.isConnected || !root.contains(group)) continue;
    const on = group.querySelector<HTMLElement>(`:scope > :is(${HIGHLIGHT})`);
    if (on && on !== from.on) glide(on, from.at, within(on, group));
  }
  for (const [el, text] of was.numbers) {
    if (el.isConnected && el.textContent !== text) tick(el, text);
  }
}

// The highlight (the element's ::before, css/styles.css) slides and stretches from the old place.
// A browser that can't animate a pseudo-element just shows it in the new place.
const pseudo = typeof KeyframeEffect !== 'undefined' && 'pseudoElement' in KeyframeEffect.prototype;
function glide(on: HTMLElement, from: DOMRect, to: DOMRect): void {
  if (!pseudo || !canAnimate(on) || !to.width || !to.height) return;
  on.animate(
    [
      {
        transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        transformOrigin: 'top left',
      },
      { transform: 'none', transformOrigin: 'top left' },
    ],
    { duration: tokens.standard, easing: tokens.out, pseudoElement: '::before' },
  );
}

// A number counts from its old value to its new one, as written (prefix, separators, decimals,
// suffix kept), in its one text node. Text that isn't one number, changes its unit, or has markup
// inside, just changes.
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

// As the page writes numbers (fmt), without the separators when it wrote none.
export function formatNumber(n: number, like: { decimals: number; grouped: boolean }): string {
  const s = fmt(n, like.decimals);
  return like.grouped ? s : s.replace(/,/g, '');
}

function tick(el: Element, from: string): void {
  const text = el.firstChild;
  if (el.childNodes.length !== 1 || !(text instanceof Text)) return;
  const to = text.data;
  const a = parseNumber(from);
  const b = parseNumber(to);
  if (!a || !b || a.prefix !== b.prefix || a.suffix !== b.suffix || a.value === b.value) return;
  const start = performance.now();
  const run = { to };
  running.set(el, run);
  const frame = (now: number) => {
    if (running.get(el) !== run || !text.isConnected) return; // drawn again, or gone: stop
    const t = Math.min(1, (now - start) / tokens.slow);
    const eased = 1 - (1 - t) ** 3; // fast, then settling, as --ease-out
    text.data = t < 1 ? `${b.prefix}${formatNumber(a.value + (b.value - a.value) * eased, b)}${b.suffix}` : to;
    if (t < 1) requestAnimationFrame(frame);
    else running.delete(el);
  };
  requestAnimationFrame(frame);
}

// A section someone opens (by its summary: a click, or Enter or Space on it) fades its content in.
// One the page opens, on its first drawing or after, doesn't move.
const opening = new WeakSet<HTMLDetailsElement>();
export function watchSections(doc: Document): void {
  doc.addEventListener(
    'click',
    (e) => {
      const summary = e.target instanceof Element ? e.target.closest('summary') : null;
      const d = summary?.parentElement;
      if (d instanceof HTMLDetailsElement && summary === d.querySelector(':scope > summary') && !d.open) opening.add(d);
    },
    true,
  );
  doc.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !opening.has(d)) return;
      opening.delete(d);
      if (!d.open || lessMotion()) return;
      tokens = readTokens();
      for (const child of d.children)
        if (child.tagName !== 'SUMMARY' && canAnimate(child))
          child.animate(
            [
              { opacity: 0, transform: 'translateY(-4px)' },
              { opacity: 1, transform: 'none' },
            ],
            {
              duration: tokens.standard,
              easing: tokens.out,
            },
          );
    },
    true,
  );
}
