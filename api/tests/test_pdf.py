"""The PDF writer for reports (T4.13): a valid document, text wrapped and escaped, pages added."""

import re

from tiles_api import pdf


def objects(doc: bytes) -> dict[int, int]:
    """Each object's offset, as the cross-reference table gives it, checked against the file."""
    xref = int(re.search(rb"startxref\n(\d+)\n%%EOF\n$", doc).group(1))  # type: ignore[union-attr]
    assert doc[xref:].startswith(b"xref\n")
    entries = re.findall(rb"(\d{10}) 00000 n ", doc[xref:])
    out = {}
    for i, off in enumerate(entries, 1):
        offset = int(off)
        assert doc[offset:].startswith(b"%d 0 obj\n" % i), i
        out[i] = offset
    return out


def test_a_report_is_a_valid_pdf() -> None:
    doc = pdf.Report(footer="Tiles").add("Title", "title").add("Some (text) with \\ and °C, µm · 3–4").render()  # noqa: RUF001
    assert doc.startswith(b"%PDF-1.4\n")
    assert len(objects(doc)) == 7  # catalog, pages, three fonts, one page and its content
    assert b"/Count 1" in doc
    assert b"(Some \\(text\\) with \\\\ and \xb0C, \xb5m \xb7 3\x964) Tj" in doc  # WinAnsi, escaped
    assert b"(Tiles \xb7 page 1 of 1) Tj" in doc


def test_long_text_wraps_and_fills_pages() -> None:
    report = pdf.Report()
    report.add("word " * 400)  # wrapped at about 105 characters
    for i in range(200):
        report.add(f"Line {i}")
    doc = report.render()
    pages = int(re.search(rb"/Count (\d+)", doc).group(1))  # type: ignore[union-attr]
    assert pages >= 4
    assert len(objects(doc)) == 5 + 2 * pages
    assert b"(Line 199) Tj" in doc
    assert b"page 4 of" in doc


def test_lines_stay_inside_the_margins() -> None:
    # Courier is 0.6 of its size wide: a full mono line fits the text width.
    assert pdf.CHARS["mono"] * pdf.SIZE["mono"] * 0.6 <= pdf.WIDTH - 2 * pdf.MARGIN
    assert pdf.CHARS["title"] < pdf.CHARS["heading"] < pdf.CHARS["text"]


def test_what_the_font_lacks_and_long_words() -> None:
    assert pdf._wrap("a" * 250, 100) == ["a" * 100, "a" * 100, "a" * 50]
    assert pdf._wrap("one two\nthree", 7) == ["one two", "three"]
    assert pdf._escape("→ ✓") == b"? ?"
