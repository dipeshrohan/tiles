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
    body =
      '<p class="small" role="alert">The search could not be run. <button class="btn sm" type="button" data-retry-search>Try again</button></p>';
  else if (ui.query.trim() && results === null) body = '<p class="small soft">Searching…</p>';
  else if (results && !results.length)
    body = `<p class="small soft" data-no-matches>Nothing matches “${esc(ui.query)}”.</p>`;
  else if (results)
    body = `<ol class="stack doc-matches" style="gap:10px" data-matches>${results
      .map(
        (m) => `<li class="doc-match">
          <div class="row" style="gap:8px;justify-content:space-between;flex-wrap:wrap">
            <b>${esc(m.title)}</b>
            <button class="btn sm" type="button" data-open="${m.document}" data-page="${m.page}">Open page ${m.page}</button>
          </div>
          <p class="small">${snippetHtml(m.snippet)}</p>
        </li>`,
      )
      .join('')}</ol>`;
  return `<div class="card stack" style="gap:12px">
      <form class="row" id="doc-search" role="search" style="gap:8px;flex-wrap:wrap">
        <label class="field" style="flex:1;min-width:220px">Search the documents<input type="search" name="q" value="${esc(ui.query)}" placeholder='e.g. plunger tip replace, "hydraulic pressure"' /></label>
        <div style="align-self:end"><button class="btn primary" type="submit">Search</button></div>
      </form>
      <p class="small soft">Words find their forms (“valves” finds “valve”); “quoted words” find a phrase; -word leaves a word out.</p>
      <div aria-live="polite">${body}</div>
    </div>`;
}

function listCard(ctx: Context): string {
  const items = listing?.key === siteId(ctx) ? listing.items : null;
  const rows = listing?.failed
    ? '<div class="empty" role="alert">The documents could not be loaded. <button class="btn sm" type="button" data-retry-docs>Try again</button></div>'
    : items === null
      ? '<div class="empty">Loading…</div>'
      : items
          .map(
            (d) => `<div class="review-row" data-doc="${d.number}">
              <span class="row" style="gap:6px;justify-content:space-between"><b>${esc(d.title)}</b>
              <span class="row" style="gap:4px"><button class="btn sm" type="button" data-open="${d.number}" data-page="1">Open</button>${
                canEdit(ctx)
                  ? `<button class="btn sm danger" type="button" data-archive-doc="${d.number}" aria-label="Archive ${esc(d.title)}">Archive</button>`
                  : ''
              }</span></span>
              <span class="small muted">${d.pages} page(s) · ${esc(sizeText(d.size))} · ${esc(d.uploaded_by)}</span>
            </div>`,
          )
          .join('') ||
        `<div class="empty">No documents yet.${canEdit(ctx) ? ' Upload SOPs, manuals and lessons learned below.' : ''}</div>`;
  const upload = canEdit(ctx)
    ? `<form class="stack" id="doc-upload" style="gap:8px">
        <h3>Upload</h3>
        <label class="field">File (PDF, text or Markdown, up to 20 MB)<input type="file" name="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" required /></label>
        <label class="field">Title<input type="text" name="title" maxlength="200" placeholder="From the file name" value="${esc(draft?.title ?? '')}" /></label>
        <label class="field">Language<select name="language">${LANGUAGES.map(([v, l]) => `<option value="${v}" ${draft?.language === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <div><button class="btn primary" type="submit" ${uploading ? 'disabled' : ''}>${uploading ? 'Uploading…' : 'Upload'}</button></div>
      </form>`
    : '';
  return `<div class="card stack" style="gap:8px"><h2>Documents</h2><div class="review-list" data-doc-list>${rows}</div>${upload}</div>`;
}

const view: View = {
  id: 'documents',
  title: 'Documents',
  icon: 'file-text',
  render(ctx) {
    const head = `<div class="page-head"><div><div class="eyebrow">Data · Knowledge</div><h1>Documents</h1>
        <p class="soft">SOPs, manuals and lessons learned, searched by their words: each match with its page. The copilot searches them too, and cites the page.</p></div></div>`;
    if (!ctx.api)
      return `${head}<div class="card"><p>Documents are kept by the Tiles API: connect to it in <a href="#/settings">Settings</a>.</p></div>`;
    const o = ctx.ontology;
    if (o.status === 'loading') return `${head}<div class="card">Loading from the Tiles API…</div>`;
    if (o.status !== 'ready')
      return `${head}<div class="card" role="alert">Can't reach the Tiles API: ${esc(o.error)}</div>`;
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
    onAll(root, '[data-archive-doc]', 'click', (el) => {
      const n = Number(el.dataset.archiveDoc);
      const doc = listing?.items?.find((d) => d.number === n);
      if (!doc || !confirm(`Archive ${doc.title}? It leaves the list and search.`)) return;
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
