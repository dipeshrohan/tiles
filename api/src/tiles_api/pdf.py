"""A small PDF writer for text reports (T4.13), standard library only: pages of lines in the
standard Helvetica fonts (no fonts embedded), A4, with a footer on each page.

Text is encoded as WinAnsi (cp1252), which covers the units Tiles shows (°, µ, ·, the en dash); a character
it lacks is written as "?". This is enough for an audit report; it is not a layout engine.
"""

from dataclasses import dataclass, field

WIDTH, HEIGHT = 595, 842  # A4 in points
MARGIN = 56
LEADING = {"title": 22, "heading": 17, "text": 13, "mono": 12}
SIZE = {"title": 16, "heading": 12, "text": 9.5, "mono": 8.5}
FONT = {"title": "F2", "heading": "F2", "text": "F1", "mono": "F3"}
# Characters per line before wrapping: the text width over each font's average character width
# (Helvetica about half its size, bold a little more, Courier 0.6), so lines stay in the margins.
AVERAGE = {"title": 0.56, "heading": 0.56, "text": 0.5, "mono": 0.6}
CHARS = {style: int((WIDTH - 2 * MARGIN) / (SIZE[style] * AVERAGE[style])) for style in SIZE}


def _escape(text: str) -> bytes:
    raw = text.encode("cp1252", errors="replace")
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _wrap(text: str, width: int) -> list[str]:
    out: list[str] = []
    for paragraph in text.split("\n"):
        line = ""
        for word in paragraph.split(" "):
            while len(word) > width:  # a word longer than a line (a hash) is broken
                if line:
                    out.append(line)
                    line = ""
                out.append(word[:width])
                word = word[width:]
            if line and len(line) + 1 + len(word) > width:
                out.append(line)
                line = word
            else:
                line = f"{line} {word}" if line else word
        out.append(line)
    return out


@dataclass
class Report:
    footer: str = ""
    _pages: list[list[tuple[str, str]]] = field(default_factory=lambda: [[]])
    _y: float = HEIGHT - MARGIN

    def _line(self, style: str, text: str) -> None:
        if self._y - LEADING[style] < MARGIN + 20:
            self._pages.append([])
            self._y = HEIGHT - MARGIN
        self._y -= LEADING[style]
        self._pages[-1].append((style, text))

    def add(self, text: str, style: str = "text") -> "Report":
        for line in _wrap(text, CHARS[style]):
            self._line(style, line)
        return self

    def space(self) -> "Report":
        self._y -= LEADING["text"] / 2
        self._pages[-1].append(("gap", ""))
        return self

    def render(self) -> bytes:
        """The PDF document."""
        objects: list[bytes] = []
        fonts = (b"Helvetica", b"Helvetica-Bold", b"Courier")
        n_pages = len(self._pages)
        # 1: catalog, 2: pages, 3-5: fonts, then a page and its content per page.
        kids = " ".join(f"{6 + 2 * i} 0 R" for i in range(n_pages)).encode()
        objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
        objects.append(b"<< /Type /Pages /Kids [" + kids + b"] /Count " + str(n_pages).encode() + b" >>")
        for name in fonts:
            objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /" + name + b" /Encoding /WinAnsiEncoding >>")
        for i, page in enumerate(self._pages):
            content = self._content(page, i + 1, n_pages)
            objects.append(
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources << /Font << /F1 3 0 R /F2 4 0 R"
                b" /F3 5 0 R >> >> /Contents %d 0 R >>" % (WIDTH, HEIGHT, 7 + 2 * i)
            )
            objects.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for i, body in enumerate(objects, 1):
            offsets.append(len(out))
            out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
        xref = len(out)
        out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
        for off in offsets:
            out += b"%010d 00000 n \n" % off
        out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
        return bytes(out)

    def _content(self, page: list[tuple[str, str]], number: int, total: int) -> bytes:
        parts = [b"BT"]
        y: float = HEIGHT - MARGIN
        for style, text in page:
            if style == "gap":
                y -= LEADING["text"] / 2
                continue
            y -= LEADING[style]
            parts.append(
                b"/%s %.1f Tf 1 0 0 1 %d %.1f Tm (%s) Tj"
                % (FONT[style].encode(), SIZE[style], MARGIN, y, _escape(text))
            )
        footer = f"{self.footer} · page {number} of {total}".strip(" ·")
        parts.append(b"/F1 7.5 Tf 1 0 0 1 %d %d Tm (%s) Tj" % (MARGIN, MARGIN - 20, _escape(footer)))
        parts.append(b"ET")
        return b"\n".join(parts)
