"""The sandbox for models from GitHub (T4.15): each evaluation in a new process, the standard
library only, within limits, refused the network, other processes, writes and other files."""

import base64
import hashlib
import io
import json
import threading
import urllib.error
import urllib.request
import zipfile
from collections.abc import Iterator
from typing import Any

import pytest

from tiles_api.sandbox import server

TOKEN = "sandbox-token-for-tests"  # noqa: S105 - a test token


def zipped(files: dict[str, str]) -> tuple[str, str]:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)
    raw = out.getvalue()
    return hashlib.sha256(raw).hexdigest(), base64.b64encode(raw).decode()


@pytest.fixture(scope="module")
def sandbox(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    settings = server.Settings(
        {
            "TILES_SANDBOX_TOKEN": TOKEN,
            "TILES_SANDBOX_PORT": "0",
            "TILES_SANDBOX_TIMEOUT": "2",
            "TILES_SANDBOX_MEMORY_MB": "256",
            "TILES_SANDBOX_DIR": str(tmp_path_factory.mktemp("sandbox")),
        }
    )
    httpd = server.make_server(settings)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def call(url: str, body: dict[str, Any], token: str = TOKEN) -> tuple[int, dict[str, Any]]:
    req = urllib.request.Request(  # noqa: S310 - the test's own server
        f"{url}/run",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:  # noqa: S310
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e:
        with e:
            return e.code, json.loads(e.read())


def run(url: str, source: str, params: dict[str, float] | None = None, **files: str) -> tuple[int, dict[str, Any]]:
    sha, code = zipped({"model.py": source, **files})
    body = {"code_sha256": sha, "code": code, "entry": "model.py", "inputs": {}, "params": params or {}}
    return call(url, body)


def test_a_model_runs_with_the_standard_library_and_its_own_modules(sandbox: str) -> None:
    source = (
        "import math\nfrom helpers import twice\n"
        "def run(inputs, params):\n    return {'y': [twice(math.sqrt(params['a']))]}\n"
    )
    assert run(sandbox, source, {"a": 9}, **{"helpers.py": "def twice(x):\n    return 2 * x\n"}) == (
        200,
        {"outputs": {"y": [6.0]}},
    )
    # What the model prints doesn't mix with the reply; NaN is null.
    noisy = "def run(i, p):\n    print('hello')\n    return {'y': [float('nan'), 1]}\n"
    assert run(sandbox, noisy) == (200, {"outputs": {"y": [None, 1]}})


def test_code_is_sent_once_then_kept_by_its_digest(sandbox: str) -> None:
    sha, code = zipped({"model.py": "def run(i, p):\n    return {'y': [p['a'] + 1]}\n"})
    body = {"code_sha256": sha, "entry": "model.py", "inputs": {}, "params": {"a": 1}}
    assert call(sandbox, body) == (409, {"detail": "send the code"})
    assert call(sandbox, body | {"code": code})[0] == 200
    assert call(sandbox, body) == (200, {"outputs": {"y": [2]}})
    # Code that isn't what its digest says is refused.
    assert call(sandbox, body | {"code_sha256": "0" * 64, "code": code}) == (
        400,
        {"detail": "code doesn't match code_sha256"},
    )


@pytest.mark.parametrize(
    ("source", "why"),
    [
        ("import socket\ndef run(i, p):\n    return {}\n", "models may not import socket"),
        ("import urllib.request\ndef run(i, p):\n    return {}\n", "models may not import urllib"),
        ("import subprocess\ndef run(i, p):\n    return {}\n", "models may not import subprocess"),
        ("import ctypes\ndef run(i, p):\n    return {}\n", "models may not import ctypes"),
        ("import os\ndef run(i, p):\n    os.system('id')\n", "models may not use os.system"),
        ("import os\ndef run(i, p):\n    os.fork()\n", "models may not use os.fork"),
        ("def run(i, p):\n    open('out.txt', 'w')\n", "models may not write files"),
        ("def run(i, p):\n    open('/etc/passwd').read()\n", "may read only their own directory, not /etc/passwd"),
        ("def run(i, p):\n    open('/proc/self/environ').read()\n", "may read only their own directory"),
        ("import os\ndef run(i, p):\n    os.listdir('/')\n", "may list only their own directory"),
        (
            "import resource\ndef run(i, p):\n    resource.setrlimit(resource.RLIMIT_CPU, (9, 9))\n",
            "models may not use resource.setrlimit",
        ),
        ("def run(i, p):\n    1 / 0\n", "ZeroDivisionError: division by zero"),
        ("def go(i, p):\n    return {}\n", "has no run(inputs, params) function"),
        ("def run(i, p):\n    return [1]\n", "run must return a dict"),
    ],
)
def test_what_a_model_may_not_do_is_refused(sandbox: str, source: str, why: str) -> None:
    status, reply = run(sandbox, source)
    assert status == 422, reply
    assert why in reply["detail"]


def test_time_and_memory_are_limited(sandbox: str) -> None:
    status, reply = run(sandbox, "def run(i, p):\n    while True:\n        pass\n")
    assert (status, reply["detail"]) == (422, "The model took longer than 2 s")
    status, reply = run(sandbox, "def run(i, p):\n    return {'y': [len(bytearray(10**9))]}\n")
    assert status == 422 and "MemoryError" in reply["detail"]


def test_requests_are_checked(sandbox: str) -> None:
    sha, code = zipped({"model.py": "def run(i, p):\n    return {}\n"})
    body = {"code_sha256": sha, "code": code, "entry": "model.py"}
    assert call(sandbox, body, token="wrong")  # noqa: S106 - a wrong token[0] == 401
    assert call(sandbox, body | {"entry": "../model.py"})[0] == 400
    assert call(sandbox, body | {"entry": "/etc/model.py"})[0] == 400
    assert call(sandbox, body | {"code": "not base64!"})[0] == 400
    sha, code = zipped({"../escape.py": "x = 1\n", "model.py": ""})
    assert call(sandbox, body | {"code_sha256": sha, "code": code}) == (
        400,
        {"detail": "the model's code can't hold '../escape.py'"},
    )
    sha, code = zipped({"model.py": "", "tool.sh": "rm -rf /"})
    assert (
        call(sandbox, body | {"code_sha256": sha, "code": code})[1]["detail"] == "the model's code can't hold 'tool.sh'"
    )
    with urllib.request.urlopen(f"{sandbox}/health", timeout=5) as res:  # noqa: S310
        assert json.loads(res.read()) == {"status": "ok"}


def test_the_sandbox_wont_start_without_a_token() -> None:
    with pytest.raises(SystemExit, match="TILES_SANDBOX_TOKEN"):
        server.Settings({"TILES_SANDBOX_TOKEN": "short"})


def test_a_model_printing_too_much_is_stopped(sandbox: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "MAX_REPLY", 10_000)
    status, reply = run(sandbox, "import os\ndef run(i, p):\n    os.write(1, b'x' * 100_000)\n    return {}\n")
    assert (status, reply["detail"]) == (422, "The model wrote more than 32 MB")


def test_the_guard_isnt_undone_by_replacing_what_it_calls(sandbox: str) -> None:
    source = (
        "import os, os.path\n"
        "def run(i, p):\n"
        "    os.path.realpath = lambda path: os.getcwd() + '/model.py'\n"
        "    os.fsdecode = lambda path: os.getcwd() + '/model.py'\n"
        "    return {'y': [len(open('/etc/passwd').read())]}\n"
    )
    status, reply = run(sandbox, source)
    assert status == 422 and "not /etc/passwd" in reply["detail"]


def test_code_kept_is_bounded_least_recently_used_first(sandbox: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "MAX_CACHED", 2)
    bodies = []
    for n in range(3):
        sha, code = zipped({"model.py": f"def run(i, p):\n    return {{'y': [{n}]}}\n"})
        body = {"code_sha256": sha, "entry": "model.py", "inputs": {}, "params": {}}
        assert call(sandbox, body | {"code": code}) == (200, {"outputs": {"y": [n]}})
        bodies.append(body)
    assert call(sandbox, bodies[0])[0] == 409  # the oldest went
    assert call(sandbox, bodies[2])[0] == 200


def test_the_sandboxs_own_failure_is_a_500(sandbox: str, monkeypatch: pytest.MonkeyPatch) -> None:
    def full(*_args: Any) -> Any:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(server, "unpack", full)
    assert run(sandbox, "def run(i, p):\n    return {}\n") == (500, {"detail": "The sandbox failed: OSError"})


def test_the_server_keeps_its_environment_to_itself() -> None:
    """Its token is in its environment: made unreadable to other processes of its user (Linux)."""
    import subprocess
    import sys

    probe = (
        "import ctypes\nfrom tiles_api.sandbox.server import _not_dumpable\n_not_dumpable()\n"
        "print(ctypes.CDLL(None).prctl(3, 0, 0, 0, 0))\n"  # PR_GET_DUMPABLE
    )
    out = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, check=True)  # noqa: S603
    assert out.stdout.strip() == "0"
