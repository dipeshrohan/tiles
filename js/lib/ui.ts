// Shared page components (U1.04), as HTML strings like the views. Text is escaped here; `*Html`
// options and `action` take markup the caller has built (with esc() on anything interpolated).
import { esc } from './dom.ts';
import { errorDetails } from './errors.ts';
import { VERSION } from './version.ts';
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

// While something loads (U2.04): grey shapes like what is coming, so nothing jumps when it arrives.
// They show after 300 ms (a quick answer doesn't flash them) and shimmer (not with reduced motion);
// the region is aria-busy, and its words are read where they are (a live region made in the same
// render as its text isn't announced).
const WIDTHS = [92, 76, 84, 64, 88, 70];
const bar = (w: number): string => `<span class="skeleton" style="--w:${w}%"></span>`;
// The wait is counted from when loading began, not from each render: a page that re-renders while it
// loads (one phase to the next, a keystroke) doesn't hide its shapes for another 300 ms each time.
let loadingSince = 0;
let lastLoading = -Infinity;
const wait = (): number => {
  const now = typeof performance === 'undefined' ? Date.now() : performance.now();
  if (now - lastLoading > 1000) loadingSince = now; // a new wait after a pause in loading
  lastLoading = now;
  return Math.max(0, Math.round(300 - (now - loadingSince)));
};
// The words are beside the busy shapes (some screen readers hold back what is inside a busy region).
const loading = (label: string, kind: string, shapes: string): string =>
  `<div class="loading loading-${kind}"><span class="sr-only">${esc(label)}</span><div class="loading-shapes" aria-hidden="true" aria-busy="true" style="--wait:${wait()}ms">${shapes}</div></div>`;

export const skeleton = {
  // Lines of text.
  text(lines = 3, label = 'Loading…'): string {
    return loading(
      label,
      'text',
      Array.from({ length: lines }, (_, i) => bar(WIDTHS[i % WIDTHS.length] ?? 80)).join(''),
    );
  },
  // A table: a header and rows of cells.
  table(rows = 5, cols = 4, label = 'Loading…'): string {
    const row = (r: number) =>
      `<div class="skeleton-row${r < 0 ? ' head' : ''}">${Array.from({ length: cols }, (_, c) => bar(r < 0 ? 50 : (WIDTHS[(c + r) % WIDTHS.length] ?? 80))).join('')}</div>`;
    return loading(label, 'table', [row(-1), ...Array.from({ length: rows }, (_, r) => row(r))].join(''));
  },
  // A card's worth: a title and a few lines, and a chart under them when it has one.
  card(label = 'Loading…', o: { chart?: number } = {}): string {
    return loading(
      label,
      'card',
      `<span class="skeleton skeleton-title"></span>${[88, 72, 80].map(bar).join('')}${
        o.chart ? `<span class="skeleton skeleton-chart" style="--h:${o.chart}px"></span>` : ''
      }`,
    );
  },
  // A chart: a box the chart's height.
  chart(label = 'Loading the chart…', height = 240): string {
    return loading(label, 'chart', `<span class="skeleton skeleton-chart" style="--h:${height}px"></span>`);
  },
  // Rows of a list (requests, warnings, documents): a title line and a detail line each.
  list(items = 4, label = 'Loading…'): string {
    return loading(
      label,
      'list',
      Array.from(
        { length: items },
        (_, i) => `<div class="skeleton-item">${bar(WIDTHS[i % WIDTHS.length] ?? 80)}${bar(48)}</div>`,
      ).join(''),
    );
  },
};

// Lines of text loading: skeleton.text with the label first.
export function loadingState(label = 'Loading…', rows = 3): string {
  return skeleton.text(rows, label);
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
  busy?: boolean; // its work is under way: a spinner over the label, the same width, disabled
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
  const content = `${o.icon ? `${icon(o.icon)} ` : ''}${esc(label)}`;
  return `<button${attrs({ class: buttonClass(o, o.busy ? 'busy' : undefined), type: o.type ?? 'button', disabled: o.disabled || o.busy, 'aria-busy': o.busy ? 'true' : undefined, ...o.attrs })}>${
    o.busy
      ? `<span class="btn-label">${content}</span><span class="btn-spinner" aria-hidden="true">${icon('loader-circle')}</span>`
      : content
  }</button>`;
}

// Puts a button already on the page into (or out of) its busy state, as button({ busy }) draws it.
export function setBusy(el: HTMLButtonElement, busy: boolean): void {
  el.disabled = busy;
  el.classList.toggle('busy', busy);
  const label = el.querySelector('.btn-label');
  if (busy) {
    el.setAttribute('aria-busy', 'true');
    if (!label)
      el.innerHTML = `<span class="btn-label">${el.innerHTML}</span><span class="btn-spinner" aria-hidden="true">${icon('loader-circle')}</span>`;
  } else {
    el.removeAttribute('aria-busy');
    if (label) el.innerHTML = label.innerHTML;
  }
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

// A page that needs the site from the Tiles API, which didn't come: what happened, why and what to do
// (U2.09). A connection that failed says to check the API and its address; an API that answered with
// a reason (no sites, no access, signed out) says that reason. Try again reconnects and Sign in signs
// in (both handled in app.ts).
const UNREACHABLE = /can.t reach|failed to fetch|networkerror|not reachable|timed out|load failed/i;
export function apiUnreachable(reason: string | null, o: { signIn?: boolean; size?: 'sm' | 'lg' } = {}): string {
  const why = (reason ?? '').replace(/^Can.t reach the Tiles API\b[^.:]*[.:]?\s*/i, '').trim();
  const unreachable = !reason || UNREACHABLE.test(reason);
  const sentence = why && !/[.!?)]$/.test(why) ? `${why}.` : why;
  const size = o.size ?? 'sm';
  return card(
    errorState({
      title: unreachable ? "Can't reach the Tiles API" : "The site couldn't be loaded",
      body: [
        sentence,
        unreachable ? 'Check that the API is running and its address in Settings is right, then try again.' : '',
      ]
        .filter(Boolean)
        .join(' '),
      retry: 'reconnect',
      compact: true,
      size,
      actionsHtml: `${o.signIn ? button('Sign in', { variant: 'primary', size, attrs: { 'data-app-sign-in': true } }) : ''} ${linkButton('Open Settings', '#/settings', { size })}`,
      details: errorDetails({
        what: reason ?? "Can't reach the Tiles API",
        page: typeof location === 'undefined' ? '' : location.hash || '#/',
        at: failedAt(reason),
        version: VERSION,
      }),
    }),
  );
}

// A time of day as pages show it ("09:05"), for "as of" and "updated" lines.
export const clockTime = (at: number | Date): string =>
  new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// When a failure was first shown: a page drawn again for the same failure (every render) keeps the
// time it happened, so the copied details point support at the right moment.
let lastFailure: { reason: string | null; at: Date } | null = null;
function failedAt(reason: string | null): Date {
  if (lastFailure?.reason !== reason) lastFailure = { reason, at: new Date() };
  return lastFailure.at;
}

// Something failed to load: why, and a button to try again (`retry` is its data attribute).
export function errorState(o: {
  title: string;
  body?: string;
  retry?: string;
  compact?: boolean;
  alert?: boolean; // false for one shown as an example, not a failure
  level?: 2 | 3 | 4;
  actionsHtml?: string; // more ways out, after Try again (built by the caller)
  size?: 'sm' | 'lg'; // its buttons ('lg' on the shopfloor tablet)
  details?: string; // what "Copy details" copies for support (errorDetails); app.ts copies it
}): string {
  const size = o.size ?? 'sm';
  const retry = o.retry ? button('Try again', { size, icon: 'refresh-cw', attrs: { [`data-${o.retry}`]: true } }) : '';
  const copy = o.details
    ? button('Copy details', { size, variant: 'ghost', icon: 'copy', attrs: { 'data-copy-details': o.details } })
    : '';
  return emptyState({
    illustration: 'error',
    compact: o.compact,
    alert: o.alert ?? true,
    level: o.level,
    title: o.title,
    body: o.body,
    action: retry || o.actionsHtml || copy ? [retry, o.actionsHtml, copy].filter(Boolean).join(' ') : undefined,
  });
}
