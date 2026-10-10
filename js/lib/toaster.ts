// Toasts (U2.02), after shadcn/ui's Sonner: a stack in the corner, newest at the bottom, up to three
// at a time. Each slides in, can carry an action (Undo, Retry…) and a close button. Success goes after
// 5 s, the rest after 4 s; pointing at or focusing a toast's buttons pauses that. Errors stay until
// dismissed, with the request ID the API gave them, to quote to support. Screen readers hear each
// once, from two hidden live regions made with the stack: a status for most, an alert for errors.
import { esc } from './dom.ts';
import { icon, type IconName } from './icons.ts';

export type ToastType = 'default' | 'success' | 'info' | 'warning' | 'error';

export interface ToastOptions {
  type?: ToastType;
  description?: string;
  action?: { label: string; run: () => void };
  duration?: number; // ms; success 5 s, errors until dismissed, the rest 4 s
  requestId?: string | null; // an API error's X-Request-ID, shown with a copy button
}

const DURATION: Record<ToastType, number> = {
  default: 4000,
  success: 5000,
  info: 4000,
  warning: 4000,
  error: Infinity,
};

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
  // The visible stack isn't a live region (it would be read as well); these are, from page load.
  stack.setAttribute('aria-live', 'off');
  const region = (role: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'sr-only';
    el.setAttribute('role', role);
    el.dataset.toastAnnounce = role;
    stack.after(el);
    return el;
  };
  const polite = region('status');
  const urgent = region('alert');
  let said: ReturnType<typeof setTimeout> | undefined;
  const announce = (el: HTMLElement, text: string): void => {
    // Emptied first, so the same words again are read again.
    el.textContent = '';
    clearTimeout(said);
    said = setTimeout(() => (el.textContent = text), 100);
  };
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
    }${
      opts.requestId
        ? `<div class="toast-meta">Request ID <code>${esc(opts.requestId)}</code> <button class="toast-copy" type="button" data-toast-copy aria-label="Copy the request ID">${icon('copy', { size: 12 })}</button></div>`
        : ''
    }</div>${opts.action ? `<button class="btn sm" type="button" data-toast-action>${esc(opts.action.label)}</button>` : ''}<button class="toast-close" type="button" aria-label="Dismiss">${icon('x', { size: 14 })}</button>`;
    item.querySelector('[data-toast-action]')?.addEventListener('click', () => {
      opts.action?.run();
      remove(item);
    });
    item.querySelector('.toast-close')?.addEventListener('click', () => remove(item));
    const copy = item.querySelector<HTMLButtonElement>('[data-toast-copy]');
    copy?.addEventListener('click', () => {
      const done = (label: string): void => {
        copy.setAttribute('aria-label', label);
        copy.dataset.tooltip = label;
        announce(polite, label);
      };
      // The clipboard needs a secure page (not file://): say so rather than fail silently.
      void (navigator.clipboard?.writeText(opts.requestId ?? '') ?? Promise.reject(new Error('no clipboard'))).then(
        () => done('Request ID copied'),
        () => done("Can't copy here: select the ID instead"),
      );
    });
    stack.append(item);
    const open = [...stack.querySelectorAll<HTMLElement>('.toast-item:not([data-state=closed])')];
    for (const old of open.slice(0, Math.max(0, open.length - MAX))) remove(old);
    sync();
    const words = [message, opts.description, opts.requestId ? `Request ID ${opts.requestId}` : '']
      .filter(Boolean)
      .join('. ');
    announce(type === 'error' ? urgent : polite, words);
    const ms = opts.duration ?? DURATION[type];
    if (Number.isFinite(ms)) {
      left.set(item, ms);
      timer ??= setInterval(tick, 200);
    }
  };
}
