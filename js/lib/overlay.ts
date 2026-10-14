// Dialogs (U2.01), after shadcn/ui's AlertDialog, on the native <dialog>: it keeps focus inside,
// makes the page behind it inert, closes with Escape and gives focus back to what opened it. It fades
// and zooms in and out; reduced motion stops that. A modal is the browser's top layer: toasts and
// tooltips raised while one is open sit under it, so keep what a dialog holds short.
import { esc } from './dom.ts';
import { icon } from './icons.ts';

let seq = 0;
const nextId = (): string => `overlay-${++seq}`;

// Plays the closing animation, then removes the dialog. Without animations (reduced motion, or a
// browser that skips them), it closes at once.
function dismiss(dialog: HTMLDialogElement): Promise<void> {
  return new Promise((resolve) => {
    if (dialog.dataset.state === 'closed') return resolve();
    dialog.dataset.state = 'closed';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve();
    };
    const running = dialog.getAnimations({ subtree: true });
    if (running.length) void Promise.all(running.map((a) => a.finished.catch(() => {}))).then(finish);
    else finish();
    setTimeout(finish, 400); // never stuck open
  });
}

// Escape (animated out rather than vanishing) and a click on the backdrop close a dialog: a press and
// a release both outside the panel, not a drag that ends there, nor the scrollbar.
function closeOutside(dialog: HTMLDialogElement, close: () => void): void {
  const outside = (e: MouseEvent): boolean => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (e) => (pressedOutside = outside(e)));
  dialog.addEventListener('click', (e) => {
    if (pressedOutside && outside(e)) close();
  });
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
}

// A link followed in a dialog leaves it for the page it goes to, at once: closed later, the dialog
// would give the focus back to what opened it after the new page has given it to its heading. Not a
// link opened in another tab (Ctrl, ⌘, Shift, another button, a target): the dialog stays open here.
// `closed()` says whether it is gone already; `gone()` is told when this closes it.
function closeOnLink(dialog: HTMLDialogElement, closed: () => boolean, gone: () => void): void {
  dialog.addEventListener('click', (e) => {
    const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
    const elsewhere = e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0 || link?.hasAttribute('target');
    if (closed() || !link || elsewhere) return;
    dialog.close();
    dialog.remove();
    gone();
  });
}

function open(dialog: HTMLDialogElement): void {
  dialog.dataset.state = 'open';
  document.body.append(dialog);
  dialog.showModal();
}

export interface ConfirmOptions {
  title: string;
  body?: string; // what will happen, in words
  confirm?: string; // the button's verb: "Delete", "Archive"…
  cancel?: string;
  tone?: 'default' | 'danger';
  // For what can't be undone: the user types this (a name) before the button works.
  typeToConfirm?: string;
}

// Asks before doing something; resolves to whether the user confirmed.
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  const id = nextId();
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  if (o.body) dialog.setAttribute('aria-describedby', `${id}-body`);
  const danger = o.tone === 'danger';
  dialog.innerHTML = `
    <form method="dialog" class="dialog-panel">
      <div class="dialog-head">
        ${danger ? `<span class="dialog-icon danger">${icon('triangle-alert', { size: 18 })}</span>` : ''}
        <div>
          <h2 id="${id}-title">${esc(o.title)}</h2>
          ${o.body ? `<p id="${id}-body">${esc(o.body)}</p>` : ''}
        </div>
      </div>
      ${
        o.typeToConfirm
          ? `<label class="field"><span>Type <b>${esc(o.typeToConfirm)}</b> to confirm</span><input type="text" name="typed" autocomplete="off" spellcheck="false" autofocus /></label>`
          : ''
      }
      <div class="dialog-foot">
        <button class="btn" value="cancel" ${danger && !o.typeToConfirm ? 'autofocus' : ''}>${esc(o.cancel ?? 'Cancel')}</button>
        <button class="btn ${danger ? 'destructive' : 'primary'}" value="confirm" data-confirm ${o.typeToConfirm ? 'disabled' : ''} ${danger || o.typeToConfirm ? '' : 'autofocus'}>${esc(o.confirm ?? 'Confirm')}</button>
      </div>
    </form>`;
  const typed = dialog.querySelector<HTMLInputElement>('input[name=typed]');
  const button = dialog.querySelector<HTMLButtonElement>('[data-confirm]');
  if (typed && button) {
    typed.addEventListener('input', () => (button.disabled = typed.value.trim() !== o.typeToConfirm));
  }
  return new Promise((resolve) => {
    let answered = false;
    const answer = (yes: boolean): void => {
      if (answered) return;
      answered = true;
      void dismiss(dialog).then(() => resolve(yes));
    };
    dialog.addEventListener('submit', (e) => {
      e.preventDefault();
      const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
      answer(submitter?.value === 'confirm' && !button?.disabled);
    });
    closeOutside(dialog, () => answer(false));
    // Enter in the typed name confirms (a form's Enter would press its first button, Cancel).
    typed?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (button && !button.disabled) answer(true);
    });
    open(dialog);
  });
}

export interface InfoOptions {
  title: string;
  body?: string; // a line under the title
  contentHtml: string; // built markup (escape what it holds)
  wide?: boolean;
  close?: string;
}

// A dialog that shows something (the keyboard shortcuts, U4.03): its content and a Close button,
// which has the focus. Escape, the button or a click outside closes it. `opened` gets the dialog
// once it is shown, for its own listeners; the promise resolves once it is gone.
export function infoDialog(o: InfoOptions, opened?: (dialog: HTMLDialogElement) => void): Promise<void> {
  const id = nextId();
  const dialog = document.createElement('dialog');
  dialog.className = o.wide ? 'dialog wide' : 'dialog';
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  if (o.body) dialog.setAttribute('aria-describedby', `${id}-body`);
  dialog.innerHTML = `
    <form method="dialog" class="dialog-panel">
      <div class="dialog-head">
        <div>
          <h2 id="${id}-title">${esc(o.title)}</h2>
          ${o.body ? `<p id="${id}-body">${esc(o.body)}</p>` : ''}
        </div>
      </div>
      ${o.contentHtml}
      <div class="dialog-foot">
        <button class="btn" value="close" autofocus>${esc(o.close ?? 'Close')}</button>
      </div>
    </form>`;
  return new Promise((resolve) => {
    let closed = false;
    const done = (): void => {
      if (closed) return;
      closed = true;
      void dismiss(dialog).then(resolve);
    };
    dialog.addEventListener('submit', (e) => {
      e.preventDefault();
      done();
    });
    closeOutside(dialog, done);
    open(dialog);
    opened?.(dialog);
  });
}

export interface SheetOptions {
  title: string;
  contentHtml: string; // built markup
  footHtml?: string; // links or buttons under the content
  label?: string; // what the sheet is, said before its title ("Help")
}

// A side sheet (U4.04's help), after shadcn/ui's Sheet: a modal panel from the right, its content
// scrolling, closed with its ✕, Escape, a click beside it, or a link in it followed. `opened` gets the
// dialog once shown; the promise resolves once it is gone.
export function sheet(o: SheetOptions, opened?: (dialog: HTMLDialogElement) => void): Promise<void> {
  const id = nextId();
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog sheet';
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.innerHTML = `
    <div class="sheet-head">
      <div>
        ${o.label ? `<div class="eyebrow">${esc(o.label)}</div>` : ''}
        <h2 id="${id}-title">${esc(o.title)}</h2>
      </div>
      <button class="btn ghost icon sm" type="button" data-sheet-close aria-label="Close">${icon('x', { size: 16 })}</button>
    </div>
    <div class="sheet-body">${o.contentHtml}</div>
    ${o.footHtml ? `<div class="sheet-foot">${o.footHtml}</div>` : ''}`;
  return new Promise((resolve) => {
    let closed = false;
    const done = (): void => {
      if (closed) return;
      closed = true;
      void dismiss(dialog).then(resolve);
    };
    dialog.querySelector('[data-sheet-close]')?.addEventListener('click', done);
    closeOnLink(
      dialog,
      () => closed,
      () => {
        closed = true;
        resolve();
      },
    );
    closeOutside(dialog, done);
    open(dialog);
    opened?.(dialog);
  });
}

export interface PanelOptions {
  title: string;
  body?: string; // a line under the title
  contentHtml: string; // built markup: its own buttons and links
  wide?: boolean;
}

// A dialog whose content does the work (the welcome, U4.06): `opened` gets the dialog and a close()
// to wire its buttons to. Escape and a click outside close it too; a link followed in it closes it at
// once (the page it opens takes the focus). The promise resolves once it is gone.
export function panelDialog(
  o: PanelOptions,
  opened?: (dialog: HTMLDialogElement, close: () => void) => void,
): Promise<void> {
  const id = nextId();
  const dialog = document.createElement('dialog');
  dialog.className = o.wide ? 'dialog wide' : 'dialog';
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  if (o.body) dialog.setAttribute('aria-describedby', `${id}-body`);
  dialog.innerHTML = `
    <div class="dialog-panel">
      <div class="dialog-head">
        <div>
          <h2 id="${id}-title">${esc(o.title)}</h2>
          ${o.body ? `<p id="${id}-body">${esc(o.body)}</p>` : ''}
        </div>
      </div>
      ${o.contentHtml}
    </div>`;
  return new Promise((resolve) => {
    let closed = false;
    const done = (): void => {
      if (closed) return;
      closed = true;
      void dismiss(dialog).then(resolve);
    };
    closeOnLink(
      dialog,
      () => closed,
      () => {
        closed = true;
        resolve();
      },
    );
    closeOutside(dialog, done);
    open(dialog);
    opened?.(dialog, done);
  });
}
