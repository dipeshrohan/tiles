// In-app feedback (U4.09): the form "Send feedback" opens (in the help sheet, the Help page and the
// command palette), what it sends, and the list site admins read in Settings. What is sent besides
// the words and the mood is said on the form: the page's id (never its address, which can hold a
// search), the version and the browser; a screenshot only when attached, after it is shown; a name
// only when chosen. Words follow docs/ui/writing.md.
import { esc } from './dom.ts';
import type { FeedbackIn, FeedbackRow, Mood } from './api.ts';
import { t, type MessageKey } from './i18n.ts';

// The label is read when shown (the language can change after load).
const moodDef = (id: Mood, emoji: string, label: MessageKey) => ({
  id,
  emoji,
  get label(): string {
    return t(label);
  },
});
export const MOODS: readonly { id: Mood; emoji: string; readonly label: string }[] = [
  moodDef('unhappy', '😞', 'feedback.mood.unhappy'),
  moodDef('neutral', '😐', 'feedback.mood.neutral'),
  moodDef('happy', '🙂', 'feedback.mood.happy'),
];

export const MAX_TEXT = 2000;

export const moodOf = (id: Mood): (typeof MOODS)[number] => MOODS.find((m) => m.id === id) ?? MOODS[1]!;

// A page's id as the API takes it: lower-case letters, digits and hyphens.
export const pageId = (id: string): string =>
  id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64) || 'unknown';

export const browserOf = (userAgent: string): string => userAgent.slice(0, 300);

export interface FormOptions {
  page: string; // the page's title, as the menu names it
  version: string;
  name: string; // whose name "Include my name" gives
  canShoot: boolean; // a screenshot can be made here
}

export function formHtml(o: FormOptions): string {
  const moods = MOODS.map(
    (m) =>
      `<label class="mood"><input type="radio" name="mood" value="${m.id}" required><span class="mood-emoji" aria-hidden="true">${m.emoji}</span><span>${esc(m.label)}</span></label>`,
  ).join('');
  const shot = o.canShoot
    ? `<label class="row gap-2"><input type="checkbox" name="shot" data-feedback-shot> ${esc(t('feedback.attach'))}</label>
      <div class="feedback-shot" data-feedback-preview hidden></div>`
    : `<p class="small soft">${esc(t('feedback.cantShoot'))}</p>`;
  return `<form class="stack gap-3" data-feedback-form>
      <fieldset class="moods">
        <legend>${esc(t('feedback.question'))}</legend>
        <div class="row gap-2 wrap">${moods}</div>
      </fieldset>
      <label class="field">${esc(t('feedback.text'))}
        <textarea name="text" rows="4" required maxlength="${MAX_TEXT}" aria-describedby="feedback-text-hint"></textarea>
        <span class="small soft" id="feedback-text-hint">${esc(t('feedback.textHint'))}</span>
      </label>
      <label class="row gap-2"><input type="checkbox" name="named"> ${esc(t('feedback.includeName', { name: o.name }))}</label>
      ${shot}
      <p class="small soft" data-feedback-sent-with>${esc(t('feedback.sentWith', { page: o.page, version: o.version }))}</p>
      <div class="dialog-foot">
        <button class="btn ghost" type="button" data-feedback-cancel>${esc(t('feedback.cancel'))}</button>
        <button class="btn primary" type="submit">${esc(t('feedback.send'))}</button>
      </div>
    </form>`;
}

// The screenshot shown before it is sent, with a way to take it off.
export const previewHtml = (dataUrl: string): string =>
  `<img src="${esc(dataUrl)}" alt="${esc(t('feedback.previewAlt'))}">
  <button class="btn sm ghost" type="button" data-feedback-unshot>${esc(t('feedback.unshot'))}</button>`;

export function feedbackBody(o: {
  mood: string;
  text: string;
  named: boolean;
  screenshot: string | null;
  page: string;
  version: string;
  userAgent: string;
}): FeedbackIn {
  const mood = MOODS.find((m) => m.id === o.mood)?.id ?? 'neutral';
  return {
    mood,
    text: o.text.trim(),
    page: pageId(o.page),
    version: o.version,
    browser: browserOf(o.userAgent),
    named: o.named,
    screenshot: o.screenshot,
  };
}

// The list in Settings, newest first: each with its mood, words, who (or Anonymous), page and when.
export function feedbackListHtml(rows: readonly FeedbackRow[], when: (iso: string) => string): string {
  return `<ul class="feedback-list stack gap-3">${rows
    .map((f) => {
      const m = moodOf(f.mood);
      return `<li class="feedback-item stack gap-1" data-key="feedback-${f.id}" data-feedback="${f.id}">
        <div class="row gap-2 wrap justify-between">
          <span class="row gap-2"><span class="mood-emoji" aria-hidden="true">${m.emoji}</span><strong>${esc(m.label)}</strong><span class="small soft">${esc(f.user ?? t('feedback.anonymous'))} · ${esc(f.page)} · ${esc(when(f.created_at))}</span></span>
          <span class="row gap-2">
            ${f.screenshot ? `<button class="btn sm" type="button" data-feedback-view="${f.id}">${esc(t('feedback.viewShot'))}</button>` : ''}
            <button class="btn sm ghost" type="button" data-feedback-delete="${f.id}">${esc(t('feedback.delete'))}</button>
          </span>
        </div>
        <p class="pre-wrap">${esc(f.text)}</p>
        <p class="small soft">${esc(t('feedback.version', { version: f.version }))} · ${esc(f.browser)}</p>
      </li>`;
    })
    .join('')}</ul>`;
}
