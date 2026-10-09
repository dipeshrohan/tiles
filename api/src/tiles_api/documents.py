"""Document search (T4.08), the pure part: a file's text page by page, and the chunks it is searched
in, each with its page.

PDFs are read with pypdf, page by page (scanned pages without a text layer come out empty: they
need OCR first). Text and Markdown files have no pages: a form feed starts a new one, else every
PAGE_CHARS characters do, so a citation can still point somewhere. Chunks are about CHUNK_CHARS
long, cut at word boundaries, overlapping by OVERLAP_CHARS so a phrase across a cut is found in
one of them; a chunk never spans two pages, so its page is the one to cite.

Search itself is PostgreSQL's full-text search over the chunks (api_documents.py): stemmed words
in the document's language, ranked by how close together the query's words are. It needs no
embedding model, and gives exact pages to cite; meaning-based search would add one later.
"""

import io
import logging
import re
import zlib
from dataclasses import dataclass

from pypdf import PdfReader
from pypdf.errors import PyPdfError

MAX_BYTES = 20 * 1024 * 1024
MAX_PAGES = 2_000
MAX_CHARS = 3_000_000  # of text in one document
PAGE_CHARS = 3_000  # a "page" of a file without pages
CHUNK_CHARS = 1_000
OVERLAP_CHARS = 150

KINDS = {"application/pdf": "pdf", "text/plain": "text", "text/markdown": "text"}
# The full-text configurations a document may be read in (PostgreSQL's built-in ones).
LANGUAGES = ("english", "german", "french", "spanish", "italian", "dutch", "portuguese", "swedish", "simple")

logging.getLogger("pypdf").setLevel(logging.ERROR)  # it warns about every odd PDF; we report what matters


class DocumentError(ValueError):
    """A file that can't be read: the message says why, for the person who sent it."""


@dataclass(frozen=True)
class Chunk:
    page: int  # from 1
    ordinal: int  # within the document, from 0
    text: str


def pages(content: bytes, content_type: str) -> list[str]:
    """The file's text, one string per page."""
    if len(content) > MAX_BYTES:
        raise DocumentError(f"The file is larger than {MAX_BYTES // (1024 * 1024)} MB")
    kind = KINDS.get(content_type.split(";")[0].strip().lower())
    if kind is None:
        raise DocumentError("Send a PDF, a text file or a Markdown file")
    found = _pdf_pages(content) if kind == "pdf" else _text_pages(content)
    if sum(len(p) for p in found) > MAX_CHARS:
        raise DocumentError(f"The document has more than {MAX_CHARS:,} characters of text")
    if not any(p.strip() for p in found):
        raise DocumentError("The document has no text to search (a scan needs OCR first)")
    return found


def _pdf_pages(content: bytes) -> list[str]:
    try:
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted:
            raise DocumentError("The PDF is encrypted: send it without a password")
        if len(reader.pages) > MAX_PAGES:
            raise DocumentError(f"The PDF has more than {MAX_PAGES} pages")
        return [_clean(page.extract_text() or "") for page in reader.pages]
    except DocumentError:
        raise
    # A malformed PDF fails in many ways (pypdf's own errors, its limits on what it decompresses,
    # zlib, a missing object): each is a file that can't be read, never a server error.
    except (PyPdfError, ValueError, KeyError, TypeError, IndexError, AttributeError, RecursionError, zlib.error) as e:
        raise DocumentError(f"The PDF can't be read ({type(e).__name__})") from None


def _text_pages(content: bytes) -> list[str]:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise DocumentError("The text file isn't UTF-8") from None
    found: list[str] = []
    for part in text.split("\f"):
        part = _clean(part)
        while len(part) > PAGE_CHARS:
            cut = _cut(part, PAGE_CHARS)
            found.append(part[:cut].strip())
            part = part[cut:].strip()
        found.append(part)
    if len(found) > MAX_PAGES:
        raise DocumentError(f"The document has more than {MAX_PAGES} pages")
    return found


CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")  # all but tab and newline (and NUL, which PostgreSQL refuses)


def _clean(text: str) -> str:
    """Text as searched: no control characters (STX and ETX mark matches in snippets: none may be
    in the text), one space between words."""
    text = CONTROL.sub(" ", text)
    text = re.sub(r"[ \t\r\v]+", " ", text)
    return re.sub(r"\n\s*\n\s*", "\n\n", text).strip()


def _cut(text: str, at: int) -> int:
    """Where to cut `text` near `at`: at the last whitespace before it, or at `at` if there is none
    in its second half."""
    space = text.rfind(" ", at // 2, at)
    newline = text.rfind("\n", at // 2, at)
    best = max(space, newline)
    return best if best > 0 else at


def chunk(found: list[str]) -> list[Chunk]:
    """The pages cut into overlapping chunks, each within one page."""
    chunks: list[Chunk] = []
    for number, text in enumerate(found, 1):
        start = 0
        while start < len(text):
            end = len(text) if len(text) - start <= CHUNK_CHARS else start + _cut(text[start:], CHUNK_CHARS)
            piece = text[start:end].strip()
            if piece:
                chunks.append(Chunk(number, len(chunks), piece))
            if end >= len(text):
                break
            # Step back for the overlap, to a word boundary, but always forward.
            back = text.find(" ", max(start + 1, end - OVERLAP_CHARS), end)
            start = back + 1 if back > start else end
    return chunks
