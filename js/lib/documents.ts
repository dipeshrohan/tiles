// Document search (T4.08), pure: what a file is sent as, its title, and a match's snippet with the
// matched words marked. The Documents page draws them.

import { esc } from './dom.ts';

// The languages a document can be searched in (the API's full-text configurations).
export const LANGUAGES = [
  ['english', 'English'],
  ['german', 'German'],
  ['french', 'French'],
  ['spanish', 'Spanish'],
  ['italian', 'Italian'],
  ['dutch', 'Dutch'],
  ['portuguese', 'Portuguese'],
  ['swedish', 'Swedish'],
  ['simple', 'Other (no stemming)'],
] as const;

// What to send a file as: a PDF, text or Markdown, by its type or else its name; null otherwise.
export function contentTypeOf(file: { name: string; type: string }): string | null {
  const type = file.type.toLowerCase();
  if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'application/pdf';
  if (type === 'text/markdown' || /\.(md|markdown)$/i.test(file.name)) return 'text/markdown';
  if (type === 'text/plain' || /\.txt$/i.test(file.name)) return 'text/plain';
  return null;
}

// A title from a file name: no extension, separators as spaces.
export function titleFrom(name: string): string {
  return name
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// The snippet as HTML: escaped, each match (between \u0002 and \u0003) in <mark>.
export function snippetHtml(snippet: string): string {
  return esc(snippet).replaceAll('\u0002', '<mark>').replaceAll('\u0003', '</mark>');
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Where a match is in the file: a PDF opens at its page.
export function pageFragment(contentType: string, page: number): string {
  return contentType === 'application/pdf' ? `#page=${page}` : '';
}
