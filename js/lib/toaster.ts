// Toasts (U2.02), after shadcn/ui's Sonner: a stack in the corner, newest at the bottom, up to three
// at a time. Each slides in, can carry an action (Undo, Retry…) and a close button, and goes after a
// while, longer for errors; pointing at or focusing its buttons pauses that. The stack is a polite
// live region, so each is read once.
import { esc } from './dom.ts';
import { icon, type IconName } from './icons.ts';

export type ToastType = 'default' | 'success' | 'info' | 'warning' | 'error';

export interface ToastOptions {
  type?: ToastType;
  description?: string;
  action?: { label: string; run: () => void };
  duration?: number; // ms; errors 8 s, the rest 4 s
}

const ICON: Record<ToastType, IconName | null> = {
  default: null,
  success: 'circle-check',
  info: 'info',
  warning: 'triangle-alert',
  error: 'circle-alert',
};
const MAX = 3;

export type Toast = (message: string, opts?: ToastOptions) => void;

export function createToaster(stack: HTMLElement): Toast {
  // A toast lets clicks through to what it covers (only its buttons take them), so the pointer over
  // one of its buttons, or keyboard focus in it, holds them all. Read afresh at each tick: a button
  // removed under the pointer sends no pointerout.
  const paused = (): boolean => stack.querySelector('button:hover') !== null || stack.contains(document.activeElement);
  // One timer for the stack, running only while toasts are shown: each tick takes 200 ms off each.
  const left = new Map<HTMLElement, number>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = (): void => {
    if (paused()) return;
    for (const [item, ms] of left) {
      if (ms <= 200) remove(item);
      else left.set(item, ms - 200);
    }
  };
  const sync = (): void => {
    stack.classList.toggle('show', stack.querySelector('.toast-item:not([data-state=closed])') !== null);
  };

  const remove = (item: HTMLElement): void => {
    left.delete(item);
    if (!left.size) timer = void clearInterval(timer);
    if (item.dataset.state === 'closed') return;
    item.dataset.state = 'closed';
    sync();
    const gone = (): void => item.remove();
    const running = item.getAnimations();
    if (running.length) void Promise.all(running.map((a) => a.finished.catch(() => {}))).then(gone);
    else gone();
    setTimeout(gone, 400);
  };

  return (message, opts = {}) => {
    const type = opts.type ?? 'default';
    // The same message again (a repeated failure) refreshes the one shown rather than stacking.
    for (const old of stack.querySelectorAll<HTMLElement>('.toast-item:not([data-state=closed])')) {
      if (old.dataset.message === message) remove(old);
    }
    const item = document.createElement('li');
    item.className = 'toast-item';
    item.dataset.type = type;
    item.dataset.message = message;
    item.dataset.state = 'open';
    // The stack is a polite live region from page load: each toast, errors too, is read once.
    const symbol = ICON[type];
    item.innerHTML = `${symbol ? `<span class="toast-icon">${icon(symbol)}</span>` : ''}<div class="toast-text"><div class="toast-title">${esc(message)}</div>${
      opts.description ? `<div class="toast-desc">${esc(opts.description)}</div>` : ''
    }</div>${opts.action ? `<button class="btn sm" type="button" data-toast-action>${esc(opts.action.label)}</button>` : ''}<button class="toast-close" type="button" aria-label="Dismiss">${icon('x', { size: 14 })}</button>`;
    item.querySelector('[data-toast-action]')?.addEventListener('click', () => {
      opts.action?.run();
      remove(item);
    });
    item.querySelector('.toast-close')?.addEventListener('click', () => remove(item));
    stack.append(item);
    const open = [...stack.querySelectorAll<HTMLElement>('.toast-item:not([data-state=closed])')];
    for (const old of open.slice(0, Math.max(0, open.length - MAX))) remove(old);
    sync();
    left.set(item, opts.duration ?? (type === 'error' ? 8000 : 4000));
    timer ??= setInterval(tick, 200);
  };
}
