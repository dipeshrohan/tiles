// What's new (U4.08): the changelog's top section in a sheet (made by scripts/help.js into the help
// file), and a dot on the help button for someone who used Tiles before this version and hasn't
// opened it since. A first visit only notes the version: for a new person nothing is new.
import type { WhatsNew } from './help.ts';

export const SEEN_KEY = 'whats-new-seen';

// Whether to mark the help button: a version seen before, and not this one.
export const hasNews = (seen: string | null, version: string): boolean => seen !== null && seen !== version;

// The sheet's title and what it shows.
export function whatsNewTitle(w: WhatsNew): string {
  return `Version ${w.version}${w.date ? `, ${w.date}` : ''}`;
}

export function whatsNewHtml(w: WhatsNew): string {
  const when = w.date ? '' : '<p class="small soft">Not yet released: this is what the next version will bring.</p>';
  return `${when}<div class="prose whats-new">${w.html}</div>`;
}

// The help button's name, saying when something is new.
export const helpLabel = (news: boolean, version: string): string =>
  news ? `Help for this page, and what’s new in ${version}` : 'Help for this page';
