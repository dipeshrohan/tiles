// In-app feedback (U4.09): the form "Send feedback" opens (in the help sheet, the Help page and the
// command palette), what it sends, and the list site admins read in Settings. What is sent besides
// the words and the mood is said on the form: the page's id (never its address, which can hold a
// search), the version and the browser; a screenshot only when attached, after it is shown; a name
// only when chosen. Words follow docs/ui/writing.md.
import { esc } from './dom.ts';
import type { FeedbackIn, FeedbackRow, Mood } from './api.ts';

export const MOODS: readonly { id: Mood; emoji: string; label: string }[] = [
  { id: 'unhappy', emoji: '😞', label: 'Not well' },
  { id: 'neutral', emoji: '😐', label: 'Okay' },
  { id: 'happy', emoji: '🙂', label: 'Well' },
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
    ? `<label class="row gap-2"><input type="checkbox" name="shot" data-feedback-shot> Attach a screenshot of this page</label>
      <div class="feedback-shot" data-feedback-preview hidden></div>`
    : `<p class="small soft">Screenshots can’t be made here: this copy of Tiles was opened from a file.</p>`;
  return `<form class="stack gap-3" data-feedback-form>
      <fieldset class="moods">
        <legend>How is Tiles working for you?</legend>
        <div class="row gap-2 wrap">${moods}</div>
      </fieldset>
      <label class="field">What would you like to tell us?
        <textarea name="text" rows="4" required maxlength="${MAX_TEXT}" aria-describedby="feedback-text-hint"></textarea>
        <span class="small soft" id="feedback-text-hint">What you were doing, what you expected and what happened.</span>
      </label>
      <label class="row gap-2"><input type="checkbox" name="named"> Include my name (${esc(o.name)})</label>
      ${shot}
      <p class="small soft" data-feedback-sent-with>Sent to your site’s admins with the page (${esc(o.page)}), version ${esc(o.version)} and your browser. Without your name it is anonymous.</p>
      <div class="dialog-foot">
        <button class="btn ghost" type="button" data-feedback-cancel>Cancel</button>
        <button class="btn primary" type="submit">Send feedback</button>
      </div>
    </form>`;
}

// The screenshot shown before it is sent, with a way to take it off.
export const previewHtml = (dataUrl: string): string =>
  `<img src="${esc(dataUrl)}" alt="Screenshot of this page, to be sent with your feedback">
  <button class="btn sm ghost" type="button" data-feedback-unshot>Remove the screenshot</button>`;

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
          <span class="row gap-2"><span class="mood-emoji" aria-hidden="true">${m.emoji}</span><strong>${esc(m.label)}</strong><span class="small soft">${esc(f.user ?? 'Anonymous')} · ${esc(f.page)} · ${esc(when(f.created_at))}</span></span>
          <span class="row gap-2">
            ${f.screenshot ? `<button class="btn sm" type="button" data-feedback-view="${f.id}">View screenshot</button>` : ''}
            <button class="btn sm ghost" type="button" data-feedback-delete="${f.id}">Delete</button>
          </span>
        </div>
        <p class="pre-wrap">${esc(f.text)}</p>
        <p class="small soft">Version ${esc(f.version)} · ${esc(f.browser)}</p>
      </li>`;
    })
    .join('')}</ul>`;
}
