// The notification centre's logic (U5.07), apart from the page: what the bell says, what is new
// since it last asked (to announce), and the inbox drawn as a list. The API works the inbox out
// (api_inbox.py); the app asks at most once a minute.

import { esc, timeAgo } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { button } from './ui.ts';
import type { InboxItem } from './api.ts';

export const INBOX_POLL_MS = 60_000;

export const bellCount = (unread: number): string => (unread > 99 ? '99+' : String(unread));

export const bellLabel = (unread: number): string =>
  unread ? `Notifications, ${unread} unread` : 'Notifications, none unread';

// The unread items not there when it last asked: what to announce. None the first time (what was
// waiting when the page opened is not news).
export function arrivals(before: ReadonlySet<string> | null, items: readonly InboxItem[]): InboxItem[] {
  if (!before) return [];
  return items.filter((i) => !i.read && !before.has(i.key));
}

// What a screen reader is told of new items: politely, once.
export function announcement(news: readonly InboxItem[]): string {
  if (!news.length) return '';
  const [first] = news;
  return news.length === 1 && first ? `New notification: ${first.title}` : `${news.length} new notifications`;
}

const KIND_ICON: Record<InboxItem['kind'], IconName> = {
  warning: 'triangle-alert',
  review: 'git-pull-request',
  insight: 'lightbulb',
  import: 'upload',
};

export function inboxHtml(items: readonly InboxItem[]): string {
  if (!items.length)
    return '<p class="small soft" data-inbox-empty>Nothing waits for you here: warnings assigned to you, reviews asked of you, insights to review and imports that didn’t finish show here.</p>';
  return `<ul class="inbox-list">${items
    .map(
      (i) => `<li class="inbox-item${i.read ? '' : ' unread'}" data-key="inbox-${esc(i.key)}">
        <span class="inbox-ico" aria-hidden="true">${icon(KIND_ICON[i.kind], { size: 16 })}</span>
        <span class="inbox-text">
          <a href="${esc(i.href)}" data-inbox-open="${esc(i.key)}">${i.read ? '' : '<span class="sr-only">Unread: </span>'}${esc(i.title)}</a>
          <span class="small soft">${esc(i.detail)} · ${esc(timeAgo(i.at))}</span>
        </span>
        ${i.read ? '' : button('Mark read', { size: 'sm', variant: 'ghost', attrs: { 'data-inbox-read': i.key, 'aria-label': `Mark read: ${i.title}` } })}
      </li>`,
    )
    .join('')}</ul>`;
}
