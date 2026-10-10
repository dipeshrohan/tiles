// UX analytics, privacy first (U1.09). Off unless the organisation turned it on (the API says so per
// site). Events are a kind and a name from the app's own vocabulary: a page's id, a task done
// ("warning.acknowledge"), the command palette used, help opened, an error's kind ("api.404"). Never
// a name, an e-mail, a record's id or anything typed: a name that isn't a plain lower-case word is
// dropped here, and the API refuses it too. The session is a random id made per page load and kept
// nowhere; the API stores it hashed. Events go in batches.

export type UxKind = 'page' | 'task' | 'palette' | 'help' | 'error';
export interface UxEvent {
  kind: UxKind;
  name: string;
}

export const UX_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KINDS = new Set<UxKind>(['page', 'task', 'palette', 'help', 'error']);
export const FLUSH_MS = 10_000;
const BATCH = 50; // sent at once when this many wait; the API takes up to 100
const MAX_WAITING = 500; // an API that keeps refusing doesn't make the queue grow for ever

// Any module says something happened; the app's tracker (if any is on) records it.
export function ux(kind: UxKind, name: string): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent<UxEvent>('tiles:ux', { detail: { kind, name } }));
}

// A plain name from a word that may not be one (a palette group, an action's id): lower case,
// anything else a dash; empty if nothing is left.
export const uxName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 64);

export interface Tracker {
  track(kind: UxKind, name: string): void;
  flush(): Promise<void>;
  setEnabled(enabled: boolean): void;
  readonly waiting: number;
}

export function createTracker(o: {
  send: (events: UxEvent[]) => Promise<unknown>;
  schedule?: (run: () => void, ms: number) => unknown; // setInterval, or a test's clock
}): Tracker {
  let enabled = false;
  let queue: UxEvent[] = [];
  let sending = false;

  const flush = async (): Promise<void> => {
    if (!enabled || sending || !queue.length) return;
    const batch = queue.slice(0, BATCH);
    sending = true;
    try {
      await o.send(batch);
      queue = queue.slice(batch.length);
    } catch {
      // kept for the next try (the oldest let go past MAX_WAITING)
    } finally {
      sending = false;
    }
  };
  (o.schedule ?? setInterval)(() => void flush(), FLUSH_MS);

  return {
    track(kind, name) {
      if (!enabled || !KINDS.has(kind) || !UX_NAME.test(name)) return;
      queue.push({ kind, name });
      if (queue.length > MAX_WAITING) queue = queue.slice(-MAX_WAITING);
      if (queue.length >= BATCH) void flush();
    },
    flush,
    setEnabled(on) {
      enabled = on;
      if (!on) queue = [];
    },
    get waiting() {
      return queue.length;
    },
  };
}

// A random session id for this page load (not stored; the API keeps only its hash).
export function newSession(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
