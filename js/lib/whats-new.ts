// What's new (U4.08): the changelog's top section in a sheet (made by scripts/help.js into the help
// file), and a dot on the help button for someone who used Tiles before this version and hasn't
// opened it since. A first visit only notes the version: for a new person nothing is new.
import { esc } from './dom.ts';
import type { WhatsNew } from './help.ts';
import { t } from './i18n.ts';

export const SEEN_KEY = 'whats-new-seen';

// Version numbers in order: 0.2.0 before 0.10.0; a part that isn't a number counts as 0.
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// Whether to mark the help button: a version seen before, and this one newer (not a rollback).
export const hasNews = (seen: string | null, version: string): boolean =>
  seen !== null && compareVersions(version, seen) > 0;

// The version to note as seen when nothing is: this one for a first visit, none (so the dot shows) for
// someone who used Tiles before it had What's new (they have other things kept in this browser).
export const seenOnFirstLoad = (otherKeys: readonly string[], version: string): string =>
  otherKeys.length ? '0.0.0' : version;

// The sheet's title and what it shows.
export function whatsNewTitle(w: WhatsNew): string {
  return w.date
    ? t('whatsNew.titleDated', { version: w.version, date: w.date })
    : t('whatsNew.title', { version: w.version });
}

export function whatsNewHtml(w: WhatsNew): string {
  const when = w.date ? '' : `<p class="small soft">${esc(t('whatsNew.unreleased'))}</p>`;
  return `${when}<div class="prose whats-new">${w.html}</div>`;
}

// The help button's name, saying when something is new.
export const helpLabel = (news: boolean, version: string): string =>
  news ? t('whatsNew.helpNews', { version }) : t('whatsNew.help');
