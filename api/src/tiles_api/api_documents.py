"""Document search (T4.08): a site's SOPs, manuals and lessons learned, uploaded as PDF, text or
Markdown, searched by their words, with the page of each match to cite (documents.py reads and
cuts them). Engineers upload and archive, audited; anyone on the site lists, searches and opens
them; the copilot searches them too (copilot_tools.search_documents).
"""

import hashlib
import re
import unicodedata
import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field

from tiles_api import documents
from tiles_api.api_ontology import Ctx, Editor, SiteContext
from tiles_api.store import one

router = APIRouter(tags=["documents"])

MAX_RESULTS = 50
# Around each match in a snippet (STX and ETX: characters a document's text never keeps).
MARK_START, MARK_END = "\x02", "\x03"
TITLE = r"^\S(.*\S)?$"


class DocumentOut(BaseModel):
    number: int
    title: str
    filename: str
    content_type: str
    language: str
    pages: int
    size: int
    sha256: str
    uploaded_by: str
    created_at: datetime


class Match(BaseModel):
    document: int = Field(description="The document's number")
    title: str
    page: int
    snippet: str = Field(description="The words around the match; each match between \\u0002 and \\u0003")
    rank: float


class SearchOut(BaseModel):
    query: str
    matches: list[Match]


DOC_SQL = """
SELECT number, title, filename, content_type, language::text AS language, pages, size, sha256, uploaded_by, created_at
FROM documents WHERE site_id = %s AND archived_at IS NULL
"""

SEARCH_SQL = """
SELECT d.number AS document, d.title, c.page,
       ts_rank_cd(c.tsv, q.q) AS rank,
       ts_headline(c.language, c.text, q.q,
                   'MaxFragments=2, MaxWords=30, MinWords=12, FragmentDelimiter=" … ", '
                   'StartSel=' || chr(2) || ', StopSel=' || chr(3)) AS snippet
FROM document_chunks c
JOIN documents d ON d.site_id = c.site_id AND d.id = c.document_id
CROSS JOIN LATERAL (SELECT websearch_to_tsquery(c.language, %(q)s) AS q) q
WHERE c.site_id = %(site)s AND d.archived_at IS NULL AND c.tsv @@ q.q
ORDER BY rank DESC, d.number, c.page, c.ordinal
LIMIT %(limit)s
"""


async def upload_body(request: Request) -> bytes:
    """The uploaded file, read on the event loop, refused once it passes the size limit."""
    size = int(request.headers.get("content-length") or 0)
    if size > documents.MAX_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "The file is larger than 20 MB")
    body = bytearray()
    async for part in request.stream():
        body += part
        if len(body) > documents.MAX_BYTES:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "The file is larger than 20 MB")
    return bytes(body)


Upload = Annotated[bytes, Depends(upload_body)]


def _filename(name: str) -> str:
    """A file name safe to send back in a header: letters, digits, dot, dash, underscore, space."""
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip(" .")[:120]
    return name or "document"


def _document(ctx: SiteContext, number: int) -> dict[str, Any]:
    row: dict[str, Any] | None = ctx.conn.execute(f"{DOC_SQL} AND number = %s", [ctx.site_id, number]).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such document on this site")
    return row


@router.post("/sites/{site_id}/documents", response_model=DocumentOut, status_code=status.HTTP_201_CREATED)
def upload_document(
    ctx: Editor,
    request: Request,
    content: Upload,
    title: Annotated[str, Query(min_length=1, max_length=200, pattern=TITLE)],
    filename: Annotated[str, Query(max_length=300)] = "",
    language: Annotated[str, Query(description=f"One of {', '.join(documents.LANGUAGES)}")] = "english",
) -> dict[str, Any]:
    """Uploads a document: the body is the file (Content-Type `application/pdf`, `text/plain` or
    `text/markdown`, up to 20 MB). Its text is read page by page and indexed for search; 422 says
    why a file can't be read (encrypted, a scan without text, not UTF-8…)."""
    if language not in documents.LANGUAGES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"language: one of {', '.join(documents.LANGUAGES)}")
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    try:
        found = documents.pages(content, content_type)
    except documents.DocumentError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    chunks = documents.chunk(found)
    digest = hashlib.sha256(content).hexdigest()
    number = one(
        ctx.conn.execute(
            "INSERT INTO document_numbers (site_id, last) VALUES (%s, 1)"
            " ON CONFLICT (site_id) DO UPDATE SET last = document_numbers.last + 1 RETURNING last",
            [ctx.site_id],
        ).fetchone()
    )["last"]
    doc_id = uuid.uuid4()
    name = _filename(filename or title)
    ctx.conn.execute(
        """
        INSERT INTO documents (id, site_id, number, title, filename, content_type, language, pages, size, sha256,
                               content, uploaded_by_id, uploaded_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s::regconfig, %s, %s, %s, %s, %s, %s)
        """,
        [
            doc_id,
            ctx.site_id,
            number,
            title,
            name,
            content_type,
            language,
            len(found),
            len(content),
            digest,
            content,
            ctx.user.id,
            ctx.user.name,
        ],
    )
    with ctx.conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO document_chunks (site_id, document_id, page, ordinal, language, text)"
            " VALUES (%s, %s, %s, %s, %s::regconfig, %s)",
            [(ctx.site_id, doc_id, c.page, c.ordinal, language, c.text) for c in chunks],
        )
    ctx.audit(
        "document.upload",
        "document",
        str(number),
        after={"title": title, "filename": name, "pages": len(found), "chunks": len(chunks), "sha256": digest},
    )
    return _document(ctx, number)


@router.get("/sites/{site_id}/documents", response_model=list[DocumentOut])
def list_documents(ctx: Ctx) -> list[dict[str, Any]]:
    """The site's documents, newest first."""
    return ctx.conn.execute(f"{DOC_SQL} ORDER BY number DESC", [ctx.site_id]).fetchall()


def search(ctx: SiteContext, q: str, limit: int = 10) -> list[dict[str, Any]]:
    """The chunks that match the query best, as `GET …/documents/search` answers them."""
    q = q.replace("\x00", "").strip()[:500]
    if not q:
        return []
    return ctx.conn.execute(SEARCH_SQL, {"q": q, "site": ctx.site_id, "limit": limit}).fetchall()


@router.get("/sites/{site_id}/documents/search", response_model=SearchOut)
def search_documents(
    ctx: Ctx,
    q: Annotated[str, Query(min_length=1, max_length=500, description='Words, "a phrase", or -excluded')],
    limit: Annotated[int, Query(ge=1, le=MAX_RESULTS)] = 10,
) -> dict[str, Any]:
    """The passages that match best, each with its document and page to cite. The query is read as
    a web search: words (stemmed: "valves" finds "valve"), "quoted phrases", OR, and -words to
    leave out."""
    return {"query": q, "matches": search(ctx, q, limit)}


@router.get("/sites/{site_id}/documents/{number}/file")
def document_file(ctx: Ctx, number: int) -> Response:
    """The file as it was uploaded (a PDF opens at a page with `#page=N`)."""
    doc = _document(ctx, number)
    row = one(
        ctx.conn.execute(
            "SELECT content FROM documents WHERE site_id = %s AND number = %s", [ctx.site_id, number]
        ).fetchone()
    )
    shown = doc["content_type"] if doc["content_type"] == "application/pdf" else "text/plain; charset=utf-8"
    return Response(
        bytes(row["content"]),
        media_type=shown,
        headers={
            "Content-Disposition": f'inline; filename="{doc["filename"]}"',
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",  # an uploaded file never runs as this API's page
        },
    )


@router.delete("/sites/{site_id}/documents/{number}", status_code=status.HTTP_204_NO_CONTENT)
def archive_document(ctx: Editor, number: int) -> Response:
    """Archives a document: it leaves the list and search; its number isn't reused."""
    doc = _document(ctx, number)
    ctx.conn.execute(
        "UPDATE documents SET archived_at = now() WHERE site_id = %s AND number = %s", [ctx.site_id, number]
    )
    ctx.audit("document.archive", "document", str(number), before={"title": doc["title"]})
    return Response(status_code=status.HTTP_204_NO_CONTENT)
