"""Models from GitHub (T4.15): registered from a repository at a pinned commit, their code kept,
and run in the sandbox like a built-in model, by every site of the organisation."""

import io
import json
import tarfile
import uuid
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ADMIN, ENG, VIEWER, site  # noqa: F401 - site is a fixture
from test_http_models import KEYS
from test_onboarding import make_org_admin
from test_sandbox import TOKEN, sandbox  # noqa: F401 - sandbox is a fixture

from tiles_api.main import create_app
from tiles_api.models import github, remote, store
from tiles_api.models.remote import RemoteError
from tiles_api.settings import Settings
from tiles_api.store import UNSCOPED

COMMIT = "0123456789abcdef0123456789abcdef01234567"
SPEC = {
    "key": "beam-fe",
    "version": "1.0.0",
    "name": "Beam (FE surrogate)",
    "kind": "design",
    "domain": "structures",
    "outputs": [{"name": "deflection", "unit": "mm", "per": "window"}],
    "params": [{"name": "load", "unit": "kN", "default": 2, "min": 0, "max": 10}],
}
MODEL = (
    "from stiffness import FACTOR\n\n"
    "def run(inputs, params):\n    return {'deflection': [params['load'] ** 2 * FACTOR]}\n"
)


def tarball(files: dict[str, str], top: str = "acme-models-0123456") -> bytes:
    """A commit's archive as GitHub gives it: one top directory holding the repository."""
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(f"{top}/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return out.getvalue()


def repo(spec: dict[str, Any] | None = None, **extra: str) -> dict[str, str]:
    return {
        "README.md": "# models",
        "models/beam/tiles-model.json": json.dumps(spec or SPEC),
        "models/beam/model.py": MODEL,
        "models/beam/stiffness.py": "FACTOR = 0.5\n",
        "models/other/model.py": "raise SystemExit\n",
        **extra,
    }


@pytest.fixture
def archive(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """What GitHub serves: set `files`; the fetches made are kept in `asked`."""
    served: dict[str, Any] = {"files": repo(), "asked": []}

    def fetch(name: str, commit: str, token: str | None, timeout: float) -> bytes:
        served["asked"].append((name, commit, token))
        if commit != COMMIT:
            raise github.GithubError(f"GitHub has no commit {commit} in {name} (or it is private: give a token)")
        return tarball(served["files"])

    monkeypatch.setattr(github, "fetch", fetch)
    return served


@pytest.fixture(scope="module")
def api(database_url: str, sandbox: str) -> Iterator[TestClient]:  # noqa: F811
    settings = Settings(
        _env_file=None,
        database_url=database_url,
        env="test",
        data_keys=KEYS,
        sandbox_url=sandbox,
        sandbox_token=TOKEN,
    )
    with TestClient(create_app(settings)) as client:
        yield client


@pytest.fixture
def admin(site: str, database_url: str) -> str:  # noqa: F811
    make_org_admin(database_url, "admin@example.com")
    with psycopg.connect(database_url, options=UNSCOPED) as conn:
        conn.execute("DELETE FROM design_runs WHERE model_id IN (SELECT id FROM models WHERE source <> 'builtin')")
        conn.execute("DELETE FROM sweeps WHERE model_id IN (SELECT id FROM models WHERE source <> 'builtin')")
        conn.execute("DELETE FROM models WHERE source <> 'builtin'")
    return site


def register(api: TestClient, **changes: Any) -> Any:
    body = {"repo": "acme/models", "commit": COMMIT, "path": "models/beam"} | changes
    return api.post("/org/models/github", headers=ADMIN, json=body)


def test_a_model_from_github_is_registered_and_run_in_the_sandbox(
    api: TestClient, admin: str, archive: dict[str, Any], database_url: str
) -> None:
    res = register(api, token="ghp_private")  # noqa: S106 - a test token
    assert res.status_code == 201, res.text
    shown = res.json()
    assert (shown["source"], shown["repo"], shown["commit"], shown["path"]) == (
        "github",
        "acme/models",
        COMMIT,
        "models/beam",
    )
    assert archive["asked"] == [("acme/models", COMMIT, "ghp_private")]  # the token is used once
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        row = conn.execute("SELECT code, code_sha256, entry FROM models WHERE key = 'beam-fe'").fetchone()
        assert row is not None
        audit = conn.execute(
            "SELECT after FROM audit_log WHERE action = 'model.register' ORDER BY at DESC LIMIT 1"
        ).fetchone()
    assert row["entry"] == "model.py" and row["code_sha256"] == shown["code_sha256"]
    assert audit is not None and "ghp_private" not in json.dumps(audit["after"])
    # Only the model's directory is kept: its Python files, not the rest of the repository.
    import zipfile

    with zipfile.ZipFile(io.BytesIO(bytes(row["code"]))) as z:
        assert sorted(z.namelist()) == ["model.py", "stiffness.py"]

    # Every site of the organisation tries it, runs it and sweeps it, in the sandbox.
    listed = {m["key"]: m for m in api.get(f"/sites/{admin}/models", headers=VIEWER).json()}
    assert listed["beam-fe"]["source"] == "github"
    res = api.post(f"/sites/{admin}/models/beam-fe/evaluate", headers=VIEWER, json={"params": {"load": 4}})
    assert (res.status_code, res.json()["outputs"]) == (200, {"deflection": [8.0]})
    run = api.post(f"/sites/{admin}/runs", headers=ENG, json={"model": "beam-fe", "params": {"load": 2}})
    assert (run.status_code, run.json()["output"]) == (201, {"deflection": 2.0})
    body = {"model": "beam-fe", "x": {"param": "load", "from": 0, "to": 2, "steps": 3}}
    sweep = api.post(f"/sites/{admin}/sweeps", headers=ENG, json=body).json()
    assert api.get(f"/sites/{admin}/sweeps/{sweep['id']}", headers=ENG).json()["result"]["grid"] == [[0.0, 0.5, 2.0]]


def test_the_same_commit_gives_the_same_code(archive: dict[str, Any]) -> None:
    first = github.pack(tarball(repo()), "models/beam")
    again = github.pack(tarball(repo(), top="acme-models-other"), "models/beam")
    assert first == again and github.digest(first[1]) == github.digest(again[1])


@pytest.mark.parametrize(
    ("changes", "files", "status", "why"),
    [
        ({"commit": "main"}, None, 422, "full 40-character commit SHA"),
        ({"repo": "not a repo"}, None, 422, "repo must be owner/name"),
        ({"path": "../etc"}, None, 422, "path must be a directory"),
        ({"commit": "f" * 40}, None, 422, "GitHub has no commit"),
        ({"path": "models/other"}, None, 422, "There is no models/other/tiles-model.json"),
        ({}, {"models/beam/tiles-model.json": "{nope"}, 422, "models/beam/tiles-model.json isn't JSON"),
        ({}, {"models/beam/tiles-model.json": json.dumps(SPEC | {"version": "1"})}, 422, "MAJOR.MINOR.PATCH"),
        ({}, {"models/beam/tiles-model.json": json.dumps(SPEC | {"color": "red"})}, 422, "color: Extra inputs"),
        ({}, {"models/beam/tiles-model.json": json.dumps(SPEC | {"entry": "gone.py"})}, 422, "'gone.py' isn't"),
        ({}, {"models/beam/tiles-model.json": json.dumps(SPEC | {"key": "plunger-friction"})}, 409, "built-in"),
    ],
)
def test_registrations_are_checked(
    api: TestClient,
    admin: str,
    archive: dict[str, Any],
    changes: dict[str, Any],
    files: dict[str, str] | None,
    status: int,
    why: str,
) -> None:
    if files:
        archive["files"] = repo() | files
    res = register(api, **changes)
    assert res.status_code == status, res.text
    assert why in res.json()["detail"]


def test_a_version_never_changes_and_has_no_endpoint(api: TestClient, admin: str, archive: dict[str, Any]) -> None:
    assert register(api).status_code == 201
    assert register(api).status_code == 409
    archive["asked"].clear()
    assert api.post("/org/models/github", headers=ENG, json={"repo": "a/b", "commit": COMMIT}).status_code == 403
    assert archive["asked"] == []  # only an organisation admin makes Tiles fetch anything
    path = "/org/models/beam-fe/1.0.0"
    res = api.patch(path, headers=ADMIN, json={"endpoint_url": "https://x.example.com"})
    assert (res.status_code, "has no endpoint or token" in res.json()["detail"]) == (422, True)
    assert api.patch(path, headers=ADMIN, json={"archived": True}).json()["archived_at"] is not None
    assert api.post(f"/sites/{admin}/models/beam-fe/evaluate", headers=VIEWER, json={}).status_code == 404


def test_the_models_failures_and_the_sandbox_being_down(
    api: TestClient, admin: str, archive: dict[str, Any], database_url: str
) -> None:
    archive["files"] = repo() | {
        "models/beam/model.py": "def run(inputs, params):\n    return {'deflection': [1 / 0]}\n"
    }
    assert register(api).status_code == 201
    res = api.post(f"/sites/{admin}/models/beam-fe/evaluate", headers=VIEWER, json={})
    assert res.status_code == 502
    assert res.json()["detail"] == "The sandbox answered 422: The model failed: ZeroDivisionError: division by zero"
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        org = conn.execute("SELECT org_id FROM sites WHERE id = %s", [admin]).fetchone()
        assert org is not None
        down = Settings(_env_file=None, env="test", sandbox_url="http://127.0.0.1:1", sandbox_token=TOKEN)
        model = store.find(conn, org["org_id"], down, "beam-fe")
        with pytest.raises(RemoteError) as e:
            model.run({}, {"load": 1.0})
        assert e.value.retry and "The sandbox can't be reached" in str(e.value)
        none = Settings(_env_file=None, env="test")
        with pytest.raises(RemoteError, match="need the sandbox"):
            store.find(conn, org["org_id"], none, "beam-fe").run({}, {"load": 1.0})


def test_a_deployment_without_a_sandbox_registers_none(database_url: str, admin: str, archive: dict[str, Any]) -> None:
    with TestClient(create_app(Settings(_env_file=None, database_url=database_url, env="test"))) as plain:
        res = register(plain)
    assert (res.status_code, "has no sandbox" in res.json()["detail"]) == (422, True)
    assert archive["asked"] == []  # nothing fetched


def test_github_redirects_only_to_its_download_host() -> None:
    import urllib.error
    import urllib.request

    handler = github._OnlyToDownloads()
    req = urllib.request.Request("https://api.github.com/repos/a/b/tarball/x", headers={"Authorization": "Bearer t"})
    new = handler.redirect_request(req, None, 302, "Found", {}, "https://codeload.github.com/a/b/legacy.tar.gz/x")
    assert new is not None and not new.has_header("Authorization")
    with pytest.raises(urllib.error.HTTPError):
        handler.redirect_request(req, None, 302, "Found", {}, "https://evil.example.com/x")
    with pytest.raises(urllib.error.HTTPError):
        handler.redirect_request(req, None, 302, "Found", {}, "http://codeload.github.com/x")


def test_a_models_bad_reply_is_the_models_and_the_deployments_failures_wait(
    api: TestClient, admin: str, archive: dict[str, Any]
) -> None:
    archive["files"] = repo() | {"models/beam/model.py": "def run(inputs, params):\n    return {'deflection': ['x']}\n"}
    assert register(api).status_code == 201
    res = api.post(f"/sites/{admin}/models/beam-fe/evaluate", headers=VIEWER, json={})
    assert res.json()["detail"] == "The model must give deflection as a list of numbers or nulls"

    def answered(status: int) -> Any:
        def transport(*_args: Any) -> bytes:
            raise RemoteError(f"The sandbox answered {status}", retry=False, status=status)

        return transport

    settings = Settings(_env_file=None, env="test", sandbox_url="http://sandbox", sandbox_token=TOKEN)
    for status, retry in ((401, True), (400, True), (500, True), (413, False), (422, False)):
        spec = remote.spec_of(SPEC | {"spec": SPEC})
        model = github.SandboxModel(spec, "0" * 64, "model.py", b"", uuid.uuid4(), settings, answered(status))
        with pytest.raises(RemoteError) as e:
            model.run({}, {"load": 1.0})
        assert e.value.retry is retry, status


@pytest.mark.parametrize("entry", ["my model.py", "-main.py", "../model.py"])
def test_an_entry_the_sandbox_would_refuse_is_refused_now(entry: str) -> None:
    files = repo(SPEC | {"entry": entry}) | {f"models/beam/{entry}": "def run(i, p):\n    return {}\n"}
    with pytest.raises(github.GithubError, match="isn't in the model's directory"):
        github.pack(tarball(files), "models/beam")
