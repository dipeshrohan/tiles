import json
import ssl
import subprocess
import threading
from collections.abc import Generator, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

TOKEN = "tla_test-token-0123456789"


@dataclass
class FakeTiles:
    """A stand-in for the Tiles API's /agent/heartbeat, on a free local port."""

    url: str = ""
    requests: list[dict[str, Any]] = field(default_factory=list)
    # What to answer next: (status, body) or (status, body, headers). The last one repeats.
    answers: list[tuple[Any, ...]] = field(default_factory=lambda: [(200, None)])
    heartbeat_seen: threading.Event = field(default_factory=threading.Event)

    def answer(self) -> tuple[Any, ...]:
        return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]


def serve(fake: FakeTiles, context: ssl.SSLContext | None = None) -> Generator[FakeTiles]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            fake.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
            status, answer, *rest = fake.answer()
            headers: dict[str, str] = rest[0] if rest else {}
            if answer is None:
                answer = {"agent_id": "a-1", "site_id": "s-1", "server_time": "2026-10-07T12:00:00Z", "commands": []}
            raw = answer if isinstance(answer, bytes) else json.dumps(answer).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            fake.heartbeat_seen.set()

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    scheme = "http"
    if context:
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    fake.url = f"{scheme}://localhost:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield fake
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def tiles() -> Iterator[FakeTiles]:
    yield from serve(FakeTiles())


@pytest.fixture(scope="session")
def certificate(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    """A self-signed certificate for localhost, as (cert, key)."""
    folder = tmp_path_factory.mktemp("tls")
    cert, key = folder / "cert.pem", folder / "key.pem"
    subprocess.run(  # noqa: S603 - fixed arguments
        [  # noqa: S607 - openssl from PATH, as on CI runners
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
            "-keyout", str(key), "-out", str(cert),
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip
    return cert, key


@pytest.fixture
def tls_tiles(certificate: tuple[Path, Path]) -> Iterator[FakeTiles]:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(*certificate)
    yield from serve(FakeTiles(), context)


def write_config(folder: Path, url: str, extra: str = "", token: str | None = TOKEN) -> Path:
    if token is not None:
        (folder / "token").write_text(token + "\n")
    path = folder / "tiles-edge.toml"
    path.write_text(f'[tiles]\nurl = "{url}"\ntoken_file = "token"\n{extra}\n[agent]\nheartbeat_seconds = 5\n')
    return path
