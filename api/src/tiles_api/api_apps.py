"""App Studio (T6.10): apps are templates (app_templates.py) configured on a site, without code.

Anyone signed in lists the templates and their settings; anyone on a site lists its apps and runs
one, which answers from the signal's readings now; engineers create, change and archive them,
audited. Each app has a number per site (`#/apps/<number>` in the browser). An app keeps the
template version it was made with.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Response, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field

from tiles_api import api_series
from tiles_api.api_ontology import Auth, Ctx, Editor, SiteContext
from tiles_api.app_templates import TEMPLATES, ConfigError, Template, check_config
from tiles_api.store import one

router = APIRouter(tags=["apps"])

NAME = r"^\S(.*\S)?$"


class ParamOut(BaseModel):
    name: str
    label: str
    kind: Literal["signal", "number", "integer", "choice", "choices"]
    default: Any
    minimum: float | None
    maximum: float | None
    choices: list[tuple[str, str]] = Field(description="(value, label) for choice and choices")
    optional: bool
    help: str


class TemplateOut(BaseModel):
    id: str
    version: int
    title: str
    summary: str
    params: list[ParamOut]


class AppIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=120, pattern=NAME)]
    template: str
    config: dict[str, Any] = Field(description="The template's settings; defaults fill what is left out")


class AppUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=120, pattern=NAME)]
    config: dict[str, Any]


class AppOut(BaseModel):
    number: int
    name: str
    template: str
    template_version: int
    template_title: str
    config: dict[str, Any]
    signal_tag: str | None = Field(description="The tag of the app's signal, if it still exists")
    created_by: str
    created_at: datetime
    updated_at: datetime


class Level(BaseModel):
    label: str
    value: float


class Span(BaseModel):
    from_: datetime = Field(alias="from")
    to: datetime
    label: str


class Fact(BaseModel):
    label: str
    value: float
    format: Literal["number", "percent"]


class Point(BaseModel):
    at: datetime
    value: float


class ResultOut(BaseModel):
    app: AppOut
    status: Literal["ok", "alert", "no_data"]
    headline: str
    text: str
    signal_id: uuid.UUID
    tag: str
    unit: str | None
    start: datetime
    end: datetime
    gap_seconds: float = Field(description="Points further apart than this aren't joined")
    points: list[Point]
    levels: list[Level]
    spans: list[Span]
    facts: list[Fact]


APP_SQL = """
SELECT a.number, a.name, a.template, a.template_version, a.config, a.created_by, a.created_at, a.updated_at,
       s.tag AS signal_tag
FROM apps a LEFT JOIN signals s ON s.site_id = a.site_id AND s.id::text = a.config->>'signal'
WHERE a.site_id = %s AND a.archived_at IS NULL
"""


def _out(row: dict[str, Any]) -> dict[str, Any]:
    template = TEMPLATES.get(row["template"])
    return {**row, "template_title": template.title if template else row["template"]}


def _template(name: str) -> Template:
    template = TEMPLATES.get(name)
    if template is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"No template {name!r}")
    return template


def _config(ctx: SiteContext, template: Template, config: dict[str, Any]) -> dict[str, Any]:
    """The configuration checked, with its signals on this site."""
    try:
        clean = check_config(template, config)
    except ConfigError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "; ".join(e.problems)) from e
    for p in template.params:
        if p.kind == "signal" and clean[p.name] is not None:
            api_series.site_signal(ctx, uuid.UUID(clean[p.name]))
    return clean


def _app(ctx: SiteContext, number: int) -> dict[str, Any]:
    row: dict[str, Any] | None = ctx.conn.execute(f"{APP_SQL} AND a.number = %s", [ctx.site_id, number]).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such app on this site")
    return row


@router.get("/app-templates", response_model=list[TemplateOut])
def list_templates(_principal: Auth) -> list[dict[str, Any]]:
    """The templates an app can be made from, with their settings (what the form asks)."""
    return [t.describe() for t in TEMPLATES.values()]


@router.get("/sites/{site_id}/apps", response_model=list[AppOut])
def list_apps(ctx: Ctx) -> list[dict[str, Any]]:
    """The site's apps, by number."""
    return [_out(r) for r in ctx.conn.execute(f"{APP_SQL} ORDER BY a.number", [ctx.site_id]).fetchall()]


@router.post("/sites/{site_id}/apps", response_model=AppOut, status_code=status.HTTP_201_CREATED)
def create_app_(ctx: Editor, body: AppIn) -> dict[str, Any]:
    """Makes an app from a template's current version: 422 with what to fix if the settings don't
    fit it."""
    template = _template(body.template)
    config = _config(ctx, template, body.config)
    number = one(
        ctx.conn.execute(
            "INSERT INTO app_numbers (site_id, last) VALUES (%s, 1)"
            " ON CONFLICT (site_id) DO UPDATE SET last = app_numbers.last + 1 RETURNING last",
            [ctx.site_id],
        ).fetchone()
    )["last"]
    ctx.conn.execute(
        "INSERT INTO apps (site_id, number, name, template, template_version, config, created_by_id, created_by)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
        [ctx.site_id, number, body.name, template.id, template.version, Jsonb(config), ctx.user.id, ctx.user.name],
    )
    ctx.audit(
        "app.create",
        "app",
        str(number),
        after={"name": body.name, "template": template.id, "version": template.version, "config": config},
    )
    return _out(_app(ctx, number))


@router.put("/sites/{site_id}/apps/{number}", response_model=AppOut)
def update_app(ctx: Editor, number: int, body: AppUpdate) -> dict[str, Any]:
    """Renames an app or changes its settings, for the template version it was made with."""
    before = _app(ctx, number)
    template = _template(before["template"])
    if template.version != before["template_version"]:
        raise HTTPException(status.HTTP_409_CONFLICT, "This app's template version is no longer served")
    config = _config(ctx, template, body.config)
    ctx.conn.execute(
        "UPDATE apps SET name = %s, config = %s, updated_at = now() WHERE site_id = %s AND number = %s",
        [body.name, Jsonb(config), ctx.site_id, number],
    )
    ctx.audit(
        "app.update",
        "app",
        str(number),
        before={"name": before["name"], "config": before["config"]},
        after={"name": body.name, "config": config},
    )
    return _out(_app(ctx, number))


@router.delete("/sites/{site_id}/apps/{number}", status_code=status.HTTP_204_NO_CONTENT)
def archive_app(ctx: Editor, number: int) -> Response:
    """Archives an app: it leaves the list, and its number isn't reused."""
    before = _app(ctx, number)
    ctx.conn.execute("UPDATE apps SET archived_at = now() WHERE site_id = %s AND number = %s", [ctx.site_id, number])
    ctx.audit("app.archive", "app", str(number), before={"name": before["name"], "template": before["template"]})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/sites/{site_id}/apps/{number}/restore", response_model=AppOut)
def restore_app(ctx: Editor, number: int) -> dict[str, Any]:
    """Brings an archived app back to the list (the Undo after archiving one)."""
    row = ctx.conn.execute(
        "UPDATE apps SET archived_at = NULL"
        " WHERE site_id = %s AND number = %s AND archived_at IS NOT NULL RETURNING number",
        [ctx.site_id, number],
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No archived app with that number on this site")
    app = _app(ctx, number)
    ctx.audit("app.restore", "app", str(number), after={"name": app["name"], "template": app["template"]})
    return _out(app)


@router.get("/sites/{site_id}/apps/{number}/result", response_model=ResultOut, response_model_by_alias=True)
def app_result(ctx: Ctx, number: int) -> dict[str, Any]:
    """Runs the app on its signal's readings now: its status, in words, and the chart."""
    app = _app(ctx, number)
    template = TEMPLATES.get(app["template"])
    if template is None or template.version != app["template_version"]:
        raise HTTPException(status.HTTP_409_CONFLICT, "This app's template version is no longer served")
    try:
        out = template.run(ctx, check_config(template, app["config"]))
    except ConfigError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "; ".join(e.problems)) from e
    return {"app": _out(app), **out}
