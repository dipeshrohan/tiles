import { ux } from '../lib/analytics.ts';
import { esc, field, fmt, need, onAction, onAll, onNavigate, onSubmit, routeOf, bound, setBusy } from '../lib/dom.ts';
import type { DocumentMatch, SiteDocument } from '../lib/api.ts';
import {
  contentTypeOf,
  languages,
  MAX_UPLOAD_BYTES,
  pageFragment,
  sizeText,
  snippetHtml,
  titleFrom,
} from '../lib/documents.ts';
import type { Context, View } from './types.ts';
import { bindFilterBar, filterBar, type BarOptions } from '../lib/filter-bar.ts';
import { listKeys, recordFromHash, rowClicks, split } from '../lib/split.ts';
import { showHash } from '../lib/url-state.ts';
import { when } from '../lib/insights.ts';
import { removeNow } from '../lib/undo.ts';
import {
  button,
  card,
  emptyState,
  errorState,
  field as labelled,
  input,
  kv,
  needsApi,
  pageHead,
  select,
  skeleton,
  apiUnreachable,
} from '../lib/ui.ts';
import { keyAttrs } from '../lib/shortcuts.ts';
import { bindTable, dataTable, type TableOptions } from '../lib/data-table.ts';
import { t, tHtml } from '../lib/i18n.ts';

// Documents (T4.08): the site's SOPs, manuals and lessons learned, searched by their words, each
// match with its document and page; the copilot searches them too. Engineers upload and archive.

interface Ui {
  query: string;
}

const uiState = (ctx: Context) => ctx.ui<Ui>('documents', { query: '' });

let listing: { key: string; items: SiteDocument[] | null; failed?: boolean } | null = null;
let found: { key: string; matches: DocumentMatch[] | null; failed?: boolean } | null = null;
let uploading = false;
// What is chosen in the upload form, kept across re-renders (a list arriving re-draws the page).
let draft: { site: string; file: File | null; title: string; language: string } | null = null;

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;
const canEdit = (ctx: Context): boolean => ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';
const searchKey = (ctx: Context): string => `${siteId(ctx)}|${uiState(ctx).query}`;
// The document open is the one the address names, #/documents/<number> (U3.08); #/documents is
// the list alone.
const docLink = (n: number | null): string => (n === null ? '#/documents' : `#/documents/${n}`);
const opened = (): number | null =>
  typeof location === 'undefined' ? null : recordFromHash('documents', location.hash);
const openDoc = (): SiteDocument | null => listing?.items?.find((d) => d.number === opened()) ?? null;

// Others upload while you are elsewhere: each visit fetches afresh.
onNavigate((h) => {
  if (routeOf(h) !== 'documents') {
    listing = null;
    found = null;
  }
});

async function loadList(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const key = site;
  listing = { key, items: null };
  try {
    const items = await ctx.api.documents.list(site);
    if (listing?.key === key) listing.items = items;
  } catch {
    if (listing?.key === key) listing.failed = true;
  }
  ctx.rerender();
}

async function search(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  const q = uiState(ctx).query.trim();
  if (!ctx.api || !site || !q) return;
  const key = searchKey(ctx);
  found = { key, matches: null };
  try {
    const matches = (await ctx.api.documents.search(site, q)).matches;
    if (found?.key === key) found = { key, matches };
  } catch {
    // A failed search is not "nothing matches": say so, and offer to try again.
    if (found?.key === key) found = { key, matches: [], failed: true };
  }
  ctx.rerender();
}

async function open(ctx: Context, n: number, page: number): Promise<void> {
  const site = siteId(ctx);
  const doc = listing?.items?.find((d) => d.number === n);
  if (!ctx.api || !site) return;
  // Opened now, filled when the file arrives: a window opened later would be blocked.
  const win = window.open('', '_blank');
  try {
    const blob = await ctx.api.documents.file(site, n);
    const url = URL.createObjectURL(blob);
    const target = url + pageFragment(doc?.content_type ?? blob.type, page);
    if (win) win.location.href = target;
    else location.assign(target);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    win?.close();
  }
}

// The document open beside the list: what it is, opening it, and where the search found it.
function recordCard(ctx: Context): string {
  const n = opened();
  if (n === null)
    return card(
      emptyState({
        illustration: 'documents',
        compact: true,
        title: t('documents.choose'),
        body: t('documents.chooseBody'),
      }),
    );
  if (listing?.failed)
    return card(
      errorState({
        title: t('documents.docFailed'),
        body: t('documents.docFailedBody'),
        retry: 'retry-docs',
        compact: true,
      }),
    );
  const items = listing?.key === siteId(ctx) ? listing.items : null;
  if (items === null) return card(skeleton.card(t('documents.loadingDoc')));
  const d = items.find((x) => x.number === n);
  if (!d)
    return card(
      emptyState({
        illustration: 'search',
        compact: true,
        title: t('documents.missing', { n }),
        bodyHtml: tHtml('documents.missingBody', {
          link: `<a href="${docLink(null)}">${esc(t('documents.seeAll'))}</a>`,
        }),
      }),
    );
  const language = languages().find(([v]) => v === d.language)?.[1] ?? d.language;
  const matches = (found?.key === searchKey(ctx) ? (found.matches ?? []) : []).filter((m) => m.document === n);
  const inSearch = matches.length
    ? `<h3>${esc(t('documents.foundBy', { query: uiState(ctx).query.trim() }))}</h3><ol class="stack doc-matches gap-2_5">${matches
        .map(
          (m) =>
            `<li class="doc-match"><div class="row gap-2 justify-between wrap"><b>${esc(t('documents.page', { n: m.page }))}</b>${button(t('documents.openPage', { n: m.page }), { size: 'sm', attrs: { 'data-open': m.document, 'data-page': m.page } })}</div><p class="small">${snippetHtml(m.snippet)}</p></li>`,
        )
        .join('')}</ol>`
    : '';
  return card(
    `<div class="row gap-2 justify-between wrap"><h2>${esc(d.title)}</h2><span class="row gap-1">${button(t('documents.open'), { size: 'sm', variant: 'primary', attrs: { 'data-open': d.number, 'data-page': 1 } })}${
      canEdit(ctx)
        ? button(t('documents.archive'), {
            size: 'sm',
            variant: 'danger',
            attrs: { 'data-archive-doc': d.number, 'aria-label': t('documents.archiveNamed', { title: d.title }) },
          })
        : ''
    }</span></div>
    ${kv([
      [t('documents.field.file'), d.filename],
      [t('documents.field.pages'), String(d.pages)],
      [t('documents.field.size'), sizeText(d.size)],
      [t('documents.field.language'), language],
      [t('documents.field.uploadedBy'), d.uploaded_by],
      [t('documents.field.uploaded'), when(d.created_at)],
      ['SHA-256', `${d.sha256.slice(0, 12)}…`],
    ])}
    ${inSearch}`,
    { class: 'stack gap-3', attrs: { 'data-doc-record': d.number } },
  );
}

// The filter bar and saved views (U5.06): the search as a chip, with how many matched or are listed.
function barOptions(ctx: Context): BarOptions {
  const ui = uiState(ctx);
  return {
    page: 'documents',
    filters: () => ({ q: ui.query }),
    count: () => {
      const n = (k: number, key: 'documents.count.matches' | 'documents.count.documents') =>
        t(key, { count: k, n: fmt(k) });
      if (ui.query.trim()) {
        const matches = found?.key === searchKey(ctx) ? found.matches : null;
        return matches ? n(matches.length, 'documents.count.matches') : '';
      }
      const docs = listing?.key === siteId(ctx) ? listing.items : null;
      return docs ? n(docs.length, 'documents.count.documents') : '';
    },
    apply: (f) => {
      ui.query = (f.q ?? '').trim();
      found = null;
      ctx.rerender();
    },
  };
}

function searchCard(ctx: Context): string {
  const ui = uiState(ctx);
  const results = found?.key === searchKey(ctx) ? found.matches : undefined;
  let body = '';
  if (found?.key === searchKey(ctx) && found.failed)
    body = `<p class="small" role="alert">${esc(t('documents.searchFailed'))} ${button(t('documents.tryAgain'), { size: 'sm', attrs: { 'data-retry-search': true } })}</p>`;
  else if (ui.query.trim() && results === null) body = `<p class="small soft">${esc(t('documents.searching'))}</p>`;
  else if (results && !results.length)
    body = `<div data-no-matches>${emptyState({
      illustration: 'search',
      compact: true,
      level: 3,
      title: t('documents.noMatches', { query: ui.query.trim() }),
      body: t('documents.noMatchesBody'),
    })}</div>`;
  else if (results)
    body = `<ol class="stack doc-matches gap-2_5" data-matches>${results
      .map(
        (m) => `<li class="doc-match">
          <div class="row gap-2 justify-between wrap">
            <b>${esc(m.title)}</b>
            ${button(t('documents.openPage', { n: m.page }), { size: 'sm', attrs: { 'data-open': m.document, 'data-page': m.page } })}
          </div>
          <p class="small">${snippetHtml(m.snippet)}</p>
        </li>`,
      )
      .join('')}</ol>`;
  return card(
    `<form class="row gap-2 wrap" id="doc-search" role="search">
        ${labelled(t('documents.searchLabel'), input({ type: 'search', name: 'q', value: ui.query, placeholder: t('documents.searchPlaceholder'), attrs: keyAttrs('/') }), { class: 'grow min-w-field' })}
        <div class="self-end">${button(t('documents.search'), { variant: 'primary', type: 'submit' })}</div>
      </form>
      <p class="small soft">${esc(t('documents.searchHint'))}</p>
      ${filterBar(ctx, barOptions(ctx))}
      <div aria-live="polite">${body}</div>`,
    { class: 'stack gap-3' },
  );
}

// The documents as a table (U5.02): each title opens the document beside the list; Open shows its
// first page, Archive takes it off the list (Undo brings it back).
function listTable(ctx: Context, items: SiteDocument[]): TableOptions<SiteDocument> {
  const n = opened();
  return {
    id: 'documents',
    label: t('documents.title'),
    columns: [
      {
        key: 'title',
        label: t('documents.col.title'),
        value: (d) => d.title,
        csv: (d) => d.title,
        cell: (d) =>
          `<a class="row-open doc-link" href="${docLink(d.number)}"${n === d.number ? ' aria-current="true"' : ''}>${esc(d.title)}</a>`,
      },
      {
        key: 'pages',
        label: t('documents.field.pages'),
        numeric: true,
        value: (d) => d.pages,
        cell: (d) => String(d.pages),
      },
      {
        key: 'size',
        label: t('documents.field.size'),
        numeric: true,
        value: (d) => d.size,
        csv: (d) => String(d.size),
        cell: (d) => esc(sizeText(d.size)),
      },
      {
        key: 'by',
        label: t('documents.field.uploadedBy'),
        value: (d) => d.uploaded_by,
        cell: (d) => esc(d.uploaded_by),
      },
      {
        key: 'at',
        label: t('documents.field.uploaded'),
        value: (d) => d.created_at,
        csv: (d) => d.created_at,
        cell: (d) => esc(when(d.created_at)),
      },
      {
        key: 'actions',
        label: t('documents.col.actions'),
        srOnly: true,
        fixed: true,
        cell: (d) =>
          `<span class="row gap-1">${button(t('documents.open'), { size: 'sm', attrs: { 'data-open': d.number, 'data-page': 1 } })}${
            canEdit(ctx)
              ? button(t('documents.archive'), {
                  size: 'sm',
                  variant: 'danger',
                  attrs: {
                    'data-archive-doc': d.number,
                    'aria-label': t('documents.archiveNamed', { title: d.title }),
                  },
                })
              : ''
          }</span>`,
      },
    ],
    rows: items,
    key: (d) => String(d.number),
    empty: '',
    rowAttrs: (d) => ({ 'data-doc': d.number, class: n === d.number ? 'sel' : undefined }),
    csv: 'documents.csv',
  };
}

function listCard(ctx: Context): string {
  const items = listing?.key === siteId(ctx) ? listing.items : null;
  const rows = listing?.failed
    ? errorState({
        title: t('documents.listFailed'),
        body: t('documents.listFailedBody'),
        retry: 'retry-docs',
        compact: true,
      })
    : items === null
      ? skeleton.list()
      : items.length
        ? dataTable(listTable(ctx, items))
        : emptyState({
            illustration: 'documents',
            compact: true,
            title: t('documents.none'),
            body: canEdit(ctx) ? t('documents.noneBody') : undefined,
          });
  const upload = canEdit(ctx)
    ? `<form class="stack gap-2" id="doc-upload">
        <h3>${esc(t('documents.upload'))}</h3>
        ${labelled(t('documents.fileLabel'), input({ type: 'file', name: 'file', attrs: { accept: '.pdf,.txt,.md,application/pdf,text/plain,text/markdown', required: true } }))}
        ${labelled(t('documents.col.title'), input({ name: 'title', value: draft?.title ?? '', placeholder: t('documents.titlePlaceholder'), attrs: { maxlength: 200 } }))}
        ${labelled(t('documents.field.language'), select('language', languages(), draft?.language ?? ''))}
        <div>${button(t('documents.upload'), { variant: 'primary', type: 'submit', busy: uploading })}</div>
      </form>`
    : '';
  return card(`<h2>${esc(t('documents.title'))}</h2><div data-doc-list>${rows}</div>${upload}`, {
    class: 'stack gap-2',
  });
}

const view: View = {
  id: 'documents',
  get title() {
    return t('documents.title');
  },
  icon: 'file-text',
  // The search, in the address (U5.06: a saved view keeps it).
  query: {
    read(params, ctx) {
      const q = (params.get('q') ?? '').trim().slice(0, 200);
      if (q !== uiState(ctx).query) found = null;
      uiState(ctx).query = q;
    },
    write(ctx) {
      return { q: uiState(ctx).query || null };
    },
  },
  // The document open beside the list.
  crumbs(ctx) {
    const d = openDoc();
    return ctx.api && d ? [{ label: d.title, href: docLink(d.number) }] : [];
  },
  render(ctx) {
    const head = pageHead({
      eyebrow: t('documents.eyebrow'),
      title: t('documents.title'),
      lead: t('documents.lead'),
    });
    if (!ctx.api) return `${head}${card(needsApi(esc(t('documents.needsApi'))))}`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}${card(skeleton.card(t('documents.loadingApi')))}`;
    if (o.status !== 'ready')
      return `${head}${apiUnreachable(o.error, { signIn: Boolean(ctx.auth.config?.enabled && !ctx.auth.signedIn) })}`;
    return `${head}${searchCard(ctx)}${split(listCard(ctx), recordCard(ctx), {
      open: opened() !== null,
      back: docLink(null),
      label: t('documents.splitLabel'),
    })}`;
  },
  bind(root, ctx) {
    const api = ctx.api;
    const site = siteId(ctx);
    if (!api || !site || ctx.ontology.status !== 'ready') return;
    if (listing?.key !== site) void loadList(ctx);
    const ui = uiState(ctx);
    if (ui.query.trim() && found?.key !== searchKey(ctx)) void search(ctx);
    onSubmit(root, '#doc-search', (form) => {
      ui.query = field(form, 'q').trim();
      found = null;
      ctx.rerender();
    });
    // Buttons outside the list here; the list's on the list (its table draws rows again as it sorts).
    onAll(
      root,
      '[data-open]:not([data-doc-list] *)',
      'click',
      (el) => void open(ctx, Number(el.dataset.open), Number(el.dataset.page)),
    );
    const docs = listing?.key === site ? listing.items : null;
    if (docs?.length) bindTable(root, listTable(ctx, docs));
    listKeys(root, '[data-doc-list] [data-doc]', (row) => row.getAttribute('data-doc') === String(opened()));
    rowClicks(root, '[data-doc-list]', '[data-doc]');
    bindFilterBar(root, ctx, barOptions(ctx));
    onAll(root, '[data-retry-search]', 'click', () => {
      found = null;
      ctx.rerender();
    });
    onAll(root, '[data-retry-docs]', 'click', () => {
      listing = null;
      ctx.rerender();
    });
    // Archived at once, with Undo (U2.03): it leaves the list and search until restored.
    const refresh = () => {
      listing = null;
      found = null;
      ctx.rerender();
    };
    const archive = (el: HTMLElement): Promise<unknown> | undefined => {
      const n = Number(el.dataset.archiveDoc);
      const doc = listing?.items?.find((d) => d.number === n);
      if (!doc) return;
      // Its page goes (in place: Back wouldn't find it) and the list stays; Undo opens it again.
      const wasOpen = opened() === n;
      return removeNow({
        toast: ctx.toast,
        message: t('documents.archived', { title: doc.title }),
        send: () =>
          api.documents.archive(site, n).then(() => {
            if (wasOpen && opened() === n) showHash(docLink(null));
            refresh();
          }),
        undo: () => api.documents.restore(site, n),
        restored: () => {
          if (wasOpen && opened() === null) showHash(docLink(n));
          refresh();
        },
        restoredMessage: t('documents.restored', { title: doc.title }),
      });
    };
    onAction(root, '[data-archive-doc]:not([data-doc-list] *)', archive);
    onAll(root, '[data-doc-list]', 'click', (_list, e) => {
      const hit = e.target instanceof Element ? e.target : null;
      const opener = hit?.closest<HTMLElement>('[data-open]');
      if (opener) return void open(ctx, Number(opener.dataset.open), Number(opener.dataset.page));
      const btn = hit?.closest<HTMLButtonElement>('[data-archive-doc]');
      if (!btn || btn.disabled) return;
      // Held while it is sent, as onAction holds a button.
      const sent = archive(btn);
      if (!sent) return;
      setBusy(btn, true);
      void sent.finally(() => btn.isConnected && setBusy(btn, false));
    });
    const uploadForm = root.querySelector<HTMLFormElement>('#doc-upload');
    if (uploadForm) {
      if (draft?.site !== site) draft = { site, file: null, title: '', language: 'english' };
      const input = need<HTMLInputElement>(uploadForm, '[name=file]');
      if (draft.file && typeof DataTransfer !== 'undefined') {
        const chosen = new DataTransfer();
        chosen.items.add(draft.file);
        input.files = chosen.files;
      }
      uploadForm.addEventListener(
        'input',
        () => {
          if (!draft) return;
          draft.file = input.files?.[0] ?? null;
          draft.title = field(uploadForm, 'title');
          draft.language = field(uploadForm, 'language');
        },
        { signal: bound() },
      );
    }
    onSubmit(root, '#doc-upload', (form) => {
      const file = need<HTMLInputElement>(form, '[name=file]').files?.[0];
      if (!file || uploading) return;
      const type = contentTypeOf(file);
      if (!type) return void ctx.toast(t('documents.wrongType'));
      if (file.size > MAX_UPLOAD_BYTES) return void ctx.toast(t('documents.tooLarge'));
      const title = field(form, 'title').trim() || titleFrom(file.name) || t('documents.fallbackTitle');
      uploading = true;
      ctx.rerender();
      return api.documents
        .upload(site, file, type, { title, filename: file.name, language: field(form, 'language') })
        .then(
          (doc) => {
            ctx.toast(t('documents.uploadedToast', { title: doc.title, count: doc.pages }));
            ux('task', 'document.uploaded');
            draft = null;
            listing = null;
            found = null;
          },
          () => undefined,
        )
        .finally(() => {
          uploading = false;
          ctx.rerender();
        });
    });
  },
};

export default view;
