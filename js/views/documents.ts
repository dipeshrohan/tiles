import { esc, field, need, onAll, onNavigate, onSubmit, routeOf } from '../lib/dom.ts';
import type { DocumentMatch, SiteDocument } from '../lib/api.ts';
import {
  contentTypeOf,
  LANGUAGES,
  MAX_UPLOAD_BYTES,
  pageFragment,
  sizeText,
  snippetHtml,
  titleFrom,
} from '../lib/documents.ts';
import type { Context, View } from './types.ts';
import { confirmDialog } from '../lib/overlay.ts';
import {
  button,
  card,
  emptyState,
  errorState,
  field as labelled,
  input,
  needsApi,
  pageHead,
  select,
  skeleton,
} from '../lib/ui.ts';

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

function searchCard(ctx: Context): string {
  const ui = uiState(ctx);
  const results = found?.key === searchKey(ctx) ? found.matches : undefined;
  let body = '';
  if (found?.key === searchKey(ctx) && found.failed)
    body = `<p class="small" role="alert">The search could not be run. ${button('Try again', { size: 'sm', attrs: { 'data-retry-search': true } })}</p>`;
  else if (ui.query.trim() && results === null) body = '<p class="small soft">Searching…</p>';
  else if (results && !results.length)
    body = `<p class="small soft" data-no-matches>Nothing matches “${esc(ui.query)}”.</p>`;
  else if (results)
    body = `<ol class="stack doc-matches gap-2_5" data-matches>${results
      .map(
        (m) => `<li class="doc-match">
          <div class="row gap-2 justify-between wrap">
            <b>${esc(m.title)}</b>
            ${button(`Open page ${m.page}`, { size: 'sm', attrs: { 'data-open': m.document, 'data-page': m.page } })}
          </div>
          <p class="small">${snippetHtml(m.snippet)}</p>
        </li>`,
      )
      .join('')}</ol>`;
  return card(
    `<form class="row gap-2 wrap" id="doc-search" role="search">
        ${labelled('Search the documents', input({ type: 'search', name: 'q', value: ui.query, placeholder: 'e.g. plunger tip replace, "hydraulic pressure"' }), { class: 'grow min-w-field' })}
        <div class="self-end">${button('Search', { variant: 'primary', type: 'submit' })}</div>
      </form>
      <p class="small soft">Words find their forms (“valves” finds “valve”); “quoted words” find a phrase; -word leaves a word out.</p>
      <div aria-live="polite">${body}</div>`,
    { class: 'stack gap-3' },
  );
}

function listCard(ctx: Context): string {
  const items = listing?.key === siteId(ctx) ? listing.items : null;
  const rows = listing?.failed
    ? errorState({ title: 'The documents could not be loaded', retry: 'retry-docs', compact: true })
    : items === null
      ? skeleton()
      : items
          .map(
            (d) => `<div class="review-row" data-doc="${d.number}">
              <span class="row gap-1_5 justify-between"><b>${esc(d.title)}</b>
              <span class="row gap-1">${button('Open', { size: 'sm', attrs: { 'data-open': d.number, 'data-page': 1 } })}${
                canEdit(ctx)
                  ? button('Archive', {
                      size: 'sm',
                      variant: 'danger',
                      attrs: { 'data-archive-doc': d.number, 'aria-label': `Archive ${d.title}` },
                    })
                  : ''
              }</span></span>
              <span class="small muted">${d.pages} page(s) · ${esc(sizeText(d.size))} · ${esc(d.uploaded_by)}</span>
            </div>`,
          )
          .join('') ||
        emptyState({
          illustration: 'documents',
          compact: true,
          title: 'No documents yet',
          body: canEdit(ctx) ? 'Upload SOPs, manuals and lessons learned below.' : undefined,
        });
  const upload = canEdit(ctx)
    ? `<form class="stack gap-2" id="doc-upload">
        <h3>Upload</h3>
        ${labelled('File (PDF, text or Markdown, up to 20 MB)', input({ type: 'file', name: 'file', attrs: { accept: '.pdf,.txt,.md,application/pdf,text/plain,text/markdown', required: true } }))}
        ${labelled('Title', input({ name: 'title', value: draft?.title ?? '', placeholder: 'From the file name', attrs: { maxlength: 200 } }))}
        ${labelled('Language', select('language', LANGUAGES, draft?.language ?? ''))}
        <div>${button(uploading ? 'Uploading…' : 'Upload', { variant: 'primary', type: 'submit', disabled: uploading })}</div>
      </form>`
    : '';
  return card(`<h2>Documents</h2><div class="review-list" data-doc-list>${rows}</div>${upload}`, {
    class: 'stack gap-2',
  });
}

const view: View = {
  id: 'documents',
  title: 'Documents',
  icon: 'file-text',
  render(ctx) {
    const head = pageHead({
      eyebrow: 'Data · Knowledge',
      title: 'Documents',
      lead: 'SOPs, manuals and lessons learned, searched by their words: each match with its page. The copilot searches them too, and cites the page.',
    });
    if (!ctx.api) return `${head}${card(needsApi(`Documents are kept by the Tiles API.`))}`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}${card('Loading from the Tiles API…')}`;
    if (o.status !== 'ready')
      return `${head}${card(`Can't reach the Tiles API: ${esc(o.error)}`, { attrs: { role: 'alert' } })}`;
    return `${head}<div class="reviews">${listCard(ctx)}${searchCard(ctx)}</div>`;
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
    onAll(root, '[data-open]', 'click', (el) => void open(ctx, Number(el.dataset.open), Number(el.dataset.page)));
    onAll(root, '[data-retry-search]', 'click', () => {
      found = null;
      ctx.rerender();
    });
    onAll(root, '[data-retry-docs]', 'click', () => {
      listing = null;
      ctx.rerender();
    });
    onAll(root, '[data-archive-doc]', 'click', async (el) => {
      const n = Number(el.dataset.archiveDoc);
      const doc = listing?.items?.find((d) => d.number === n);
      if (!doc) return;
      const yes = await confirmDialog({
        title: `Archive ${doc.title}?`,
        body: 'It leaves the list and search, and the copilot stops citing it.',
        confirm: 'Archive',
      });
      if (!yes) return;
      api.documents.archive(site, n).then(
        () => {
          ctx.toast(`Archived ${doc.title}`);
          listing = null;
          found = null;
          ctx.rerender();
        },
        () => undefined,
      );
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
      uploadForm.addEventListener('input', () => {
        if (!draft) return;
        draft.file = input.files?.[0] ?? null;
        draft.title = field(uploadForm, 'title');
        draft.language = field(uploadForm, 'language');
      });
    }
    onSubmit(root, '#doc-upload', (form) => {
      const file = need<HTMLInputElement>(form, '[name=file]').files?.[0];
      if (!file || uploading) return;
      const type = contentTypeOf(file);
      if (!type) return void ctx.toast('Upload a PDF, a text file or a Markdown file');
      if (file.size > MAX_UPLOAD_BYTES) return void ctx.toast('The file is larger than 20 MB');
      const title = field(form, 'title').trim() || titleFrom(file.name) || 'Document';
      uploading = true;
      ctx.rerender();
      api.documents
        .upload(site, file, type, { title, filename: file.name, language: field(form, 'language') })
        .then(
          (doc) => {
            ctx.toast(`Uploaded ${doc.title}: ${doc.pages} page(s)`);
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
