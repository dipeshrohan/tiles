// Date and date-and-time fields with their value written out beside them (review H-18). A browser
// draws an <input type="date"> or "datetime-local" in its own language (11/17/2026, 12:00 PM),
// while Tiles writes dates in the person's language and number format and the site's zone
// (17 Nov 2026, 12:00 CET): the line beside the field says the chosen value Tiles' way, so the
// two can be compared. It updates as the field changes, and names the field (aria-describedby).

import { bound, esc } from './dom.ts';
import { date, dateTime, fromInput } from './format.ts';
import { field, input } from './ui.ts';

export type DateKind = 'date' | 'datetime-local';

// A field's value as Tiles writes it: "17 Nov 2026" for a day, "17 Nov 2026, 12:00 CET" for a
// time on the site's clock; empty when there is none, or it isn't a whole date.
export function readsAs(value: string, kind: DateKind): string {
  const at = fromInput(kind === 'date' ? `${value}T00:00` : value);
  return Number.isFinite(at) ? (kind === 'date' ? date : dateTime)(at) : '';
}

// The id of the line that writes out the field named `name` (one per page).
const outputId = (name: string): string => `reads-as-${name}`;

// The line itself, for a page that places it away from the field (the Data explorer's range).
export const readsAsOutput = (name: string, value: string, kind: DateKind): string =>
  `<output class="small soft" id="${outputId(name)}">${esc(readsAs(value, kind))}</output>`;

// The field's input, tied to its line.
export function datedInput(o: { name: string; kind: DateKind; value: string; required?: boolean }): string {
  return input({
    name: o.name,
    type: o.kind,
    value: o.value,
    attrs: { required: o.required ?? false, 'aria-describedby': outputId(o.name), 'data-reads-as': o.name },
  });
}

// A labelled field with its line under it.
export const datedField = (label: string, o: { name: string; kind: DateKind; value: string; required?: boolean }) =>
  `<div class="stack gap-1">${field(label, datedInput(o))}${readsAsOutput(o.name, o.value, o.kind)}</div>`;

// Keeps each line in step with its field as it is typed in or picked (and after a page drawn
// again kept a value typed before).
export function bindReadsAs(root: ParentNode): void {
  root.querySelectorAll<HTMLInputElement>('input[data-reads-as]').forEach((el) => {
    const show = () => {
      const out = root.querySelector(`#${outputId(el.dataset.readsAs ?? '')}`);
      if (out) out.textContent = readsAs(el.value, el.type === 'date' ? 'date' : 'datetime-local');
    };
    show();
    el.addEventListener('input', show, { signal: bound() });
  });
}
