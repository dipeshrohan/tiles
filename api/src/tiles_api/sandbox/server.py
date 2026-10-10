"""The sandbox for models from GitHub (T4.15): `tiles-sandbox`, a small HTTP service the API and its
jobs call to evaluate such a model. Each evaluation runs in a new process (child.py) with the
standard library only, resource limits (CPU time, memory, open files, no new processes) and an
audit hook, from the model's code as the API fetched it at a pinned commit.

`POST /run` with `Authorization: Bearer <TILES_SANDBOX_TOKEN>` and

    {"code_sha256": "<hex>", "code": "<base64 zip, only when asked>", "entry": "model.py",
     "inputs": {...}, "params": {...}}

answers `{"outputs": {...}}`; 409 asks for the code (it is kept by its digest from then on); 422
says why the model failed (an exception, the time or memory limit); 401 a wrong token. `GET
/health` is for probes.

It is deployed with no network out, no credentials but its token, a read-only filesystem and a
non-root user (deploy/helm/tiles/templates/sandbox.yaml); a runtime class such as gVisor can be set
for a stronger wall. Standard library only.
"""

import base64
import binascii
import hashlib
import hmac
import io
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

CHILD = Path(__file__).with_name("child.py")
MAX_BODY = 32 * 1024 * 1024
MAX_REPLY = 32 * 1024 * 1024  # what a model may print as its reply
MAX_CACHED = 200  # models' code kept unpacked; the least recently used goes first
MAX_CODE_BYTES = 1024 * 1024  # unpacked, per model
MAX_FILES = 200
SHA = re.compile(r"^[0-9a-f]{64}$")
ENTRY = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}\.py$")


class Settings:
    """From the environment: TILES_SANDBOX_TOKEN (required; an environment variable, not a file, so
    nothing a model can open holds it), _HOST, _PORT, _TIMEOUT (seconds per evaluation), _MEMORY_MB,
    _DIR (where code is unpacked) and _WORKERS (evaluations at once)."""

    def __init__(self, env: dict[str, str] | None = None) -> None:
        env = dict(os.environ if env is None else env)
        self.token = env.get("TILES_SANDBOX_TOKEN", "")
        if len(self.token) < 16:
            raise SystemExit("Set TILES_SANDBOX_TOKEN to a secret of at least 16 characters")
        self.host = env.get("TILES_SANDBOX_HOST", "127.0.0.1")
        self.port = int(env.get("TILES_SANDBOX_PORT", "8100"))
        self.timeout = float(env.get("TILES_SANDBOX_TIMEOUT", "5"))
        self.memory_mb = int(env.get("TILES_SANDBOX_MEMORY_MB", "512"))
        self.workers = int(env.get("TILES_SANDBOX_WORKERS", str(os.cpu_count() or 2)))
        self.dir = Path(env.get("TILES_SANDBOX_DIR") or tempfile.mkdtemp(prefix="tiles-sandbox-"))


class Refused(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def unpack(settings: Settings, sha: str, code_b64: str) -> Path:
    """The model's code, unpacked once by its digest: Python and JSON files only, read-only."""
    try:
        raw = base64.b64decode(code_b64, validate=True)
    except (binascii.Error, ValueError):
        raise Refused(400, "code must be base64") from None
    if hashlib.sha256(raw).hexdigest() != sha:
        raise Refused(400, "code doesn't match code_sha256")
    target = settings.dir / sha
    if target.is_dir():
        return target
    _evict(settings)
    staging = Path(tempfile.mkdtemp(dir=settings.dir, prefix=".unpack-"))
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            members = z.infolist()
            if len(members) > MAX_FILES or sum(m.file_size for m in members) > MAX_CODE_BYTES:
                raise Refused(400, "the model's code is too large")
            for m in members:
                name = m.filename
                if m.is_dir():
                    continue
                parts = Path(name).parts
                if name.startswith("/") or ".." in parts or not name.endswith((".py", ".json")):
                    raise Refused(400, f"the model's code can't hold {name!r}")
                dest = staging / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(z.read(m))
                dest.chmod(0o444)
        try:
            staging.rename(target)
        except OSError:  # unpacked at the same time by another request
            shutil.rmtree(staging, ignore_errors=True)
        return target
    except zipfile.BadZipFile:
        raise Refused(400, "code must be a zip") from None
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def _evict(settings: Settings) -> None:
    """Keeps at most MAX_CACHED models' code, dropping the least recently used."""
    kept = sorted((p for p in settings.dir.iterdir() if SHA.match(p.name)), key=lambda p: p.stat().st_mtime)
    for old in kept[: max(0, len(kept) - MAX_CACHED + 1)]:
        for f in old.rglob("*"):
            if f.is_file():
                f.chmod(0o644)
        shutil.rmtree(old, ignore_errors=True)


def _run_child(settings: Settings, code_dir: Path, request: bytes) -> tuple[int, bytes]:
    """The child's exit code and reply. Its stdout is read up to MAX_REPLY (a model that prints
    more is stopped); its stderr is dropped; it is killed at the timeout."""
    proc = subprocess.Popen(  # noqa: S603 - this interpreter, the sandbox's own child script
        [sys.executable, "-I", "-S", str(CHILD)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        cwd=code_dir,
        env={},
        start_new_session=True,
    )
    assert proc.stdin is not None and proc.stdout is not None  # noqa: S101 - set just above
    out: list[bytes] = []
    too_much = threading.Event()

    def read() -> None:
        size = 0
        assert proc.stdout is not None  # noqa: S101 - set above
        while chunk := proc.stdout.read(64 * 1024):
            size += len(chunk)
            if size > MAX_REPLY:
                too_much.set()
                proc.kill()
                return
            out.append(chunk)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        proc.stdin.write(request)
        proc.stdin.close()
    except BrokenPipeError:  # it ended before reading: its exit says why
        pass
    try:
        code = proc.wait(timeout=settings.timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise Refused(422, f"The model took longer than {settings.timeout:g} s") from None
    finally:
        reader.join(timeout=5)
        proc.stdout.close()
    if too_much.is_set():
        raise Refused(422, "The model wrote more than 32 MB")
    return code, b"".join(out)


def evaluate(settings: Settings, body: dict[str, Any], slots: threading.BoundedSemaphore) -> bytes:
    sha = body.get("code_sha256")
    entry = body.get("entry")
    if not isinstance(sha, str) or not SHA.match(sha):
        raise Refused(400, "code_sha256 must be a SHA-256 in hex")
    if not isinstance(entry, str) or not ENTRY.match(entry) or ".." in entry.split("/"):
        raise Refused(400, "entry must be a .py file in the model's directory")
    code_dir = settings.dir / sha
    if "code" in body:
        code_dir = unpack(settings, sha, str(body["code"]))
    elif not code_dir.is_dir():
        raise Refused(409, "send the code")
    else:
        os.utime(code_dir)  # recently used: the last to be evicted
    request = json.dumps(
        {
            "entry": entry,
            "inputs": body.get("inputs", {}),
            "params": body.get("params", {}),
            # The child sets them on itself before the model's code runs (preexec_fn isn't safe in a
            # threaded server).
            "limits": {"cpu_s": int(settings.timeout) + 1, "memory_mb": settings.memory_mb},
        }
    )
    with slots:
        code, stdout = _run_child(settings, code_dir, request.encode())
    if code == 0:
        return stdout
    try:
        error = json.loads(stdout).get("error")
    except (ValueError, AttributeError):
        error = None
    if isinstance(error, str):
        raise Refused(422, f"The model failed: {error}")
    if code < 0:
        try:
            why = signal.Signals(-code).name
        except ValueError:
            why = f"signal {-code}"
        raise Refused(422, f"The model was stopped ({why}): it used more than its CPU time or memory")
    raise Refused(422, f"The model failed (exit code {code})")


def make_server(settings: Settings) -> ThreadingHTTPServer:
    slots = threading.BoundedSemaphore(settings.workers)
    expected = f"Bearer {settings.token}".encode()

    class Handler(BaseHTTPRequestHandler):
        server_version = "tiles-sandbox"
        sys_version = ""

        def reply(self, status: int, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/health":
                self.reply(200, b'{"status": "ok"}')
            else:
                self.reply(404, b'{"detail": "Not found"}')

        def do_POST(self) -> None:
            try:
                if self.path != "/run":
                    raise Refused(404, "Not found")
                given = (self.headers.get("Authorization") or "").encode()
                if not hmac.compare_digest(given, expected):
                    raise Refused(401, "Wrong token")
                try:
                    size = int(self.headers.get("Content-Length") or 0)
                except ValueError:
                    raise Refused(400, "Content-Length must be a number") from None
                if not 0 < size <= MAX_BODY:
                    raise Refused(413, "The request is empty or larger than 32 MB")
                try:
                    body = json.loads(self.rfile.read(size))
                except ValueError:
                    raise Refused(400, "The request must be JSON") from None
                if not isinstance(body, dict):
                    raise Refused(400, "The request must be a JSON object")
                self.reply(200, evaluate(settings, body, slots))
            except Refused as e:
                self.reply(e.status, json.dumps({"detail": e.detail}).encode())
            except Exception as e:  # the sandbox's own failure (its disk full, say): said, and logged
                self.log_message("failed: %s", repr(e))
                self.reply(500, json.dumps({"detail": f"The sandbox failed: {type(e).__name__}"}).encode())

        def log_message(self, format: str, *args: Any) -> None:
            sys.stderr.write(json.dumps({"logger": "tiles_sandbox", "message": format % args}) + "\n")

    return ThreadingHTTPServer((settings.host, settings.port), Handler)


def _not_dumpable() -> None:
    """On Linux, makes this process's memory and /proc/<pid>/environ unreadable by other processes
    of its user, the models' among them: the token stays the server's own."""
    if sys.platform != "linux":
        return
    import ctypes  # the server's own use; models may not import it

    pr_set_dumpable = 4
    ctypes.CDLL(None, use_errno=True).prctl(pr_set_dumpable, 0, 0, 0, 0)


def main() -> None:
    """tiles-sandbox: serves evaluations of models from GitHub, each in a sandboxed process."""
    _not_dumpable()
    settings = Settings()
    settings.dir.mkdir(parents=True, exist_ok=True)
    server = make_server(settings)
    print(json.dumps({"logger": "tiles_sandbox", "message": f"listening on {settings.host}:{settings.port}"}))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
