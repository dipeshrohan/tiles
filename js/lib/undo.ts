// Undo instead of confirm (U2.03): a removal happens at once on screen, with an Undo toast for 8 s.
// - `removeLater`: the change is sent only when the toast goes (it timed out or was dismissed); Undo
//   puts the item back and nothing is sent. For what the API deletes for good (a conversation, a
//   batch table). A page left while a toast still shows can't be relied on to send anything (a token
//   may need refreshing first, and the page may come back from the back/forward cache), so the
//   removals still waiting are saved (`saveWaiting`, on pagehide) and sent by the next load
//   (`takeSaved`), unless the same page comes back (`keepWaiting`, on pageshow from the cache).
// - `removeNow`: the change is sent at once; Undo asks the API to restore it. For what the API only
//   archives (a document, an app).
import type { ToastOptions } from './toaster.ts';
import { ux } from './analytics.ts';

export const UNDO_MS = 8000;
export const SAVED_KEY = 'tiles.waitingRemovals';

type Toast = (message: string, opts?: ToastOptions) => void;

// What a waiting removal is, to send it from another load of the page.
export interface Removal {
  kind: 'conversation' | 'dataset';
  api: string; // the Tiles API it is on
  site: string;
  id: string;
}

const keyOf = (r: Removal): string => `${r.api}|${r.site}|${r.kind}|${r.id}`;
const waiting = new Map<string, Removal>(); // not sent yet: saved if the page is left
const hidden = new Set<string>(); // kept off the screen until sent and fetched again, or undone

// Kept off the screen while its Undo toast shows, and until the list is fetched again after.
export const isRemoving = (r: Removal): boolean => hidden.has(keyOf(r));

export function removeLater(o: {
  toast: Toast;
  message: string; // what happened: "Conversation deleted"
  removal: Removal;
  hide: () => void; // take it off the screen now (draw the page again)
  restore: () => void; // put it back (Undo, or the API refused): draw the page again
  send: () => Promise<unknown>; // the change itself
  sent?: () => Promise<unknown> | void; // after the API took it: fetch what changed
}): void {
  const key = keyOf(o.removal);
  waiting.set(key, o.removal);
  hidden.add(key);
  o.hide();
  let settled = false;
  const send = (): void => {
    if (settled) return;
    settled = true;
    waiting.delete(key); // on its way: not for the next load to send again
    o.send().then(
      // Kept off the screen until what changed is fetched, so it doesn't flash back.
      async () => {
        await o.sent?.();
        hidden.delete(key);
      },
      () => {
        hidden.delete(key);
        o.restore(); // refused: it comes back (the client's toast says why)
      },
    );
  };
  o.toast(o.message, {
    type: 'success',
    duration: UNDO_MS,
    distinct: true,
    action: {
      label: 'Undo',
      run: () => {
        if (settled) return;
        settled = true;
        waiting.delete(key);
        hidden.delete(key);
        ux('task', 'undo');
        o.restore();
      },
    },
    onDone: send,
  });
}

// The page is being left: what still waits for its toast is saved, to be sent by the next load.
export function saveWaiting(storage: Pick<Storage, 'setItem' | 'removeItem'>): void {
  try {
    if (waiting.size) storage.setItem(SAVED_KEY, JSON.stringify([...waiting.values()]));
    else storage.removeItem(SAVED_KEY);
  } catch {
    // no storage (a private window): it is left as it is
  }
}

// The same page came back (the back/forward cache): its toasts carry on, so nothing is saved.
export function keepWaiting(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(SAVED_KEY);
  } catch {
    // no storage
  }
}

// The removals a page left behind for this API, to send now (each once: they are taken out of
// storage; another API's stay for when that one is opened).
export function takeSaved(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, api: string): Removal[] {
  try {
    const raw = storage.getItem(SAVED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    const saved = Array.isArray(list)
      ? list.filter(
          (r): r is Removal =>
            typeof r === 'object' &&
            r !== null &&
            (r.kind === 'conversation' || r.kind === 'dataset') &&
            [r.api, r.site, r.id].every((v) => typeof v === 'string'),
        )
      : [];
    const others = saved.filter((r) => r.api !== api);
    if (others.length) storage.setItem(SAVED_KEY, JSON.stringify(others));
    else storage.removeItem(SAVED_KEY);
    return saved.filter((r) => r.api === api);
  } catch {
    return [];
  }
}

export async function removeNow(o: {
  toast: Toast;
  message: string; // "Archived SOP 14"
  send: () => Promise<unknown>; // archive it (and draw the page again)
  undo: () => Promise<unknown>; // restore it
  restored: () => void; // after Undo worked: draw the page again
  restoredMessage: string; // "Restored SOP 14"
}): Promise<boolean> {
  try {
    await o.send();
  } catch {
    return false; // the client showed why
  }
  o.toast(o.message, {
    type: 'success',
    duration: UNDO_MS,
    distinct: true,
    action: {
      label: 'Undo',
      run: () => {
        ux('task', 'undo');
        void o.undo().then(
          () => {
            o.restored();
            o.toast(o.restoredMessage, { type: 'success' });
          },
          () => undefined, // the client showed why
        );
      },
    },
  });
  return true;
}
