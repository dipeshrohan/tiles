// Each page's help (U4.04): the user guide's section for the page, shown in a side sheet from the top
// bar, the whole guide on the Help page (#/help/<section>), and its headings in the command palette.
// scripts/help.js makes js/help-data.js from docs/guides/user.md at build time; it is a classic script
// loaded the first time help is wanted (so it works from file://, and the app's bundle stays small).
import type { IconName } from './icons.ts';
import type { PaletteItem } from './palette.ts';
import { t } from './i18n.ts';

export interface HelpSection {
  slug: string; // the heading's anchor in the guide, as GitHub makes it
  title: string;
  level: 1 | 2 | 3;
  html: string; // its text up to the next heading, made HTML from the guide (by scripts/help.js)
  text: string; // the start of its words
}

export interface WhatsNew {
  version: string;
  date: string | null; // null while the version is unreleased
  html: string; // the changelog's section, made HTML (by scripts/help.js), entries linked to their pages
}

export interface HelpData {
  sections: readonly HelpSection[];
  pages: Readonly<Record<string, string>>; // page id → the section its help opens at
  whatsNew?: WhatsNew;
}

declare global {
  interface Window {
    tilesHelp?: HelpData;
  }
}

let loading: Promise<HelpData> | null = null;

// The guide, loaded once; a failure (a missing file) can be tried again.
export function loadHelp(src = 'js/help-data.js'): Promise<HelpData> {
  if (window.tilesHelp) return Promise.resolve(window.tilesHelp);
  loading ??= new Promise<HelpData>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    const fail = (message: string): void => {
      loading = null; // tried again next time
      script.remove();
      reject(new Error(message));
    };
    script.onload = () => (window.tilesHelp ? resolve(window.tilesHelp) : fail(t('help.fileEmpty')));
    script.onerror = () => fail(t('help.fileFailed'));
    document.head.append(script);
  });
  return loading;
}

export const helpLoaded = (): HelpData | null => window.tilesHelp ?? null;

export const helpHref = (slug: string): string => `#/help/${encodeURIComponent(slug)}`;

// The section at `slug` and the ones under it (up to the next heading at its level or above).
export function sectionAt(sections: readonly HelpSection[], slug: string): HelpSection[] {
  const start = sections.findIndex((s) => s.slug === slug);
  const first = sections[start];
  if (!first) return [];
  const end = sections.findIndex((s, i) => i > start && s.level <= first.level);
  return sections.slice(start, end < 0 ? undefined : end);
}

// The section a page's help opens at, for a page id; the guide's introduction when the page has none
// (the build fails before that: scripts/help.js).
export function pageSection(data: HelpData, page: string): HelpSection[] {
  const slug = data.pages[page];
  const found = slug ? sectionAt(data.sections, slug) : [];
  const intro = data.sections[0];
  return found.length ? found : intro ? [intro] : [];
}

// The heading a section sits under (a subsection's section).
export function parentOf(sections: readonly HelpSection[], slug: string): HelpSection | undefined {
  const at = sections.findIndex((s) => s.slug === slug);
  const own = sections[at];
  if (!own) return undefined;
  for (let i = at - 1; i >= 0; i--) {
    const s = sections[i];
    if (s && s.level < own.level) return s;
  }
  return undefined;
}

// The part of the guide the page shows for an address: the section (##) it names, or the one a
// subsection (###) it names is in, with its subsections; the introduction without one. And the
// sections before and after it.
export function chapter(
  sections: readonly HelpSection[],
  slug: string | null,
): { shown: HelpSection[]; top: HelpSection | undefined; prev?: HelpSection; next?: HelpSection } {
  const named = slug ? sections.find((s) => s.slug === slug) : undefined;
  const top = named?.level === 3 ? parentOf(sections, named.slug) : (named ?? sections[0]);
  if (!top) return { shown: [], top };
  const shown = top.level === 1 ? [top] : sectionAt(sections, top.slug);
  const chapters = sections.filter((s) => s.level <= 2);
  const at = chapters.indexOf(top);
  return { shown, top, prev: chapters[at - 1], next: chapters[at + 1] };
}

const HELP_ICON: IconName = 'circle-help';

// The guide's headings as palette items: found by their words and their section's.
export function helpItems(data: HelpData, open: (href: string) => void): PaletteItem[] {
  return data.sections
    .filter((s) => s.level > 1)
    .map((s) => {
      const parent = s.level === 3 ? parentOf(data.sections, s.slug)?.title : undefined;
      const href = helpHref(s.slug);
      return {
        id: `help:${s.slug}`,
        label: s.title,
        group: 'Help',
        icon: HELP_ICON,
        hint: parent,
        keywords: parent,
        late: true,
        run: () => open(href),
      };
    });
}
