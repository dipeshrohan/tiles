// Shared page components (U1.04), as HTML strings like the views. Text is escaped here; `*Html`
// options and `action` take markup the caller has built (with esc() on anything interpolated).
import { esc } from './dom.ts';
import { icon } from './icons.ts';
import { illustration, type IllustrationName } from './illustrations.ts';

export interface EmptyOptions {
  title: string;
  body?: string;
  bodyHtml?: string;
  illustration?: IllustrationName;
  action?: string; // a button or link, e.g. `<a class="btn primary" href="#/settings">…</a>`
  compact?: boolean; // inside a card or a list: a smaller picture
  alert?: boolean; // something failed: read out at once
}

// What a place shows when it has nothing (U2.05): why, and what to do next.
export function emptyState(o: EmptyOptions): string {
  const body = o.bodyHtml ?? (o.body ? esc(o.body) : '');
  return `<div class="empty empty-state${o.compact ? ' compact' : ''}"${o.alert ? ' role="alert"' : ''}>${
    o.illustration ? illustration(o.illustration, o.compact ? 112 : 160) : ''
  }<h2 class="empty-title">${esc(o.title)}</h2>${body ? `<p>${body}</p>` : ''}${o.action ? `<div class="empty-action">${o.action}</div>` : ''}</div>`;
}

// A page that needs the Tiles API, in local mode: why, and the way to Settings.
export function needsApi(bodyHtml: string): string {
  return emptyState({
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
