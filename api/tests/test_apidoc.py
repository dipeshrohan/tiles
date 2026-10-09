"""The API reference (T6.05) stays in step with the code."""

from pathlib import Path

from fastapi.routing import APIRoute

from tiles_api import apidoc
from tiles_api.main import create_app
from tiles_api.settings import Settings


def test_the_committed_reference_is_current() -> None:
    for name, text in apidoc.documents().items():
        path = apidoc.DOCS / name
        assert path.exists() and path.read_text() == text, (
            f"docs/guides/{name} is out of date: run `uv run tiles-apidoc`"
        )


def test_who_may_call_comes_from_the_dependencies() -> None:
    app = create_app(Settings(_env_file=None))
    by_route = {(r.path, m): apidoc.caller(r) for r in apidoc.routes(app) for m in (r.methods or set())}
    assert by_route[("/health", "GET")] == "anyone"
    assert by_route[("/sites", "GET")] == "signed in"
    assert by_route[("/sites/{site_id}/signals", "GET")] == "site member"
    assert by_route[("/sites/{site_id}/ontology/commits", "POST")] == "engineer"
    assert by_route[("/sites/{site_id}/agents", "POST")] == "admin"
    assert by_route[("/agent/samples", "POST")] == "edge agent"
    # Every endpoint is in the reference.
    text = apidoc.markdown(app)
    for r in apidoc.routes(app):
        if isinstance(r, APIRoute) and r.include_in_schema:
            for m in (r.methods or set()) & set(apidoc.METHODS):
                assert f"### `{m} {r.path}`" in text


def test_every_endpoint_says_what_it_does() -> None:
    app = create_app(Settings(_env_file=None))
    bare = [r.path for r in apidoc.routes(app) if r.include_in_schema and not (r.endpoint.__doc__ or "").strip()]
    assert bare == [], "give these endpoints a docstring: it is their entry in docs/guides/api.md"


def test_writes_both_files(tmp_path: Path) -> None:
    apidoc.main(["--out", str(tmp_path)])
    assert sorted(p.name for p in tmp_path.iterdir()) == ["api.md", "openapi.json"]
