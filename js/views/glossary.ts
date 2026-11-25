// Glossary (U4.05): every term of docs/ui/glossary.md by group, with a field to find one;
// #/glossary/<term> opens it at that term. Pages explain a term in place with term() (js/lib/ui.ts).
// The definitions are loaded the first time the page is shown (js/lib/glossary.ts).
import { esc, goToAnchor, onAll } from '../lib/dom.ts';
import { GLOSSARY, type GlossaryKey } from '../lib/glossary-data.ts';
import { keyAttrs } from '../lib/shortcuts.ts';
import { emptyState, errorState, field as labelled, input, pageHead, skeleton } from '../lib/ui.ts';
import { definition, glossaryLoaded, groupOf, loadGlossary } from '../lib/glossary.ts';
import { savedScroll } from '../lib/url-state.ts';
import type { Context, View } from './types.ts';
import { t } from '../lib/i18n.ts';

interface Ui {
  q: string;
}
const ui = (ctx: Context): Ui => ctx.ui<Ui>('glossary', { q: '' });

export interface Entry {
  key: GlossaryKey;
  term: string;
}
export const ENTRIES: readonly Entry[] = (Object.keys(GLOSSARY) as GlossaryKey[]).map((key) => ({
  key,
  ...GLOSSARY[key],
}));

// The terms a search finds, by their name or definition, in their groups (in the glossary's order).
export function findTerms(q: string, entries: readonly Entry[] = ENTRIES): { group: string; entries: Entry[] }[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const has = (s: string): boolean => words.every((w) => s.toLowerCase().includes(w));
  const found = words.length ? entries.filter((e) => has(`${e.term} ${definition(e.key) ?? ''}`)) : [...entries];
  const groups: { group: string; entries: Entry[] }[] = [];
  for (const e of found) {
    const group = groupOf(e.key);
    const g = groups.find((x) => x.group === group) ?? groups[groups.push({ group, entries: [] }) - 1];
    g?.entries.push(e);
  }
  return groups;
}

// The term an address names: #/glossary/cohens-d → cohens-d.
export function termFromHash(hash: string): GlossaryKey | null {
  const m = /^#\/glossary\/([^?/]+)/.exec(hash);
  if (!m?.[1]) return null;
  let key: string;
  try {
    key = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return key in GLOSSARY ? (key as GlossaryKey) : null;
}

let shownKey: GlossaryKey | null = null;
let cleared = false;
let wasShown = false;
let failed = false; // the definitions couldn't be loaded: Try again asks again
let waiting = false; // asked for, not yet here

const view: View = {
  id: 'glossary',
  get title() {
    return t('glossary.title');
  },
  icon: 'book-a',
  under: 'help',
  render(ctx) {
    wasShown = document.querySelector('#view [data-glossary]') !== null;
    // A new visit asks again after a failure (not a redraw: the waiting page is marked).
    if (!wasShown && !document.querySelector('#view [data-glossary-wait]')) failed = false;
    if (!glossaryLoaded()) {
      const head = pageHead({ eyebrow: t('common.help'), title: t('glossary.title'), lead: t('glossary.lead') });
      return `<div data-glossary-wait>${head}${
        failed
          ? errorState({ title: t('glossary.failed'), body: t('glossary.failedBody'), retry: 'glossary-retry' })
          : `<div class="card">${skeleton.text(6, t('glossary.loading'))}</div>`
      }</div>`;
    }
    const u = ui(ctx);
    const current = termFromHash(location.hash);
    // A link to a term shows it, whatever was searched for last (not a search typed here since).
    const arriving = current !== null && (!wasShown || current !== shownKey);
    if (arriving && !findTerms(u.q).some((g) => g.entries.some((e) => e.key === current))) {
      u.q = '';
      cleared = true; // the field keeps what was typed (js/lib/morph.ts): bind empties it
    }
    const { q } = u;
    const head = pageHead({
      eyebrow: t('common.help'),
      title: t('glossary.title'),
      lead: t('glossary.lead'),
    });
    const search = `<div class="row gap-3 wrap mb-4" role="search">${labelled(
      t('glossary.find'),
      input({
        type: 'search',
        name: 'q',
        value: q,
        placeholder: t('glossary.findPlaceholder'),
        attrs: { autocomplete: 'off', ...keyAttrs('/') },
      }),
      { class: 'grow min-w-field' },
    )}</div>`;
    const groups = findTerms(q);
    const list = groups.length
      ? groups
          .map(
            (g) =>
              `<section class="card glossary mb-4" data-key="${esc(g.group)}"><h2 class="mb-3">${esc(g.group)}</h2><dl>${g.entries
                .map(
                  (e) =>
                    `<dt id="term-${esc(e.key)}" tabindex="-1" data-key="${esc(e.key)}"${e.key === current ? ' class="sel"' : ''}>${esc(e.term)}</dt><dd data-key="${esc(e.key)}-text">${esc(definition(e.key) ?? '')}</dd>`,
                )
                .join('')}</dl></section>`,
          )
          .join('')
      : emptyState({ illustration: 'search', title: t('glossary.noneTitle'), body: t('glossary.noneBody') });
    return `<div data-glossary>${head}${search}${list}</div>`;
  },
  bind(root, ctx) {
    if (!glossaryLoaded()) {
      onAll(root, '[data-glossary-retry]', 'click', () => {
        failed = false;
        ctx.rerender();
      });
      // Drawn again once they are here, if this is still the page shown.
      const here = (): boolean => /^#\/glossary(?:[/?]|$)/.test(location.hash);
      if (failed || waiting) return;
      waiting = true;
      loadGlossary().then(
        () => {
          waiting = false;
          if (here()) ctx.rerender();
        },
        () => {
          waiting = false;
          failed = true;
          if (here()) ctx.rerender();
        },
      );
      return;
    }
    if (cleared) {
      cleared = false;
      const field = root.querySelector<HTMLInputElement>('input[name=q]');
      if (field) field.value = '';
    }
    onAll(root, 'input[name=q]', 'input', (el) => {
      ui(ctx).q = (el as HTMLInputElement).value;
      ctx.rerender();
    });
    const key = termFromHash(location.hash);
    // Taken to a term: on arriving with one, or following a link to another; not when drawn again,
    // nor when back or forward came here (its scroll is put back: U3.05).
    if (!key || (wasShown && key === shownKey) || (!wasShown && savedScroll() > 0)) {
      shownKey = key;
      return;
    }
    shownKey = key;
    requestAnimationFrame(() => {
      const dt = root.querySelector<HTMLElement>(`#term-${CSS.escape(key)}`);
      if (dt) goToAnchor(dt);
    });
  },
  crumbs() {
    const key = termFromHash(location.hash);
    return key ? [{ label: GLOSSARY[key].term, href: `#/glossary/${encodeURIComponent(key)}` }] : [];
  },
  query: {
    read(params, ctx) {
      ui(ctx).q = params.get('q') ?? '';
    },
    write(ctx) {
      return { q: ui(ctx).q || null };
    },
  },
};

export default view;
