"""Document search (T4.08): SOPs and manuals uploaded, read page by page, cut into chunks and
searched by their words, each match with its page to cite."""

from typing import Any

import psycopg
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pdfs import make_pdf
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

from tiles_api import api_documents, documents

SOP = [
    "SOP 14: Die-casting cell 1\nPurpose: safe start-up of the cell after a stop.",
    "Before start-up, check the hydraulic pressure of the shot cylinder.\nIt must be 140 to 160 bar.",
    "Plunger tip lubrication: lubricate every 500 shots.\nReplace the plunger tip after 20000 shots.",
]


def upload(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    content: bytes,
    content_type: str = "application/pdf",
    headers: dict[str, str] = ENG,
    **params: Any,
) -> Any:
    return api.post(
        f"/sites/{site}/documents",
        params={"title": "SOP 14 die-casting start-up", "filename": "SOP-14 (rev B).pdf", **params},
        content=content,
        headers={**headers, "Content-Type": content_type},
    )


def find(api: TestClient, site: str, q: str, **params: Any) -> Any:  # noqa: F811
    return api.get(f"/sites/{site}/documents/search", params={"q": q, **params}, headers=VIEWER)


def test_pages_and_chunks() -> None:
    assert documents.pages(make_pdf(SOP), "application/pdf") == SOP
    text = b"First page.\fSecond page."
    assert documents.pages(text, "text/markdown; charset=utf-8") == ["First page.", "Second page."]
    long = " ".join(f"word{i}" for i in range(2000))  # about 15,000 characters, no form feeds
    found = documents.pages(long.encode(), "text/plain")
    assert len(found) == 6 and all(len(p) <= documents.PAGE_CHARS for p in found)
    assert " ".join(found) == long  # cut at spaces, nothing lost
    chunks = documents.chunk(found)
    assert all(len(c.text) <= documents.CHUNK_CHARS for c in chunks)
    assert [c.ordinal for c in chunks] == list(range(len(chunks)))
    # Neighbouring chunks of a page overlap, so a phrase across a cut is in one of them.
    first, second = chunks[0].text, chunks[1].text
    assert second.split()[0] in first.split()[-30:]
    assert {c.page for c in chunks} == set(range(1, 7))


@pytest.mark.parametrize(
    ("content", "content_type", "why"),
    [
        (b"%PDF-1.4 broken", "application/pdf", "The PDF can't be read"),
        (make_pdf([" ", ""]), "application/pdf", "no text to search"),
        (b"\xff\xfe\x00 not utf-8", "text/plain", "isn't UTF-8"),
        (b"a,b,c", "text/csv", "Send a PDF, a text file or a Markdown file"),
        (b"x" * (documents.MAX_BYTES + 1), "text/plain", "larger than 20 MB"),
    ],
)
def test_files_that_cant_be_read_say_why(content: bytes, content_type: str, why: str) -> None:
    with pytest.raises(documents.DocumentError, match=why):
        documents.pages(content, content_type)


def test_an_upload_is_searched_and_cited_by_page(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    res = upload(api, site, make_pdf(SOP))
    assert res.status_code == 201, res.text
    doc = res.json()
    assert (doc["number"], doc["pages"], doc["filename"], doc["language"]) == (1, 3, "SOP-14 _rev B_.pdf", "english")
    # Stemmed words: "lubricating" finds "lubricate"; the page to cite comes with each match.
    out = find(api, site, "lubricating plunger").json()
    assert [(m["document"], m["page"]) for m in out["matches"]] == [(1, 3)]
    assert "\x02lubricate\x03" in out["matches"][0]["snippet"].lower()
    assert find(api, site, '"hydraulic pressure"').json()["matches"][0]["page"] == 2
    assert find(api, site, "hydraulic -pressure").json()["matches"] == []
    assert find(api, site, "spindle").json()["matches"] == []
    # The file as it was sent.
    file = api.get(f"/sites/{site}/documents/1/file", headers=VIEWER)
    assert file.status_code == 200
    assert file.content == make_pdf(SOP)
    assert file.headers["content-type"] == "application/pdf"
    assert file.headers["content-security-policy"] == "sandbox"
    assert [d["title"] for d in api.get(f"/sites/{site}/documents", headers=VIEWER).json()] == [
        "SOP 14 die-casting start-up"
    ]
    with psycopg.connect(database_url) as conn:
        audit = conn.execute(
            "SELECT action, after->>'chunks' FROM audit_log WHERE entity_type = 'document' AND site_id = %s", [site]
        ).fetchall()
    assert audit == [("document.upload", "3")]


def test_a_german_document_is_stemmed_in_german(api: TestClient, site: str) -> None:  # noqa: F811
    text = "Vor dem Anfahren den Hydraulikdruck prüfen.\fDie Kolbenspitzen nach 20000 Schuss wechseln.".encode()
    res = upload(api, site, text, "text/plain", title="SA 14", language="german")
    assert res.status_code == 201, res.text
    assert [m["page"] for m in find(api, site, "Kolbenspitze").json()["matches"]] == [2]


def test_archived_documents_leave_search_and_the_list(api: TestClient, site: str) -> None:  # noqa: F811
    upload(api, site, make_pdf(SOP))
    assert api.delete(f"/sites/{site}/documents/1", headers=ENG).status_code == 204
    assert find(api, site, "plunger").json()["matches"] == []
    assert api.get(f"/sites/{site}/documents", headers=VIEWER).json() == []
    assert api.get(f"/sites/{site}/documents/1/file", headers=VIEWER).status_code == 404
    assert upload(api, site, make_pdf(SOP)).json()["number"] == 2  # numbers aren't reused


def test_requests_are_checked(api: TestClient, site: str) -> None:  # noqa: F811
    assert upload(api, site, make_pdf(SOP), headers=VIEWER).status_code == 403  # engineers upload
    bad = upload(api, site, make_pdf([" "]))
    assert (bad.status_code, bad.json()["detail"]) == (
        422,
        "The document has no text to search (a scan needs OCR first)",
    )
    assert upload(api, site, make_pdf(SOP), language="klingon").status_code == 422
    assert upload(api, site, make_pdf(SOP), title=" padded").status_code == 422
    big = api.post(
        f"/sites/{site}/documents",
        params={"title": "big"},
        content=b"x" * (documents.MAX_BYTES + 1),
        headers={**ENG, "Content-Type": "text/plain"},
    )
    assert big.status_code == 413
    assert find(api, site, "").status_code == 422
    assert find(api, site, "!!! & |").json()["matches"] == []  # nothing to search for: no error


def test_any_pdf_failure_is_a_file_that_cant_be_read(monkeypatch: pytest.MonkeyPatch) -> None:
    import zlib

    from pypdf.errors import LimitReachedError

    for error in (LimitReachedError("too much to decompress"), zlib.error("bad stream"), AttributeError("x")):

        def broken(*_args: Any, error: Exception = error) -> Any:
            raise error

        monkeypatch.setattr(documents, "PdfReader", broken)
        with pytest.raises(documents.DocumentError, match=f"can't be read \\({type(error).__name__}\\)"):
            documents.pages(b"%PDF-1.4", "application/pdf")


def test_control_characters_never_reach_the_index() -> None:
    # STX and ETX mark matches in snippets: a document's own would unbalance them.
    found = documents.pages(b"a\x02b\x03c\x07d\te\nf\x00g", "text/plain")
    assert found == ["a b c d e\nf g"]


def test_search_uses_the_index(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    upload(api, site, make_pdf(SOP))
    upload(api, site, b"Kolbenspitze wechseln.", "text/plain", title="SA", language="german")
    # A manual of many pages, so the plan is a large site's.
    manual = "\f".join(f"Section {i}: torque the clamp bolts to spec {i} Nm and log it." for i in range(1500))
    upload(api, site, manual.encode(), "text/plain", title="Manual")
    with psycopg.connect(database_url) as conn:
        conn.execute("ANALYZE document_chunks")
        conn.execute("SELECT set_config('tiles.site_id', %s, false)", [site])
        plan = "\n".join(
            r[0]
            for r in conn.execute(
                "EXPLAIN " + api_documents.SEARCH_SQL, {"q": "plunger tip", "site": site, "limit": 10}
            ).fetchall()
        )
    assert "document_chunks_tsv" in plan


def test_a_bad_content_length_is_a_400(api: TestClient, site: str) -> None:  # noqa: F811
    import asyncio
    from types import SimpleNamespace

    from tiles_api.api_documents import upload_body

    with pytest.raises(HTTPException) as e:
        asyncio.run(upload_body(SimpleNamespace(headers={"content-length": "abc"})))  # type: ignore[arg-type]
    assert e.value.status_code == 400
