// Undo instead of confirm (U2.03): a removal happens at once on screen, with an Undo toast for 8 s.
// - `removeLater`: the change is sent only when the toast goes (it timed out or was dismissed);
//   Undo puts the item back and nothing is sent. For what the API deletes for good (a conversation,
//   a batch table). Changes still waiting are sent when the page is left (`sendWaiting`).
// - `removeNow`: the change is sent at once; Undo asks the API to restore it. For what the API only
//   archives (a document, an app).
import type { ToastOptions } from './toaster.ts';

export const UNDO_MS = 8000;

type Toast = (message: string, opts?: ToastOptions) => void;

const waiting = new Set<() => void>();

export function removeLater(o: {
  toast: Toast;
  message: string; // what happened: "Conversation deleted"
  hide: () => void; // take it off the screen now
  restore: () => void; // put it back (Undo, or the API refused)
  send: () => Promise<unknown>; // the change itself
}): void {
  o.hide();
  let settled = false;
  const send = (): void => {
    if (settled) return;
    settled = true;
    waiting.delete(send);
    // Refused: it comes back (the client's toast says why).
    o.send().catch(() => o.restore());
  };
  waiting.add(send);
  o.toast(o.message, {
    type: 'success',
    duration: UNDO_MS,
    action: {
      label: 'Undo',
      run: () => {
        if (settled) return;
        settled = true;
        waiting.delete(send);
        o.restore();
      },
    },
    onDone: send,
  });
}

// Sends every change still waiting for its toast to go: the page is being left.
export function sendWaiting(): void {
  for (const send of [...waiting]) send();
}

export async function removeNow(o: {
  toast: Toast;
  message: string; // "Document archived"
  send: () => Promise<unknown>; // archive it (the caller has the view drawn again after)
  undo: () => Promise<unknown>; // restore it
  restored: () => void; // after Undo worked: draw the view again
  restoredMessage: string; // "Document restored"
}): Promise<boolean> {
  try {
    await o.send();
  } catch {
    return false; // the client showed why
  }
  o.toast(o.message, {
    type: 'success',
    duration: UNDO_MS,
    action: {
      label: 'Undo',
      run: () =>
        void o.undo().then(
          () => {
            o.restored();
            o.toast(o.restoredMessage, { type: 'success' });
          },
          () => undefined, // the client showed why
        ),
    },
  });
  return true;
}
