"""The API reference (T6.05): docs/guides/api.md and docs/guides/openapi.json, made from the app.

`tiles-apidoc` writes both; a test fails when either is out of date, so the reference changes with
the code. The Markdown lists every endpoint by area, with who may call it (read from its
dependencies: the role it requires, a site member, any signed-in user, an edge agent or anyone),
its parameters and its description (the endpoint's docstring).
"""

import argparse
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.routing import APIRoute

from tiles_api.main import create_app
from tiles_api.settings import Settings

# In a checkout: the repository's docs/guides (elsewhere, pass --out).
DOCS = Path(__file__).resolve().parents[3] / "docs" / "guides"
METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")

INTRO = """# API reference

The Tiles API serves the browser app, edge agents and your own integrations. This reference is
generated from the code (`tiles-apidoc`, T6.05); the machine-readable description is
[openapi.json](openapi.json), and a running API shows it interactively at `/docs`.

## Conventions

- **Addresses.** Every path below is relative to the API's address (for example
  `https://api.tiles.example.com`). Most live under a site: `/sites/{site_id}/…`; `GET /sites`
  lists the sites you can see.
- **Signing in.** Send the access token from your OpenID Connect provider as
  `Authorization: Bearer <token>`. Outside production, a request without a token acts as a
  development user (`X-Tiles-User: someone@example.com` picks which).
- **Who may call.** Each endpoint says who may call it:
  - *anyone*: no sign-in;
  - *signed in*: any user;
  - *site member*: any role on the site, viewer and up;
  - *engineer* or *admin*: that role on the site or above. Organisation admins are admins of
    every site.
  - *edge agent*: an agent's own token, `Authorization: Bearer tla_…`.

  Some endpoints narrow this further (only an insight's author, a review's named reviewer); their
  description says so, and anyone else gets a `403`.
- **Bodies** are JSON, with times in ISO 8601 with a time zone. Unknown fields are refused.
- **Errors** answer with a status and `{"detail": "…"}`, in words meant for people:
  - `401`: sign in;
  - `403`: your role isn't enough;
  - `404`: no such thing on this site;
  - `409`: a conflict, for example a newer commit;
  - `422`: an invalid request, with each problem listed;
  - `503`: busy or unreachable. `Retry-After` says when to try again.
- **Lists** take `limit` and `offset` where they can be long.
- **Request ids.** Every answer carries `X-Request-ID`; quote it when you report a problem.
  You may send your own.
- **Changes** follow [semantic versioning](../releasing.md): within a major version, endpoints
  and fields are only added.
"""


def routes(app: FastAPI) -> Iterator[APIRoute]:
    """Every endpoint, including those of included routers."""

    def walk(items: list[Any]) -> Iterator[APIRoute]:
        for r in items:
            if isinstance(r, APIRoute):
                yield r
            elif hasattr(r, "original_router"):
                yield from walk(r.original_router.routes)

    yield from walk(list(app.routes))


PUBLIC = {"/health", "/ready", "/auth/config"}  # open by design; anything else must sign in


def caller(route: APIRoute) -> str:
    """Who may call an endpoint, from the dependencies it takes. An endpoint that is neither public
    nor recognised raises, so a new way of authenticating can't be listed as open to anyone."""
    if route.path.startswith("/agent/"):
        return "edge agent"  # its handler checks the agent's token (api_agents.calling_agent)
    calls: list[Any] = []

    def walk(dependant: Any) -> None:
        for d in dependant.dependencies:
            calls.append(d.call)
            walk(d)

    walk(route.dependant)
    roles = [getattr(c, "minimum_role", None) for c in calls]
    if "organisation admin" in roles:
        return "organisation admin"
    if "admin" in roles:
        return "admin"
    if "engineer" in roles:
        return "engineer"
    names = {getattr(c, "__name__", "") for c in calls}
    if "site_context" in names:
        return "site member"
    if "authenticate" in names:
        return "signed in"
    if route.path in PUBLIC:
        return "anyone"
    raise ValueError(f"{route.path}: who may call it? Add its sign-in check to apidoc.caller")


def _schema_type(schema: dict[str, Any]) -> str:
    if "$ref" in schema:
        return str(schema["$ref"]).rsplit("/", 1)[-1]
    if "anyOf" in schema:
        return " or ".join(_schema_type(s) for s in schema["anyOf"] if s.get("type") != "null")
    if schema.get("type") == "array":
        return f"list of {_schema_type(schema.get('items', {}))}"
    if "enum" in schema:
        return " | ".join(f"`{v}`" for v in schema["enum"])
    return str(schema.get("format") or schema.get("type") or "any")


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def markdown(app: FastAPI) -> str:
    spec = app.openapi()
    by_tag: dict[str, list[tuple[str, str, APIRoute]]] = {}
    for route in routes(app):
        if not route.include_in_schema:
            continue
        for method in sorted((route.methods or set()) & set(METHODS), key=METHODS.index):
            tag = (route.tags or ["other"])[0]
            by_tag.setdefault(str(tag), []).append((route.path, method, route))
    out = [INTRO, "## Endpoints by area", ""]
    out.append(" · ".join(f"[{tag}](#{tag.replace(' ', '-').lower()})" for tag in sorted(by_tag)))
    for tag in sorted(by_tag):
        out += ["", f"## {tag}"]
        for path, method, route in sorted(by_tag[tag], key=lambda e: (e[0], METHODS.index(e[1]))):
            op = spec["paths"][path][method.lower()]
            out += ["", f"### `{method} {path}`", ""]
            out.append(f"**Who:** {caller(route)}. **Answers:** {', '.join(sorted(op.get('responses', {})))}.")
            doc = (route.description or route.summary or "").strip()
            if doc:
                out += ["", " ".join(line.strip() for line in doc.splitlines() if line.strip())]
            params = [p for p in op.get("parameters", []) if p["in"] in ("query", "path")]
            if params:
                out += ["", "| Parameter | In | Type | Required |", "|---|---|---|---|"]
                for p in params:
                    t = _schema_type(p.get("schema", {}))
                    req = "yes" if p.get("required") else "no"
                    out.append(f"| `{p['name']}` | {p['in']} | {_cell(t)} | {req} |")
            body = op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema")
            if body:
                out += ["", f"**Body:** {_schema_type(body)} (see [openapi.json](openapi.json))."]
    return "\n".join(out).rstrip() + "\n"


def documents() -> dict[str, str]:
    """The files' contents, by name."""
    app = create_app(Settings(_env_file=None, env="test"))  # whatever the shell's TILES_ENV
    spec = json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"
    return {"api.md": markdown(app), "openapi.json": spec}


def main(argv: list[str] | None = None) -> None:
    """`tiles-apidoc`: writes the API reference into docs/guides (or `--out`)."""
    parser = argparse.ArgumentParser(prog="tiles-apidoc", description=main.__doc__)
    parser.add_argument("--out", type=Path, default=DOCS)
    args = parser.parse_args(argv)
    if args.out == DOCS and not (DOCS.parent / "TASKS.md").exists():
        parser.error(f"{DOCS} isn't a Tiles checkout's docs/guides: pass --out")
    args.out.mkdir(parents=True, exist_ok=True)
    for name, text in documents().items():
        (args.out / name).write_text(text, encoding="utf-8")
        print(f"wrote {args.out / name}")
