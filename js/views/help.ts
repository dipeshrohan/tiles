// Help (U4.04): the user guide in the app, its contents beside it; #/help/<section> opens it at a
// section. Each page's help button (in the top bar) shows that page's section in a side sheet, with
// a link here. The guide is loaded on first use (js/lib/help.ts).
import { esc, onAll, scrollBehavior } from '../lib/dom.ts';
import { helpHref, helpLoaded, loadHelp, type HelpSection } from '../lib/help.ts';
import { errorState, pageHead, skeleton } from '../lib/ui.ts';
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
    });
    const data = helpLoaded();
    if (!data && failed)
      return `${head}${errorState({ title: 'The help could not be loaded', body: `${failed}. The app may be missing js/help-data.js.`, retry: 'help-retry' })}`;
    if (!data) return `${head}<div class="card">${skeleton.text(6, 'Loading the help…')}</div>`;
    const slug = helpSlug(location.hash);
    return `${head}<div class="help-layout">${contentsHtml(data.sections, slug)}<article class="help-article prose">${guideHtml(data.sections)}</article></div>`;
  },
  bind(root, ctx) {
    const loaded = (): void => ctx.rerender();
    const refused = (e: unknown): void => {
      failed = e instanceof Error ? e.message : String(e);
      ctx.rerender();
    };
    onAll(root, '[data-help-retry]', 'click', () => {
      failed = null;
      ctx.rerender();
    });
    if (!helpLoaded() && !failed) loadHelp().then(loaded, refused);
    if (!root.querySelector('.help-article')) return;
    const slug = helpSlug(location.hash);
    // Taken to a section: on arriving with one, or following a link to another; not when drawn again.
    if (!slug || (wasShown && slug === shownSlug)) {
      shownSlug = slug;
      return;
    }
    shownSlug = slug;
    requestAnimationFrame(() => {
      const target = root.querySelector<HTMLElement>(`#help-${CSS.escape(slug)}`);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    });
  },
  crumbs() {
    const slug = helpSlug(location.hash);
    const section = slug ? helpLoaded()?.sections.find((s) => s.slug === slug) : undefined;
    return section ? [{ label: section.title, href: helpHref(section.slug) }] : [];
  },
};

export default view;
