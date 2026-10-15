// In-app feedback on the Settings page (U4.09): the site's admins read what people sent, newest
// first, open a screenshot and delete one (Undo for 8 s, U2.03).
import { bound, esc } from '../lib/dom.ts';
import type { FeedbackRow } from '../lib/api.ts';
import type { Context } from './types.ts';
import { feedbackListHtml } from '../lib/feedback.ts';
import { when } from '../lib/insights.ts';
import { emptyState, loadFailed, skeleton } from '../lib/ui.ts';
import { infoDialog } from '../lib/overlay.ts';
import { isRemoving, removeLater } from '../lib/undo.ts';
import { t } from '../lib/i18n.ts';

export function feedbackCard(): string {
  return `<div class="card stack gap-3 span-all" id="feedback">
      <h2>${esc(t('feedbackAdmin.title'))}</h2>
      <p class="small soft">${esc(t('feedbackAdmin.lead'))}</p>
      <div data-feedback-list data-morph="if-changed" tabindex="-1">${skeleton.list(3, t('feedbackAdmin.loading'))}</div>
    </div>`;
}

// Each list's rows, fetched once: Settings drawn again keeps the list (`data-morph="if-changed"`).
const lists = new WeakMap<HTMLElement, FeedbackRow[]>();

export async function bindFeedback(root: HTMLElement, ctx: Context): Promise<void> {
  const box = root.querySelector<HTMLElement>('[data-feedback-list]');
  const api = ctx.api;
  const site = ctx.ontology.site;
  if (!box || !api || !site) return;
  const removal = (id: number) => ({ kind: 'feedback' as const, api: api.baseUrl, site: site.id, id: String(id) });
  const draw = (): void => {
    const shown = (lists.get(box) ?? []).filter((f) => !isRemoving(removal(f.id)));
    box.innerHTML = shown.length
      ? feedbackListHtml(shown, when)
      : emptyState({
          compact: true,
          level: 3,
          title: t('feedbackAdmin.emptyTitle'),
          body: t('feedbackAdmin.emptyBody'),
        });
  };
  const fetch = async (): Promise<void> => {
    try {
      lists.set(box, await api.feedback.list(site.id));
    } catch {
      if (box.isConnected) box.innerHTML = loadFailed(t('feedbackAdmin.name'));
      return;
    }
    if (box.isConnected) draw();
  };
  box.addEventListener(
    'click',
    (e) => {
      const el = e.target instanceof Element ? e.target : null;
      const view = el?.closest<HTMLButtonElement>('[data-feedback-view]');
      const del = el?.closest<HTMLButtonElement>('[data-feedback-delete]');
      if (view) {
        const id = Number(view.dataset.feedbackView);
        view.disabled = true;
        void api.feedback
          .screenshot(site.id, id)
          .then(async (blob) => {
            const url = URL.createObjectURL(blob);
            try {
              await infoDialog({
                title: t('feedbackAdmin.screenshotTitle'),
                wide: true,
                contentHtml: `<div class="feedback-view"><img src="${esc(url)}" alt="${esc(t('feedbackAdmin.screenshotAlt'))}"></div>`,
              });
            } finally {
              URL.revokeObjectURL(url);
            }
          })
          .catch(() => undefined) // the client said why
          .finally(() => (view.disabled = false));
      } else if (del) {
        const id = Number(del.dataset.feedbackDelete);
        // The focus goes to the next one's Delete (or the list), not lost with the one deleted.
        const next = del.closest('li')?.nextElementSibling?.querySelector<HTMLElement>('[data-feedback-delete]')
          ?.dataset.feedbackDelete;
        removeLater({
          toast: ctx.toast,
          message: t('feedbackAdmin.deleted'),
          removal: removal(id),
          hide: () => {
            draw();
            (box.querySelector<HTMLElement>(`[data-feedback-delete="${next ?? ''}"]`) ?? box).focus();
          },
          restore: draw,
          send: () => api.feedback.remove(site.id, id),
          sent: fetch,
        });
      }
    },
    { signal: bound() }, // added before anything is awaited: this binding's
  );
  if (lists.has(box)) return; // drawn already, and kept
  lists.set(box, []);
  await fetch();
}
