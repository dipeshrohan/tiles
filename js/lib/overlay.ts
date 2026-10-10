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
  // A press and a release both outside the panel close it: not a drag that ends there, nor the scrollbar.
  const outside = (e: MouseEvent): boolean => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (e) => (pressedOutside = outside(e)));
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
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault(); // Escape: animate out rather than vanish
      answer(false);
    });
    dialog.addEventListener('click', (e) => {
      if (pressedOutside && outside(e)) answer(false); // a click on the backdrop
    });
    // Enter in the typed name confirms (a form's Enter would press its first button, Cancel).
    typed?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (button && !button.disabled) answer(true);
    });
    open(dialog);
  });
}
