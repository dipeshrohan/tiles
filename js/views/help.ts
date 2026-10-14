// Help (U4.04): the user guide in the app, its contents beside it; #/help/<section> opens it at a
// section. Each page's help button (in the top bar) shows that page's section in a side sheet, with
// a link here. The guide is loaded on first use (js/lib/help.ts).
import { esc, onAll, scrollBehavior } from '../lib/dom.ts';
import { chapter, helpHref, helpLoaded, loadHelp, type HelpSection } from '../lib/help.ts';
import { errorState, linkButton, pageHead, skeleton } from '../lib/ui.ts';
import { savedScroll } from '../lib/url-state.ts';
import type { View } from './types.ts';

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
  return `<nav class="help-toc" aria-label="Contents of the guide"><ul>${items.join('')}</ul></nav>`;
}

const view: View = {
  id: 'help',
  title: 'Help',
  icon: 'circle-help',
  render() {
    wasShown = document.querySelector('#view .help-article') !== null;
    const head = pageHead({
      title: 'Help',
      lead: 'The user guide: what each page is for and how to use it. Each page’s help button opens its part.',
      actionsHtml: linkButton('Glossary', '#/glossary', { icon: 'book-a' }),
    });
    const data = helpLoaded();
    if (!data && failed)
      return `${head}${errorState({ title: 'The help could not be loaded', body: `${failed}. The app may be missing js/help-data.js.`, retry: 'help-retry' })}`;
    if (!data) return `${head}<div class="card">${skeleton.text(6, 'Loading the help…')}</div>`;
    const slug = helpSlug(location.hash);
    const { shown, top, prev, next } = chapter(data.sections, slug);
    const step = (s: HelpSection | undefined, label: string, cls: string): string =>
      s
        ? `<a class="help-step ${cls}" href="${esc(helpHref(s.slug))}"><span class="small soft">${label}</span>${esc(s.title)}</a>`
        : '<span></span>';
    const steps = `<nav class="help-steps" aria-label="Previous and next">${step(prev, 'Previous', 'prev')}${step(next, 'Next', 'next')}</nav>`;
    return `${head}<div class="help-layout">${contentsHtml(data.sections, slug ?? top?.slug ?? null)}<article class="help-article prose">${guideHtml(shown)}${steps}</article></div>`;
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
      target?.focus({ preventScroll: true });
      // A section's own heading is at the top already: only a subsection is scrolled to. The window
      // scrolls, not an ancestor (scrollIntoView moved the app's clipped shell); the heading's
      // scroll-margin keeps it below the sticky top bar.
      if (!target || target.tagName !== 'H3') return;
      const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
      const top = target.getBoundingClientRect().top + window.scrollY - margin;
      window.scrollTo({ top, behavior: scrollBehavior() });
    });
  },
  crumbs() {
    const slug = helpSlug(location.hash);
    const section = slug ? helpLoaded()?.sections.find((s) => s.slug === slug) : undefined;
    return section ? [{ label: section.title, href: helpHref(section.slug) }] : [];
  },
};

export default view;
