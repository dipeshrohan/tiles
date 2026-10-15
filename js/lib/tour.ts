// The tour runner (U4.07): one step at a time, a spotlight on the part of the page the step is about
// and a popover beside it with the step's words, its count, Back, Next and Leave the tour. The page
// stays usable under it (the spotlight lets clicks through), so the reader can try what a step says.
// The popover takes the focus at each step and is read out; Escape leaves. With less motion asked
// for, nothing moves (docs/ui/motion.md).
import { esc, scrollBehavior } from './dom.ts';
import type { Tour, TourStep } from './tours.ts';
import { t } from './i18n.ts';

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const GAP = 12; // between the part of the page and the popover
const EDGE = 16; // the popover keeps this far from the window's edges

// Where the popover goes: below the part of the page when there is room, else above it, else (a part
// taller than the window, or none) at the bottom of the window; kept inside the window sideways. On a
// phone it sits at the bottom, the width of the window.
export function placePopover(
  target: Rect | null,
  pop: { width: number; height: number },
  view: { width: number; height: number },
): { top: number; left: number; side: 'below' | 'above' | 'bottom' } {
  const left = (x: number) => Math.min(Math.max(EDGE, x), Math.max(EDGE, view.width - pop.width - EDGE));
  const bottom = {
    top: view.height - pop.height - EDGE,
    left: left((view.width - pop.width) / 2),
    side: 'bottom' as const,
  };
  if (!target || view.width < 640) return bottom;
  const x = left(target.left + target.width / 2 - pop.width / 2);
  const below = target.top + target.height + GAP;
  if (below + pop.height <= view.height - EDGE) return { top: below, left: x, side: 'below' };
  const above = target.top - GAP - pop.height;
  if (above >= EDGE) return { top: above, left: x, side: 'above' };
  return bottom;
}

const selector = (step: TourStep): string => `#view [data-tour="${CSS.escape(step.target)}"]`;
const shown = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.getClientRects().length > 0;
const route = (hash: string): string => hash.split('?')[0]?.replace(/\/$/, '') ?? '';

// Waits for the step's part of the page (after the page changes, or a record opens), at most `ms`.
function waitFor(step: TourStep, ms: number): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const until = performance.now() + ms;
    const look = (): void => {
      const el = document.querySelector(selector(step));
      if (shown(el)) return resolve(el);
      if (performance.now() > until) return resolve(null);
      requestAnimationFrame(look);
    };
    look();
  });
}

export interface TourOptions {
  go(hash: string): void; // takes the app to a page
  ended?(finished: boolean): void; // left (false) or done (true)
}

let current: { stop(): void } | null = null;

export const touring = (): boolean => current !== null;

export function runTour(tour: Tour, o: TourOptions): { stop(): void } {
  current?.stop();
  let at = 0;
  let target: HTMLElement | null = null;
  let frame = 0;
  let stopped = false;
  let seq = 0;
  let loading = false; // a step is on its way: Back and Next wait for it
  let drawnFound = false; // the step shown has its part of the page
  let lastWidth = 0;

  const spot = document.createElement('div');
  spot.className = 'tour-spot';
  spot.setAttribute('aria-hidden', 'true');
  const pop = document.createElement('section');
  pop.className = 'tour-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'false');
  pop.setAttribute('aria-labelledby', 'tour-title');
  pop.setAttribute('aria-describedby', 'tour-body');
  pop.dataset.tour = tour.id;
  document.body.append(spot, pop);

  // Follows the part of the page as it scrolls, moves or is drawn again (looked for again when it is
  // gone or hidden); a step drawn without its part is drawn again once it turns up. Reads come before
  // writes, and nothing is written when nothing moved.
  let last = '';
  const follow = (): void => {
    if (stopped) return;
    const step = tour.steps[at];
    if (step && !loading && !shown(target)) {
      const again = document.querySelector(selector(step));
      target = shown(again) ? again : null;
      if (target && !drawnFound) draw(step, true);
    }
    const r = target?.getBoundingClientRect() ?? null;
    const size = { width: pop.offsetWidth, height: pop.offsetHeight };
    const key = r
      ? `${r.top},${r.left},${r.width},${r.height},${size.width},${size.height}`
      : `none,${size.width},${size.height}`;
    if (key !== last || window.innerWidth !== lastWidth) {
      last = key;
      lastWidth = window.innerWidth;
      spot.hidden = !r;
      if (r) {
        const pad = 6;
        spot.style.top = `${r.top - pad}px`;
        spot.style.left = `${r.left - pad}px`;
        spot.style.width = `${r.width + pad * 2}px`;
        spot.style.height = `${r.height + pad * 2}px`;
      }
      const place = placePopover(r, size, { width: window.innerWidth, height: window.innerHeight });
      pop.style.top = `${place.top}px`;
      pop.style.left = `${place.left}px`;
      pop.dataset.side = place.side;
    }
    frame = requestAnimationFrame(follow);
  };

  const draw = (step: TourStep, found: boolean): void => {
    drawnFound = found;
    const final = at === tour.steps.length - 1;
    const note = found ? '' : step.missing ? `<p class="small soft" data-tour-missing>${esc(step.missing)}</p>` : '';
    pop.innerHTML = `
      <p class="small soft" id="tour-count">${esc(t('tour.count', { title: tour.title, step: at + 1, steps: tour.steps.length }))}</p>
      <h2 id="tour-title" tabindex="-1">${esc(step.title)}</h2>
      <p id="tour-body">${esc(step.body)}</p>
      ${note}
      <div class="tour-foot">
        <button class="btn ghost sm" type="button" data-tour-leave>${esc(t('tour.leave'))}</button>
        <span class="row gap-2">
          ${at > 0 ? `<button class="btn sm" type="button" data-tour-back>${esc(t('tour.back'))}</button>` : ''}
          <button class="btn primary sm" type="button" data-tour-next>${final ? esc(t('tour.done')) : esc(t('tour.next'))}</button>
        </span>
      </div>`;
    pop.querySelector<HTMLElement>('#tour-title')?.focus({ preventScroll: true });
  };

  const show = async (i: number): Promise<void> => {
    const step = tour.steps[i];
    if (!step || loading) return;
    const mine = ++seq;
    loading = true;
    pop.setAttribute('aria-busy', 'true');
    if (route(location.hash) !== route(step.page)) o.go(step.page);
    // A part behind a reveal (a warning's chart) isn't there until it is pressed: a short look first.
    let el = await waitFor(step, step.reveal ? 600 : 4000);
    if (!el && step.reveal && !stopped) {
      document.querySelector<HTMLElement>(`#view ${step.reveal}`)?.click();
      el = await waitFor(step, 3000);
    }
    loading = false;
    pop.removeAttribute('aria-busy');
    if (stopped || mine !== seq) return;
    at = i;
    target = el;
    last = '';
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.top < 64 || r.bottom > window.innerHeight - 64)
        window.scrollTo({ top: r.top + window.scrollY - 96, behavior: scrollBehavior() });
    }
    draw(step, Boolean(el));
  };

  const stop = (finished = false): void => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    spot.remove();
    pop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (current === handle) current = null;
    o.ended?.(finished);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    e.stopPropagation(); // the tour's Escape: not the menu's or a tooltip's too
    stop();
  };
  pop.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (el?.closest('[data-tour-leave]')) return stop();
    if (loading)
      return; // the next step is on its way
    else if (el?.closest('[data-tour-back]')) void show(at - 1);
    else if (el?.closest('[data-tour-next]')) {
      if (at === tour.steps.length - 1) stop(true);
      else void show(at + 1);
    }
  });
  document.addEventListener('keydown', onKey, true);
  const handle = { stop: () => stop() };
  current = handle;
  frame = requestAnimationFrame(follow);
  void show(0);
  return handle;
}
