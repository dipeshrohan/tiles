// Help (U4.04): the user guide in the app, its contents beside it; #/help/<section> opens it at a
// section. Each page's help button (in the top bar) shows that page's section in a side sheet, with
// a link here. The guide is loaded on first use (js/lib/help.ts).
import { esc, goToAnchor, onAll } from '../lib/dom.ts';
import { canRun, TOURS } from '../lib/tours.ts';
import { chapter, helpHref, helpLoaded, loadHelp, type HelpSection } from '../lib/help.ts';
import { button, errorState, linkButton, pageHead, skeleton } from '../lib/ui.ts';
import { savedScroll } from '../lib/url-state.ts';
import type { View } from './types.ts';
import { t } from '../lib/i18n.ts';

// The section an address names: #/help/data-explorer → data-explorer.
export function helpSlug(hash: string): string | null {
  const m = /^#\/help\/([^?/]+)/.exec(hash);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

let failed: string | null = null;
let waiting = false; // the guide is being loaded
let shownSlug: string | null = null; // the section the page was last taken to
let wasShown = false; // the page was drawn before this drawing (a link within it, not an arrival)

const heading = (s: HelpSection, ids: boolean): string => {
  const h = s.level === 3 ? 'h3' : 'h2';
  return `<${h}${ids ? ` id="help-${esc(s.slug)}" tabindex="-1"` : ''}>${esc(s.title)}</${h}>`;
};

// The guide's sections, each with its heading (the introduction has none: the page's is "Help"). In
// the help sheet the headings have no ids: the Help page's would be there twice.
export function guideHtml(sections: readonly HelpSection[], o: { ids?: boolean } = {}): string {
  const ids = o.ids ?? true;
  return sections
    .map(
      (s) =>
        `<section class="help-section" data-key="${esc(s.slug)}">${s.level > 1 ? heading(s, ids) : ''}${s.html}</section>`,
    )
    .join('');
}

// The contents: the sections (##) with their subsections (###) under them, the one open marked.
export function contentsHtml(sections: readonly HelpSection[], current: string | null): string {
  const link = (s: HelpSection): string =>
    `<a href="${esc(helpHref(s.slug))}"${s.slug === current ? ' aria-current="location"' : ''}>${esc(s.title)}</a>`;
  const items: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (!s || s.level !== 2) continue;
    const subs: string[] = [];
    for (let j = i + 1; j < sections.length && (sections[j]?.level ?? 2) > 2; j++) {
      const sub = sections[j];
      if (sub) subs.push(`<li>${link(sub)}</li>`);
    }
    items.push(`<li>${link(s)}${subs.length ? `<ul>${subs.join('')}</ul>` : ''}</li>`);
  }
  return `<nav class="help-toc" aria-label="${esc(t('help.contents'))}"><ul>${items.join('')}</ul></nav>`;
}

// The guided tours (U4.07), on the guide's first page: each with what it shows and a way to start it.
export function toursCard(withApi: boolean): string {
  const rows = TOURS.map((tour) => {
    const can = canRun(tour, withApi);
    const start = button(t('help.tours.start'), {
      size: 'sm',
      disabled: !can,
      attrs: { 'data-start-tour': tour.id, 'aria-label': t('help.tours.startLabel', { title: tour.title }) },
    });
    return `<li class="tour-item" data-key="tour-${esc(tour.id)}"><div><b>${esc(tour.title)}</b><p class="small soft">${esc(tour.summary)}${can ? '' : ` ${esc(t('help.tours.needsApi'))}`}</p></div>${start}</li>`;
  }).join('');
  return `<section class="card mb-4" aria-labelledby="tours-title"><h2 id="tours-title" class="mb-2">${esc(t('help.tours.title'))}</h2><p class="small soft mb-3">${esc(t('help.tours.lead'))}</p><ul class="tour-list">${rows}</ul></section>`;
}

const view: View = {
  id: 'help',
  get title() {
    return t('common.help');
  },
  icon: 'circle-help',
  render(ctx) {
    wasShown = document.querySelector('#view .help-article') !== null;
    const head = pageHead({
      title: t('common.help'),
      lead: t('help.lead'),
      actionsHtml: `<div class="row gap-2 wrap">${button(t('help.whatsNew'), { attrs: { 'data-whats-new': true } })}${ctx.api ? button(t('help.sendFeedback'), { attrs: { 'data-send-feedback': true } }) : ''}${button(t('help.showWelcome'), { attrs: { 'data-show-welcome': true } })}${linkButton(t('help.glossary'), '#/glossary', { icon: 'book-a' })}</div>`,
    });
    const data = helpLoaded();
    if (!data && failed)
      return `${head}${errorState({ title: t('help.failed'), body: t('help.failedBody', { error: failed }), retry: 'help-retry' })}`;
    if (!data) return `${head}<div class="card">${skeleton.text(6, t('help.loading'))}</div>`;
    const slug = helpSlug(location.hash);
    const { shown, top, prev, next } = chapter(data.sections, slug);
    const step = (s: HelpSection | undefined, label: string, cls: string): string =>
      s
        ? `<a class="help-step ${cls}" href="${esc(helpHref(s.slug))}"><span class="small soft">${esc(label)}</span>${esc(s.title)}</a>`
        : '<span></span>';
    const steps = `<nav class="help-steps" aria-label="${esc(t('help.steps'))}">${step(prev, t('help.previous'), 'prev')}${step(next, t('help.next'), 'next')}</nav>`;
    const tours = slug ? '' : toursCard(Boolean(ctx.api));
    return `${head}${tours}<div class="help-layout">${contentsHtml(data.sections, slug ?? top?.slug ?? null)}<article class="help-article prose">${guideHtml(shown)}${steps}</article></div>`;
  },
  bind(root, ctx) {
    // Drawn again only if the Help page is still the one shown.
    const here = (): boolean => /^#\/help(?:[/?]|$)/.test(location.hash);
    const loaded = (): void => {
      waiting = false;
      if (here()) ctx.rerender();
    };
    const refused = (e: unknown): void => {
      waiting = false;
      failed = e instanceof Error ? e.message : String(e);
      if (here()) ctx.rerender();
    };
    // The first-run welcome (U4.06) is the app's: asked for with an event.
    onAll(root, '[data-show-welcome]', 'click', () => document.dispatchEvent(new CustomEvent('tiles:welcome')));
    onAll(root, '[data-whats-new]', 'click', () => document.dispatchEvent(new CustomEvent('tiles:whats-new')));
    onAll(root, '[data-send-feedback]', 'click', () => document.dispatchEvent(new CustomEvent('tiles:feedback')));
    onAll(root, '[data-start-tour]', 'click', (el) =>
      document.dispatchEvent(new CustomEvent('tiles:tour', { detail: el.dataset.startTour })),
    );
    onAll(root, '[data-help-retry]', 'click', () => {
      failed = null;
      ctx.rerender();
    });
    if (!helpLoaded() && !failed && !waiting) {
      waiting = true;
      loadHelp().then(loaded, refused);
    }
    if (!root.querySelector('.help-article')) return;
    const slug = helpSlug(location.hash);
    // Taken to a section: on arriving with one, or following a link to another; not when drawn again,
    // nor when back or forward came here (the place it was scrolled to is put back: U3.05).
    if (!slug || (wasShown && slug === shownSlug) || (!wasShown && savedScroll() > 0)) {
      shownSlug = slug;
      return;
    }
    shownSlug = slug;
    requestAnimationFrame(() => {
      // The contents show where it is too.
      const toc = root.querySelector<HTMLElement>('.help-toc');
      const here = toc?.querySelector<HTMLElement>('[aria-current]');
      if (toc && here) toc.scrollTop = here.offsetTop - toc.clientHeight / 3;
      const target = root.querySelector<HTMLElement>(`#help-${CSS.escape(slug)}`);
      // A section's own heading is at the top already: only a subsection is scrolled to.
      if (target) goToAnchor(target, { scroll: target.tagName === 'H3' });
    });
  },
  crumbs() {
    const slug = helpSlug(location.hash);
    const section = slug ? helpLoaded()?.sections.find((s) => s.slug === slug) : undefined;
    return section ? [{ label: section.title, href: helpHref(section.slug) }] : [];
  },
};

export default view;
