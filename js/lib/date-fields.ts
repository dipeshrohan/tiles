// Date and date-and-time fields with their value written out beside them (review H-18). A browser
// draws an <input type="date"> or "datetime-local" in its own language (11/17/2026, 12:00 PM),
// while Tiles writes dates in the person's language and number format and the site's zone
// (17 Nov 2026, 12:00 CET): the line beside the field says the chosen value Tiles' way, so the
// two can be compared. It updates as the field changes, and describes the field (aria-describedby):
// a plain span, not a live region, so a screen reader reads it with the field, not on every key.

import { bound, esc } from './dom.ts';
import { date, dateTime, fromInput } from './format.ts';
import { field, input } from './ui.ts';

export type DateKind = 'date' | 'datetime-local';

// A field's value as Tiles writes it: "17 Nov 2026" for a day, "17 Nov 2026, 12:00 CET" for a
// time on the site's clock; empty when there is none, or it isn't a whole date.
// A day is read at its noon on the site's clock: its midnight may not exist (a clock change).
export function readsAs(value: string, kind: DateKind): string {
  const at = fromInput(kind === 'date' ? `${value}T12:00` : value);
  return Number.isFinite(at) ? (kind === 'date' ? date : dateTime)(at) : '';
}

// The id of the line that writes out the field named `name` (one per page).
const outputId = (name: string): string => `reads-as-${name}`;

// The line itself, for a page that places it away from the field (the Data explorer's range).
export const readsAsOutput = (name: string, value: string, kind: DateKind): string =>
  `<span class="small soft reads-as" id="${outputId(name)}">${esc(readsAs(value, kind))}</span>`;

// The field's input, tied to its line.
export function datedInput(o: { name: string; kind: DateKind; value: string; required?: boolean }): string {
  return input({
    name: o.name,
    type: o.kind,
    value: o.value,
    attrs: { required: o.required, 'aria-describedby': outputId(o.name), 'data-reads-as': o.name },
  });
}

// A labelled field with its line under it.
export const datedField = (label: string, o: { name: string; kind: DateKind; value: string; required?: boolean }) =>
  `<div class="stack gap-1">${field(label, datedInput(o))}${readsAsOutput(o.name, o.value, o.kind)}</div>`;

// Keeps each line in step with its field as it is typed in or picked: by delegation, so a field
// drawn into the page later (the explorer's compare start) is followed too; and once on binding,
// for a page drawn again that kept a value typed before.
export function bindReadsAs(root: ParentNode & EventTarget): void {
  const show = (el: EventTarget | null) => {
    if (!(el instanceof HTMLInputElement) || !el.dataset.readsAs) return;
    const out = root.querySelector(`#${outputId(el.dataset.readsAs)}`);
    const text = readsAs(el.value, el.type === 'date' ? 'date' : 'datetime-local');
    if (out && out.textContent !== text) out.textContent = text;
  };
  root.querySelectorAll('input[data-reads-as]').forEach(show);
  root.addEventListener('input', (e) => show(e.target), { signal: bound() });
}
