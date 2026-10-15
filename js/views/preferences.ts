// Your preferences (U6.06): a person's own settings for the app (theme, table rows, motion,
// language, how numbers and dates are written, which clock times are in, keyboard shortcuts and the
// page Tiles opens at). Each applies as it is changed; app.ts keeps them in this browser and, with
// the Tiles API, with the person on every site and browser (js/lib/preferences.ts).

import { bound, esc } from '../lib/dom.ts';
import { deviceZone, formatSample } from '../lib/format.ts';
import { t } from '../lib/i18n.ts';
import { LANGUAGES, browserLanguage } from '../lib/language.ts';
import { NUMBER_FORMATS, type Preferences } from '../lib/preferences.ts';
import { card, field, linkButton, pageHead, select } from '../lib/ui.ts';
import type { View } from './types.ts';

const languageName = (code: string): string => LANGUAGES.find((l) => l.code === code)?.name ?? code;

const view: View = {
  id: 'preferences',
  get title() {
    return t('preferences.title');
  },
  icon: 'sliders-horizontal',
  render(ctx) {
    const p = ctx.preferences.current;
    const site = ctx.preferences.siteZone;
    const kept = ctx.preferences.kept === 'account' ? t('preferences.keptAccount') : t('preferences.keptBrowser');
    const languages = select(
      'language',
      [
        ['auto', t('preferences.language.auto', { language: languageName(browserLanguage()) })],
        ...LANGUAGES.map((l): [string, string, string] => [l.code, l.name, l.code]),
      ],
      p.language,
    );
    const numbers: [string, string][] = [
      ['auto', t('preferences.numbers.auto')],
      ...NUMBER_FORMATS.map((code): [string, string] => {
        const { name, sample } = formatSample(code);
        return [code, `${name}: ${sample}`];
      }),
    ];
    const zones: [string, string][] = [
      ['site', site ? t('preferences.zone.site', { zone: site }) : t('preferences.zone.siteNone')],
      ['device', t('preferences.zone.device', { zone: deviceZone() })],
    ];
    const pages: [string, string][] = [
      ['', t('preferences.start.home')],
      ...ctx.preferences.pages.filter((v) => v.id !== 'home').map((v): [string, string] => [v.id, v.title]),
    ];
    return `
      ${pageHead({ eyebrow: t('preferences.eyebrow'), title: t('preferences.title'), lead: t('preferences.lead') })}
      <p class="small soft mb-4" data-kept>${esc(kept)}</p>
      <form class="prefs-grid" id="preferences" novalidate>
        ${card(
          `<h2>${esc(t('preferences.look.title'))}</h2>
          ${field(
            t('preferences.theme.label'),
            select(
              'theme',
              [
                ['system', t('preferences.theme.system')],
                ['light', t('preferences.theme.light')],
                ['dark', t('preferences.theme.dark')],
              ],
              p.theme,
            ),
          )}
          ${field(
            t('preferences.density.label'),
            select(
              'density',
              [
                ['comfortable', t('preferences.density.comfortable')],
                ['compact', t('preferences.density.compact')],
              ],
              p.density,
            ),
            { hint: t('preferences.density.hint') },
          )}
          ${field(
            t('preferences.motion.label'),
            select(
              'motion',
              [
                ['system', t('preferences.motion.system')],
                ['reduce', t('preferences.motion.reduce')],
              ],
              p.motion,
            ),
          )}`,
          { class: 'stack gap-3' },
        )}
        ${card(
          `<h2>${esc(t('preferences.region.title'))}</h2>
          ${field(t('preferences.language.label'), languages, { hint: t('preferences.language.hint') })}
          ${field(t('preferences.numbers.label'), select('numbers', numbers, p.numbers))}
          ${field(t('preferences.zone.label'), select('timeZone', zones, p.timeZone), { hint: ctx.api ? '' : t('preferences.zone.hintLocal') })}`,
          { class: 'stack gap-3' },
        )}
        ${card(
          `<h2>${esc(t('preferences.work.title'))}</h2>
          ${field(t('preferences.start.label'), select('start', pages, p.start ?? ''), { hint: t('preferences.start.hint') })}
          <label class="row gap-2"><input type="checkbox" name="shortcuts"${p.shortcuts ? ' checked' : ''} /> ${esc(t('preferences.shortcuts.label'))}</label>
          <p class="small soft">${esc(t('preferences.shortcuts.hint'))}</p>
          ${
            ctx.api
              ? `<p class="small soft">${esc(t('preferences.home.hint'))}</p><div>${linkButton(t('preferences.home.open'), '#/', { icon: 'house', size: 'sm' })}</div>`
              : ''
          }`,
          { class: 'stack gap-3' },
        )}
      </form>`;
  },
  bind(root, ctx) {
    // Each applies as it is changed: no Save.
    root.querySelector('#preferences')?.addEventListener(
      'change',
      (e) => {
        const el = e.target;
        if (!(el instanceof HTMLSelectElement || el instanceof HTMLInputElement)) return;
        const value = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
        const patch: Partial<Preferences> = { [el.name]: el.name === 'start' ? value || null : value };
        ctx.preferences.set(patch);
      },
      { signal: bound() },
    );
  },
};

export default view;
