// Shared page components (U1.04), as HTML strings like the views. Text is escaped here; `*Html`
// options and `action` take markup the caller has built (with esc() on anything interpolated).
import { esc } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { illustration, type IllustrationName } from './illustrations.ts';

export interface EmptyOptions {
  title: string;
  body?: string;
  bodyHtml?: string;
  illustration?: IllustrationName;
  action?: string; // a button or link, e.g. `<a class="btn primary" href="#/settings">…</a>`
  compact?: boolean; // inside a card or a list: a smaller picture
  alert?: boolean; // something failed: read out at once
  level?: 2 | 3 | 4; // its heading's level, under the page's (2)
}

// What a place shows when it has nothing (U2.05): why, and what to do next.
export function emptyState(o: EmptyOptions): string {
  const body = o.bodyHtml ?? (o.body ? esc(o.body) : '');
  return `<div class="empty empty-state${o.compact ? ' compact' : ''}"${o.alert ? ' role="alert"' : ''}>${
    o.illustration ? illustration(o.illustration, o.compact ? 112 : 160) : ''
  }<h${o.level ?? 2} class="empty-title">${esc(o.title)}</h${o.level ?? 2}>${body ? `<p>${body}</p>` : ''}${o.action ? `<div class="empty-action">${o.action}</div>` : ''}</div>`;
}

// A page that needs the Tiles API, in local mode: why, and the way to Settings.
export function needsApi(bodyHtml: string, level?: 2 | 3 | 4): string {
  return emptyState({
    level,
    illustration: 'connect',
    title: 'Connect to the Tiles API',
    bodyHtml,
    action: `<a class="btn primary" href="#/settings">${icon('plug')} Open Settings</a>`,
  });
}

// While something loads (U2.04): grey bars in the shape of what is coming, which shimmer (not with
// reduced motion), and the words for screen readers (read where they are: a live region made in the
// same render as its text isn't announced).
export function loadingState(label = 'Loading…', rows = 3): string {
  const widths = [92, 76, 84, 64, 88, 70];
  return `<div class="empty loading"><span class="sr-only">${esc(label)}</span>${Array.from(
    { length: rows },
    (_, i) => `<span class="skeleton" style="--w:${widths[i % widths.length]}%"></span>`,
  ).join('')}</div>`;
}

// ---- Components (U1.04), after shadcn/ui's: each returns HTML with every text escaped. Options
// named `*Html` (and `action`) take markup the caller built; everything else is text.

export type Attrs = Record<string, string | number | boolean | null | undefined>;
// Attributes beside the ones a component sets itself: its class and type come from its options.
export type ExtraAttrs = Attrs & { class?: never; type?: never };

// ` name="value"` for each attribute, escaped; true is a bare attribute, false or null leaves it out.
export function attrs(a: Attrs = {}): string {
  return Object.entries(a)
    .map(([k, v]) =>
      v === true ? ` ${k}` : v === false || v === null || v === undefined ? '' : ` ${k}="${esc(String(v))}"`,
    )
    .join('');
}

const classes = (...c: (string | false | null | undefined)[]): string => c.filter(Boolean).join(' ');

export interface ButtonOptions {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'destructive';
  size?: 'sm' | 'lg';
  icon?: IconName; // before the label
  type?: 'button' | 'submit';
  disabled?: boolean;
  class?: string;
  attrs?: ExtraAttrs;
}

const buttonClass = (o: ButtonOptions, extra?: string): string => classes('btn', o.size, o.variant, extra, o.class);

export function button(label: string, o: ButtonOptions = {}): string {
  return `<button${attrs({ class: buttonClass(o), type: o.type ?? 'button', disabled: o.disabled, ...o.attrs })}>${
    o.icon ? `${icon(o.icon)} ` : ''
  }${esc(label)}</button>`;
}

// A button with only an icon: named for screen readers, and in a tooltip for the eye.
export function iconButton(name: IconName, label: string, o: Omit<ButtonOptions, 'icon'> = {}): string {
  return `<button${attrs({ class: buttonClass(o, 'icon'), type: o.type ?? 'button', 'aria-label': label, 'data-tooltip': label, disabled: o.disabled, ...o.attrs })}>${icon(name)}</button>`;
}

// A link that looks like a button (it goes somewhere; a button does something).
export function linkButton(label: string, href: string, o: Omit<ButtonOptions, 'type' | 'disabled'> = {}): string {
  return `<a${attrs({ class: buttonClass(o), href, ...o.attrs })}>${o.icon ? `${icon(o.icon)} ` : ''}${esc(label)}</a>`;
}

// The badge colours css/styles.css has ('' is the plain one).
export type Tone = 'good' | 'bad' | 'warn' | 'accent' | 'info' | '';

export function badge(text: string, tone: Tone = '', o: { title?: string; attrs?: ExtraAttrs } = {}): string {
  return `<span${attrs({ class: classes('badge', tone), title: o.title, ...o.attrs })}>${esc(text)}</span>`;
}

// A toggle in a row of filters: aria-pressed says whether it's on.
export function chip(label: string, o: { pressed?: boolean; attrs?: ExtraAttrs } = {}): string {
  return `<button${attrs({ class: 'chip', type: 'button', 'aria-pressed': o.pressed === undefined ? undefined : String(o.pressed), ...o.attrs })}>${esc(label)}</button>`;
}

export function card(bodyHtml: string, o: { class?: string; attrs?: ExtraAttrs } = {}): string {
  return `<div${attrs({ class: classes('card', o.class), ...o.attrs })}>${bodyHtml}</div>`;
}

// Breadcrumbs (U1.06): links to each place above this one, the last (this one) marked current.
export function breadcrumbs(trail: readonly { label: string; href?: string }[]): string {
  const sep = `<span class="crumb-sep" aria-hidden="true">${icon('chevron-right', { size: 14 })}</span>`;
  return `<ol>${trail
    .map((c, i) => {
      const last = i === trail.length - 1;
      const item = last
        ? `<b aria-current="page">${esc(c.label)}</b>`
        : c.href
          ? `<a${attrs({ href: c.href })}>${esc(c.label)}</a>`
          : `<span>${esc(c.label)}</span>`;
      return `<li>${i ? sep : ''}${item}</li>`;
    })
    .join('')}</ol>`;
}

// The top of a page: where it sits, its name, what it is for, and its actions on the right.
export function pageHead(o: {
  eyebrow?: string;
  title: string;
  lead?: string;
  actionsHtml?: string;
  level?: 1 | 4; // 1 on a page; 4 for an example inside one
}): string {
  const h = `h${o.level ?? 1}`;
  return `<div class="page-head"><div>${o.eyebrow ? `<div class="eyebrow">${esc(o.eyebrow)}</div>` : ''}<${h} class="page-title">${esc(o.title)}</${h}>${
    o.lead ? `<p class="soft">${esc(o.lead)}</p>` : ''
  }</div>${o.actionsHtml ?? ''}</div>`;
}

export interface InputOptions {
  name: string;
  type?: 'text' | 'search' | 'number' | 'email' | 'url' | 'file' | 'date' | 'datetime-local';
  value?: string;
  placeholder?: string;
  class?: string;
  attrs?: ExtraAttrs & { name?: never; value?: never };
}

export function input(o: InputOptions): string {
  return `<input${attrs({ type: o.type ?? 'text', name: o.name, value: o.value, placeholder: o.placeholder, class: o.class, ...o.attrs })}>`;
}

// <option>s from [value, label] pairs, the current value selected.
export function options(list: readonly (readonly [string, string])[], current: string): string {
  return list.map(([v, l]) => `<option${attrs({ value: v, selected: v === current })}>${esc(l)}</option>`).join('');
}

export function select(
  name: string | null,
  list: readonly (readonly [string, string])[],
  current: string,
  o: { attrs?: ExtraAttrs & { name?: never }; class?: string } = {},
): string {
  return `<select${attrs({ name, class: o.class, ...o.attrs })}>${options(list, current)}</select>`;
}

// A labelled control: the label wraps it, so it is named; a hint goes below it, and the control (the
// first input, select or textarea in it) is described by it, beside whatever describes it already.
let hints = 0;
export function describedBy(controlHtml: string, id: string): string {
  return controlHtml.replace(/<(input|select|textarea)\b[^>]*>/, (tag) => {
    const has = /\saria-describedby="([^"]*)"/.exec(tag);
    return has
      ? tag.replace(has[0], ` aria-describedby="${has[1] ? `${has[1]} ` : ''}${id}"`)
      : tag.replace(/^<(\w+)/, `<$1 aria-describedby="${id}"`);
  });
}

export function field(
  label: string,
  controlHtml: string,
  o: { class?: string; title?: string; hint?: string; inline?: boolean } = {},
): string {
  const hint = o.hint ? `ui-hint-${++hints}` : null;
  const control = hint ? describedBy(controlHtml, hint) : controlHtml;
  return `<label${attrs({ class: classes(o.inline ? 'row gap-1_5' : 'field', o.class), title: o.title })}>${esc(label)}${o.inline ? ' ' : ''}${control}${
    hint ? `<span class="small soft" id="${hint}">${esc(o.hint ?? '')}</span>` : ''
  }</label>`;
}

// A table in a scrolling frame, its headers named for screen readers (an empty one is `sr-only`).
export function table(o: {
  headers: (string | { label: string; srOnly?: boolean })[];
  rowsHtml: string;
  class?: string;
}): string {
  const th = o.headers
    .map((h) => (typeof h === 'string' ? { label: h, srOnly: false } : h))
    .map((h) => `<th scope="col">${h.srOnly ? `<span class="sr-only">${esc(h.label)}</span>` : esc(h.label)}</th>`)
    .join('');
  return `<div class="table-wrap"><table${attrs({ class: o.class })}><thead><tr>${th}</tr></thead><tbody>${o.rowsHtml}</tbody></table></div>`;
}

// Name and value pairs, each name a row header.
export function kv(rows: readonly (readonly [string, string])[], o: { valueClass?: string } = {}): string {
  return `<div class="table-wrap"><table class="small"><tbody>${rows
    .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td${attrs({ class: o.valueClass })}>${esc(v)}</td></tr>`)
    .join('')}</tbody></table></div>`;
}

// A segmented control: filters of one list, the current one pressed. Toggle buttons, not ARIA tabs:
// there is no panel to switch, and Tab steps through them like any buttons.
export function tabs(o: {
  label: string;
  items: readonly (readonly [string, string])[];
  current: string;
  data: string;
}): string {
  return `<div class="tabs" role="group" aria-label="${esc(o.label)}">${o.items
    .map(
      ([v, l]) =>
        `<button${attrs({ class: classes('tab', v === o.current && 'active'), type: 'button', 'aria-pressed': String(v === o.current), [`data-${o.data}`]: v })}>${esc(l)}</button>`,
    )
    .join('')}</div>`;
}

// The page needs the Tiles API and couldn't reach it: what happened, why, and what to do (Try again
// reconnects, app.ts; Settings has the address).
export function apiUnreachable(reason: string | null): string {
  return card(
    emptyState({
      illustration: 'error',
      compact: true,
      alert: true,
      title: "Can't reach the Tiles API",
      body: `${reason ? `${reason}. ` : ''}Check that it is running and its address in Settings is right, then try again.`,
      action: `${button('Try again', { variant: 'primary', size: 'sm', icon: 'refresh-cw', attrs: { 'data-reconnect': true } })} ${linkButton('Open Settings', '#/settings', { size: 'sm' })}`,
    }),
  );
}

// Something failed to load: why, and a button to try again (`retry` is its data attribute).
export function errorState(o: {
  title: string;
  body?: string;
  retry?: string;
  compact?: boolean;
  alert?: boolean; // false for one shown as an example, not a failure
  level?: 2 | 3 | 4;
}): string {
  return emptyState({
    illustration: 'error',
    compact: o.compact,
    alert: o.alert ?? true,
    level: o.level,
    title: o.title,
    body: o.body,
    action: o.retry
      ? button('Try again', { size: 'sm', icon: 'refresh-cw', attrs: { [`data-${o.retry}`]: true } })
      : undefined,
  });
}
