// DOM patching that keeps state (U3.03). A page drawn again on the same page doesn't replace its
// elements: the DOM already there is changed to match the new HTML, so what lives on the elements
// survives — focus and the caret, scroll positions, a <details> someone opened or closed, text they
// selected, and what they typed. A field someone typed into keeps it unless the page changes that
// field's own HTML (it was put back, or filled in) or its form was sent with what it holds now
// (sending is done with it: the page's empty field comes back). Elements are matched by
// `id` or `data-key` first (a list row keeps its element when rows are added above it), otherwise by
// position, tag, name and first class (another kind of element is drawn new, not reshaped). No
// dependencies, and nothing here imports: the browser tests load it on its own.

// What each <details> was drawn as, to tell a section someone opened or closed (kept) from one the
// page opens or closes itself (follows the HTML).
let drawn = new WeakMap<HTMLDetailsElement, boolean>();

// Sections new to the page are drawn as they are now; one kept is noted in attributes().
function remember(root: ParentNode): void {
  root.querySelectorAll('details').forEach((d) => drawn.has(d) || drawn.set(d, d.open));
}

// Replaces what `root` holds (a new page: nothing to keep), remembering its sections.
export function replace(root: Element, html: string): void {
  root.innerHTML = html;
  remember(root);
}

// Changes what `root` holds to match `html`, keeping the elements that stay.
// What a page does as rows come and go (U3.04, js/lib/micro.ts): a row with a key new to a list
// that was already there, and one that leaves it. `leave` takes the row and says whether it removes
// it itself (after it has faded); meanwhile it isn't matched again.
export interface MorphHooks {
  enter?: (el: Element) => void;
  leave?: (el: Element) => boolean;
}
let hooks: MorphHooks = {};
const leaving = new WeakSet<Node>();

export function morph(root: Element, html: string, withHooks: MorphHooks = {}): void {
  const template = root.ownerDocument.createElement('template');
  template.innerHTML = html;
  hooks = withHooks;
  try {
    children(root, template.content);
  } finally {
    hooks = {};
  }
  remember(root);
}

// What each field of a form held when it was sent (onSubmit and app.ts note each form sent).
let sentWith = new WeakMap<Element, string>();
export function noteSent(form: HTMLFormElement): void {
  for (const el of form.elements) if (isField(el)) sentWith.set(el, current(el));
}

// Forgets what every section was drawn as (tests).
export function resetMorph(): void {
  drawn = new WeakMap();
  sentWith = new WeakMap();
}

const keyOf = (node: Node): string | null =>
  node instanceof Element ? (node.getAttribute('data-key') ?? (node.id || null)) : null;

const same = (a: Node, b: Node): boolean =>
  a.nodeType === b.nodeType &&
  (!(a instanceof Element) || (b instanceof Element && a.namespaceURI === b.namespaceURI && a.nodeName === b.nodeName));

// The same kind of node, for a match by position: the same tag, and the same name and first class
// (a field group isn't taken for the error summary a script put before it).
const alike = (a: Node, b: Node): boolean =>
  same(a, b) &&
  (!(a instanceof Element) ||
    (b instanceof Element &&
      a.getAttribute('name') === b.getAttribute('name') &&
      a.classList.item(0) === b.classList.item(0)));

function children(parent: Node, next: Node): void {
  const wanted = new Set<string>();
  for (let n = next.firstChild; n; n = n.nextSibling) {
    const k = keyOf(n);
    if (k) wanted.add(k);
  }
  // Old nodes a new node will ask for by key: not taken by position meanwhile.
  const keyed = new Map<string, Node>();
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    const k = keyOf(n);
    if (k && wanted.has(k) && !keyed.has(k) && !leaving.has(n)) keyed.set(k, n);
  }
  const reserved = (n: Node): boolean => {
    const k = keyOf(n);
    return k !== null && keyed.get(k) === n;
  };
  // An old keyed node the new HTML no longer has: passed over (and removed at the end), so the
  // nodes after it stay where they are (moving one would take its focus away).
  const gone = (n: Node): boolean => {
    const k = keyOf(n);
    return leaving.has(n) || (k !== null && !wanted.has(k));
  };
  const skip = (n: Node | null): Node | null => {
    while (n && (reserved(n) || gone(n))) n = n.nextSibling;
    return n;
  };

  const kept = new Set<Node>();
  let cursor: Node | null = parent.firstChild;
  for (let n = next.firstChild; n;) {
    const following = n.nextSibling; // read first: an inserted node leaves `next`
    const k = keyOf(n);
    let match: Node | null = null;
    let added = false;
    while (cursor && gone(cursor)) cursor = cursor.nextSibling;
    if (k && keyed.has(k)) {
      const found = keyed.get(k) ?? null;
      keyed.delete(k);
      if (found && same(found, n)) match = found;
    } else if (k) {
      // A new keyed node goes in here, taking only an unkeyed node in its place.
      if (cursor && keyOf(cursor) === null && same(cursor, n)) match = cursor;
    } else {
      cursor = skip(cursor);
      if (cursor && !alike(cursor, n)) {
        // One node too many here (a page's script added it, or the HTML dropped it): pass over it
        // when the one after is the node wanted. One too few (the HTML added n): n goes in new.
        const ahead = skip(cursor.nextSibling);
        if (ahead && alike(ahead, n)) cursor = ahead;
        else if (following && alike(cursor, following)) added = true;
      }
      if (!added && cursor && alike(cursor, n)) match = cursor; // else drawn new: kept, another kind of element would seem to move
    }
    if (match) {
      if (match !== cursor) parent.insertBefore(match, cursor);
      else cursor = cursor.nextSibling;
      node(match, n);
      kept.add(match);
    } else {
      const fresh = parent.ownerDocument?.importNode(n, true) ?? n.cloneNode(true);
      parent.insertBefore(fresh, cursor);
      kept.add(fresh);
      if (keyOf(fresh) !== null && fresh instanceof Element) hooks.enter?.(fresh);
    }
    n = following;
  }
  // Whatever wasn't matched goes (including a keyed node whose tag changed).
  for (let n = parent.firstChild; n;) {
    const after = n.nextSibling;
    if (kept.has(n) || leaving.has(n)) {
      // kept, or fading out (its hook removes it)
    } else if (keyOf(n) !== null && n instanceof Element && hooks.leave?.(n)) leaving.add(n);
    else parent.removeChild(n);
    n = after;
  }
}

function node(old: Node, next: Node): void {
  if (!(old instanceof Element) || !(next instanceof Element)) {
    if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue;
    return;
  }
  const field = isField(old);
  // Before anything changes: typed into (and not sent since), and what its HTML said.
  const typed = field && current(old) !== drawnAs(old) && sentWith.get(old) !== current(old);
  const was = field ? drawnAs(old) : '';
  attributes(old, next);
  if (!(old instanceof HTMLTextAreaElement)) children(old, next);
  else if (old.defaultValue !== next.textContent) old.defaultValue = next.textContent ?? '';
  if (field && (!typed || drawnAs(old) !== was)) values(old);
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const isField = (el: Element): el is Field =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;

const toggles = (el: Field): el is HTMLInputElement =>
  el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');

// What a field holds now, and what its HTML says it holds.
function current(el: Field): string {
  if (toggles(el)) return String(el.checked);
  if (el instanceof HTMLSelectElement) return [...el.options].map((o) => o.selected).join();
  return el.value;
}
function drawnAs(el: Field): string {
  if (toggles(el)) return String(el.defaultChecked);
  if (el instanceof HTMLSelectElement) {
    const options = [...el.options];
    // Nothing marked selected: a single select shows its first option.
    const none = !el.multiple && !options.some((o) => o.defaultSelected);
    return options.map((o, i) => o.defaultSelected || (none && i === 0)).join();
  }
  return el.type === 'file' ? '' : el.defaultValue; // a file chosen is typed in; sent, it is cleared
}

function attributes(old: Element, next: Element): void {
  // A section someone opened or closed stays so while the page draws it as before; a dialog is
  // opened and closed by script, never by the HTML.
  const was = old instanceof HTMLDetailsElement ? drawn.get(old) : undefined;
  const keepOpen =
    (was !== undefined && was !== (old as HTMLDetailsElement).open && was === next.hasAttribute('open')) ||
    old instanceof HTMLDialogElement;
  for (const { name } of [...old.attributes]) {
    if (keepOpen && name === 'open') continue;
    if (!next.hasAttribute(name)) old.removeAttribute(name);
  }
  for (const { name, value } of [...next.attributes]) {
    if (keepOpen && name === 'open') continue;
    if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  }
  if (old instanceof HTMLDetailsElement) drawn.set(old, next.hasAttribute('open'));
}

// A field shows what its HTML says (as a fresh one would). Setting a value it already has would
// move the caret, so only a different one is set.
function values(el: Field): void {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked !== el.defaultChecked) el.checked = el.defaultChecked;
    } else if (el.value !== drawnAs(el)) el.value = drawnAs(el); // a file input can only be emptied
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.value !== el.defaultValue) el.value = el.defaultValue;
  } else if (el instanceof HTMLSelectElement) {
    for (const o of el.options) if (o.selected !== o.defaultSelected) o.selected = o.defaultSelected;
    if (!el.multiple && ![...el.options].some((o) => o.defaultSelected) && el.options.length && el.selectedIndex !== 0)
      el.selectedIndex = 0;
  }
}
