// Form validation (U2.07): errors under the fields they are about, with aria-invalid and
// aria-describedby, and a summary at the top of the form that links to each. Fields are checked when
// the form is sent (the browser's own constraints: required, pattern, min, max, type), then again as
// each is left, never while it is first being typed. The Tiles API's 422 answers name fields too
// (`loc`, `msg`); they are shown on the form that was sent last. onSubmit (dom.ts) does all of it.

export interface FieldError {
  name: string; // the control's name (or the API's path to it, e.g. "config.limit")
  message: string;
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

// The field names in a 422's `detail`: each `loc` without its leading "body" (or "query"), joined
// by dots. A detail that names no field isn't one.
export function apiFieldErrors(detail: unknown): FieldError[] {
  if (!Array.isArray(detail)) return [];
  return detail.flatMap((d: { loc?: unknown[]; msg?: unknown }) => {
    const path = (Array.isArray(d.loc) ? d.loc : []).filter((p, k) => !(k === 0 && (p === 'body' || p === 'query')));
    if (!path.length || typeof d.msg !== 'string') return [];
    return [{ name: path.map(String).join('.'), message: sentence(d.msg) }];
  });
}

const sentence = (s: string): string => {
  const t = s.trim().replace(/^Value error, /, '');
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
};

// The words a control's label gives it: the label's own text, without the control, its hint or the
// help beside it (elements inside the label), or the aria-label.
export function labelOf(el: Control): string {
  const label = el.labels?.[0];
  let text = el.getAttribute('aria-label') ?? '';
  if (!text && label)
    text = [...label.childNodes]
      .filter((n) => n.nodeType === 3) // text
      .map((n) => n.textContent)
      .join(' ');
  return text.replace(/\s+/g, ' ').trim();
}

// "Enter the unit": the label as a thing to give, lower case unless it starts with an abbreviation
// ("the SMTP host").
const lower = (s: string): string => (/^[A-Z][A-Z]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

// What is wrong with a control, by the browser's own checks, in the writing guide's words: what to
// do, not "invalid". Null when it is fine.
export function problemWith(el: Control): string | null {
  const v = el.validity;
  if (v.valid) return null;
  const label = labelOf(el) ? `the ${lower(labelOf(el))}` : 'a value';
  if (v.valueMissing) {
    if (el instanceof HTMLSelectElement) return `Choose ${label}`;
    if (el instanceof HTMLInputElement && el.type === 'file') return 'Choose a file';
    if (el instanceof HTMLInputElement && el.type === 'checkbox') return 'Tick this to carry on';
    return `Enter ${label}`;
  }
  if (v.badInput) {
    const type = (el as HTMLInputElement).type;
    return type === 'number' || type === 'range' ? 'Enter a number' : `Enter all of ${label}`;
  }
  if (v.typeMismatch) {
    const type = (el as HTMLInputElement).type;
    if (type === 'email') return 'Enter an email address, like name@example.com';
    if (type === 'url') return 'Enter a web address, starting with https://';
  }
  const input = el as HTMLInputElement;
  if (v.patternMismatch) return el.title || `Check the format of ${label}`;
  if (v.rangeUnderflow) return `Enter ${input.min} or more`;
  if (v.rangeOverflow) return `Enter ${input.max} or less`;
  if (v.stepMismatch) return `Enter a multiple of ${input.step}`;
  if (v.tooShort) return `Enter at least ${input.minLength} characters`;
  if (v.tooLong) return `Enter at most ${input.maxLength} characters`;
  return el.validationMessage || `Check ${label}`;
}

// A form's fields; `locked` ones too when an error is to be shown (a form is often drawn disabled
// while what it sent is saved, and the API's answer comes then).
const controls = (form: HTMLFormElement, locked = false): Control[] =>
  [...form.elements].filter(
    (el): el is Control =>
      (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) &&
      (locked || !el.disabled) &&
      el.type !== 'hidden',
  );

// Every control's problem, in the order they appear.
export function validate(form: HTMLFormElement): FieldError[] {
  return controls(form).flatMap((el) => {
    const message = problemWith(el);
    return message ? [{ name: el.name || idFor(el), message }] : [];
  });
}

export const isFieldError = (v: unknown): v is FieldError =>
  typeof v === 'object' && v !== null && typeof (v as Partial<FieldError>).message === 'string' && 'name' in v;

// The control an error names: by its name, the API's name for it (`data-api`, when the form's
// names differ from the API's) or its id, or for an API path ("config.limit", "config.rules.0") by
// its last part that isn't a list index.
function controlFor(form: HTMLFormElement, name: string): Control | null {
  const all = controls(form, true);
  const last =
    name
      .split('.')
      .filter((p) => !/^\d+$/.test(p))
      .pop() ?? name;
  const named = (n: string) => all.find((el) => el.name === n || el.dataset.api === n || el.id === n);
  return named(name) ?? named(last) ?? null;
}

let ids = 0;
const idFor = (el: HTMLElement): string => el.id || (el.id = `field-${++ids}`);

function describe(el: Control, id: string, on: boolean): void {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((x) => x && x !== id);
  if (on) ids.unshift(id);
  if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
  else el.removeAttribute('aria-describedby');
}

// One control's error, shown under it (or cleared, with null). `checked`: from the browser's own
// checks, which leaving the field checks again; any other (the page's own checks, the API's) stays
// until the value is changed or the form sent again.
export function setFieldError(el: Control, message: string | null, checked = false): void {
  const id = `${idFor(el)}-error`;
  const old = el.ownerDocument.getElementById(id);
  if (!message) {
    old?.remove();
    el.removeAttribute('aria-invalid');
    describe(el, id, false);
    return;
  }
  const note = old ?? el.ownerDocument.createElement('span');
  note.id = id;
  note.className = 'field-error';
  note.textContent = message; // its icon is drawn by the stylesheet
  note.dataset.checked = String(checked);
  note.dataset.value = el.value;
  if (!old) el.after(note);
  el.setAttribute('aria-invalid', 'true');
  describe(el, id, true);
}

export function clearErrors(form: HTMLFormElement): void {
  for (const el of controls(form, true)) setFieldError(el, null);
  form.querySelector(':scope > .error-summary')?.remove();
}

// Errors on their fields, and the summary at the top, which takes the focus so it is read out
// (unless `focus` is false: the same errors put back on a form drawn again). Errors naming no control
// here are listed in the summary only. Returns how many found a field.
export function showErrors(
  form: HTMLFormElement,
  errors: FieldError[],
  { focus = true, checked = false }: { focus?: boolean; checked?: boolean } = {},
): number {
  clearErrors(form);
  if (!errors.length) return 0;
  let placed = 0;
  const doc = form.ownerDocument;
  const summary = doc.createElement('div');
  summary.className = 'error-summary';
  summary.setAttribute('role', 'alert');
  summary.tabIndex = -1;
  const title = doc.createElement('p');
  title.className = 'error-summary-title';
  title.textContent = errors.length === 1 ? 'Check this field' : `Check these ${errors.length} fields`;
  const list = doc.createElement('ul');
  for (const e of errors) {
    const li = doc.createElement('li');
    const el = controlFor(form, e.name);
    if (el) {
      placed++;
      setFieldError(el, e.message, checked);
      const a = doc.createElement('a');
      a.href = `#${idFor(el)}`;
      a.dataset.errorFor = el.id;
      a.textContent = e.message;
      li.append(a);
    } else li.textContent = e.message;
    list.append(li);
  }
  summary.append(title, list);
  // A link moves to its field (not the URL: the hash is the app's route).
  summary.addEventListener('click', (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>('a[data-error-for]');
    if (!a) return;
    e.preventDefault();
    form.ownerDocument.getElementById(a.dataset.errorFor ?? '')?.focus();
  });
  if (!focus) summary.removeAttribute('role'); // said already
  form.prepend(summary);
  if (focus) summary.focus();
  return placed;
}

// The form sent last, for the API's field errors, which come back after the handler has run. Pages
// often draw a form again while it is saved and after it fails (locked, then open again), so it is
// also found by its id, and errors shown are put back on a form drawn again soon after.
// A form drawn again is the same one when its id and data attributes (the record it edits, as
// data-signal does) are; another record's form with the same id is not. An answer comes within
// SENT_FOR of the sending, or it isn't to that form (a later action, not from a form, refused).
const SENT_FOR = 30_000;
let lastSent: { form: HTMLFormElement; key: string; at: number } | null = null;
let keeping: { stop: () => void } | null = null;

const keyOf = (form: HTMLFormElement): string =>
  JSON.stringify([form.id, Object.entries(form.dataset).filter(([k]) => k !== 'checked')]);

function sameForm(doc: Document, key: string): HTMLFormElement | null {
  const id = (JSON.parse(key) as [string])[0];
  const again = id ? doc.getElementById(id) : null;
  return again instanceof HTMLFormElement && keyOf(again) === key ? again : null;
}

function sentForm(): HTMLFormElement | null {
  if (!lastSent || Date.now() - lastSent.at > SENT_FOR) return null;
  if (lastSent.form.isConnected) return lastSent.form;
  return sameForm(lastSent.form.ownerDocument, lastSent.key);
}

function keepShown(form: HTMLFormElement, errors: FieldError[]): void {
  keeping?.stop();
  if (!form.id || typeof MutationObserver === 'undefined') return;
  let shownOn = form;
  const doc = form.ownerDocument;
  const key = keyOf(form);
  const observer = new MutationObserver(() => {
    const again = sameForm(doc, key);
    if (again && again !== shownOn && !again.querySelector('.error-summary')) {
      shownOn = again;
      showErrors(again, errors, { focus: false });
    }
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  const timer = setTimeout(() => keeping?.stop(), 5000);
  keeping = {
    stop: () => {
      observer.disconnect();
      clearTimeout(timer);
      keeping = null;
    },
  };
}

// Checks a form as it is sent: false (and the errors shown) when it isn't ready. After its first
// sending, each field is checked again as it is left, and its error cleared once it is put right.
export function checkOnSubmit(form: HTMLFormElement): boolean {
  if (!form.dataset.checked) {
    form.dataset.checked = 'true';
    form.addEventListener('focusout', (e) => {
      // Leaving for one of the form's buttons: it is being sent, and checked then. Changing the
      // errors now would move the button from under the pointer before the click lands.
      if (e.relatedTarget instanceof HTMLButtonElement && e.relatedTarget.form === form) return;
      const el = e.target;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement))
        return;
      const problem = problemWith(el);
      const note = el.id ? el.ownerDocument.getElementById(`${el.id}-error`) : null;
      // The browser's own problem is said again or cleared; another stays until the value changes.
      if (problem) setFieldError(el, problem, true);
      else if (note && (note.dataset.checked === 'true' || note.dataset.value !== el.value)) setFieldError(el, null);
      if (!form.querySelector('[aria-invalid="true"]')) form.querySelector(':scope > .error-summary')?.remove();
    });
  }
  keeping?.stop();
  lastSent = { form, key: keyOf(form), at: Date.now() };
  const errors = validate(form);
  if (errors.length) {
    showErrors(form, errors, { checked: true });
    return false;
  }
  clearErrors(form);
  return true;
}

// The API refused what the last form sent, naming fields: show them there. False when there is no
// such form on the page any more, or none of the fields are in it (the toast says it all then).
export function showApiErrors(errors: FieldError[]): boolean {
  const form = sentForm();
  if (!form || !errors.length) return false;
  if (!errors.some((e) => controlFor(form, e.name))) return false;
  showErrors(form, errors);
  keepShown(form, errors);
  return true;
}
