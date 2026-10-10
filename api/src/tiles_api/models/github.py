"""Models from GitHub (T4.15): an organisation's model version whose code is in a repository, at a
pinned commit, and runs in the sandbox (`tiles-sandbox`, sandbox/server.py), never in the API.

At registration the API fetches the commit's archive once (`fetch`), takes the model's directory:
its `tiles-model.json` (the spec, and the `entry` file, `model.py` unless named) and its Python
files (`pack`, into a zip with a SHA-256), and keeps them. Each evaluation sends the sandbox the
digest (and the code itself, the first time it asks), the inputs and the parameters; the reply is
checked like an HTTP model's (remote.py).

The entry file defines `run(inputs, params)`: `inputs` maps each input's name to a list of numbers
(none for a design model), `params` each parameter's name to a number; it returns a dict of each
output's name to a list of numbers (or None). The standard library only: no packages.
"""

import base64
import functools
import hashlib
import http.client
import io
import json
import re
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from tiles_api.models.registry import ModelSpec
from tiles_api.models.remote import Post, RemoteError, outputs_of, post
from tiles_api.sandbox.server import ENTRY
from tiles_api.settings import Settings

SOURCE = "github"
SPEC_FILE = "tiles-model.json"
REPO = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
PATH = re.compile(r"^(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]*$")
MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_CODE_BYTES = 1024 * 1024  # the model's directory, unpacked
MAX_FILES = 200
# Where archives come from: the API, which redirects to its download host.
API_HOST = "api.github.com"
DOWNLOAD_HOST = "codeload.github.com"


class GithubError(ValueError):
    """The repository, commit or directory can't be used, said in words for the person registering."""


def check_source(repo: str, commit: str, path: str) -> str:
    """The model's directory, normalised ('' for the repository's root), or a GithubError."""
    if not REPO.match(repo):
        raise GithubError("repo must be owner/name")
    if not COMMIT.match(commit):
        raise GithubError("commit must be a full 40-character commit SHA, so the code can't change")
    path = path.strip("/")
    if not PATH.match(path) or ".." in path.split("/") or "." in path.split("/"):
        raise GithubError("path must be a directory in the repository, such as models/beam")
    return path


class _OnlyToDownloads(urllib.request.HTTPRedirectHandler):
    """GitHub's API answers an archive with a redirect to its download host; nothing else is followed."""

    def redirect_request(
        self, req: urllib.request.Request, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> urllib.request.Request | None:
        parts = urllib.parse.urlsplit(newurl)
        if parts.scheme != "https" or parts.hostname != DOWNLOAD_HOST:
            raise urllib.error.HTTPError(req.full_url, code, "redirected away from GitHub", headers, fp)
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None:
            new.remove_header("Authorization")  # the download URL carries its own short-lived token
        return new


_opener = urllib.request.build_opener(_OnlyToDownloads)

# (repo, commit, token, timeout) -> the archive as a gzipped tar; tests replace it.
Fetch = Callable[[str, str, str | None, float], bytes]


def fetch(repo: str, commit: str, token: str | None, timeout: float) -> bytes:
    """The commit's archive from GitHub (a token is needed for a private repository; it is used for
    this request only)."""
    url = f"https://{API_HOST}/repos/{repo}/tarball/{commit}"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "tiles-api"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    deadline = time.monotonic() + timeout
    req = urllib.request.Request(url, headers=headers)
    try:
        with _opener.open(req, timeout=timeout) as res:
            parts: list[bytes] = []
            size = 0
            while chunk := res.read1(256 * 1024):
                parts.append(chunk)
                size += len(chunk)
                if size > MAX_ARCHIVE_BYTES:
                    raise GithubError("The repository's archive is larger than 50 MB")
                if time.monotonic() > deadline:
                    raise TimeoutError
    except urllib.error.HTTPError as e:
        e.close()
        if e.code == 404:
            raise GithubError(f"GitHub has no commit {commit} in {repo} (or it is private: give a token)") from None
        raise GithubError(f"GitHub answered {e.code}") from None
    except (OSError, http.client.HTTPException) as e:
        raise GithubError(f"GitHub can't be reached ({type(e).__name__})") from None
    return b"".join(parts)


def pack(archive: bytes, path: str) -> tuple[dict[str, Any], bytes]:
    """The model's spec (its `tiles-model.json`) and its directory's Python files, zipped the same
    way every time (sorted, with fixed times), so the same commit gives the same digest."""
    files: dict[str, bytes] = {}
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            for member in tar:
                # GitHub's archives hold one top directory, <owner>-<repo>-<short sha>/.
                _, _, inside = member.name.partition("/")
                if not member.isfile() or not inside:
                    continue
                if path and not inside.startswith(path + "/"):
                    continue
                name = inside[len(path) + 1 :] if path else inside
                if not (name.endswith(".py") or name == SPEC_FILE):
                    continue
                if len(files) >= MAX_FILES:
                    raise GithubError(f"The model's directory has more than {MAX_FILES} Python files")
                total += member.size
                if total > MAX_CODE_BYTES:
                    raise GithubError("The model's Python files are larger than 1 MB")
                data = tar.extractfile(member)
                if data is not None:
                    files[name] = data.read()
    except (tarfile.TarError, EOFError, OSError) as e:
        raise GithubError(f"The repository's archive can't be read ({type(e).__name__})") from None
    where = f"{path}/{SPEC_FILE}" if path else SPEC_FILE
    raw_spec = files.get(SPEC_FILE)
    if raw_spec is None:
        raise GithubError(f"There is no {where} at that commit")
    try:
        spec = json.loads(raw_spec)
    except ValueError as e:
        raise GithubError(f"{where} isn't JSON: {e}") from None
    if not isinstance(spec, dict):
        raise GithubError(f"{where} must be a JSON object")
    entry = spec.get("entry", "model.py")
    if not isinstance(entry, str) or entry not in files or not ENTRY.match(entry) or ".." in entry.split("/"):
        raise GithubError(f"The entry file {entry!r} isn't in the model's directory (letters, digits, _ . / -)")
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(files):
            if name.endswith(".py"):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.external_attr = 0o444 << 16
                z.writestr(info, files[name])
    return spec | {"entry": entry}, out.getvalue()


def digest(code: bytes) -> str:
    return hashlib.sha256(code).hexdigest()


class SandboxModel:
    """A model version from GitHub, run by the sandbox. `code` is loaded when the model is found to
    run (None when it is only listed); the sandbox is sent it only when it asks."""

    def __init__(
        self,
        spec: ModelSpec,
        code_sha256: str,
        entry: str,
        code: bytes | None,
        org_id: uuid.UUID,
        settings: Settings,
        transport: Post | None = None,
    ) -> None:
        self.spec = spec
        self.code_sha256 = code_sha256
        self.entry = entry
        self.code = code
        self.org_id = org_id
        self.settings = settings
        self.transport = transport or functools.partial(post, who="The sandbox")

    def _call(self, body: dict[str, Any]) -> dict[str, list[float | None]]:
        url, token = self.settings.sandbox_url, self.settings.sandbox_token
        if not url or token is None:
            raise RemoteError("Models from GitHub need the sandbox: set TILES_SANDBOX_URL and TILES_SANDBOX_TOKEN")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token.get_secret_value()}",
            "User-Agent": "tiles-api",
        }
        data = json.dumps(body, allow_nan=False).encode()
        try:
            reply = self.transport(url.rstrip("/") + "/run", data, headers, self.settings.model_timeout)
        except RemoteError as e:
            # The model refused these inputs (422), or they are too large (413): that window is
            # skipped. Anything else (a wrong token, the code refused, the sandbox down) is the
            # deployment's to fix, so a binding waits rather than skipping windows.
            if e.status is not None and e.status not in (409, 413, 422):
                raise RemoteError(str(e), retry=True, status=e.status) from None
            raise
        return outputs_of(reply, who="The model")

    def run(self, inputs: Mapping[str, Sequence[float]], params: Mapping[str, float]) -> dict[str, list[float | None]]:
        body: dict[str, Any] = {
            "code_sha256": self.code_sha256,
            "entry": self.entry,
            "inputs": {k: list(v) for k, v in inputs.items()},
            "params": dict(params),
        }
        try:
            return self._call(body)
        except RemoteError as e:
            if e.status != 409 or self.code is None:  # 409: the sandbox hasn't the code yet
                raise
        return self._call(body | {"code": base64.b64encode(self.code).decode()})
