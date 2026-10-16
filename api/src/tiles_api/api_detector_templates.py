"""Detector templates (T7.02, migration 0040): a machine type's detector set up once and applied to
every machine of that kind at or under a place of the ontology, each detector tuned by a backtest on
its own machine's history.

A template names the kind of machine (a Machine node's `kind` property), the signal it watches (a
Signal node of the machine, as coverage.py finds them, whose `measure` property is the template's,
else whose label contains it) and the values to try for each detection setting. Applying it, for each
such machine with that signal linked to a catalogue tag: the tag's history (its latest readings, as
many as the settings allow) is replayed with every combination of the settings and scored against
the machine's unplanned downtime (its events by asset, as Warning performance matches them, planned
stops left out, T7.03); the best setting becomes a detector named `<template>-<asset>` watching the
machine's asset, and the backtest is kept with it (`detector_backtests`). With no downtime to score
against, the detector takes each setting's first value, and its report says so. A machine that
already has the detector is left as it is.

Engineers write, audited; everyone reads.
"""

import re
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Response, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field

from tiles_api import api_detectors, coverage, ontology_store
from tiles_api.api_backtest import RUNNING, BacktestIn, EventIn, run_backtest
from tiles_api.api_ontology import Ctx, Editor, SiteContext
from tiles_api.detection import Config
from tiles_api.errors import Problem
from tiles_api.ontology import Graph
from tiles_api.store import one

router = APIRouter(tags=["detection"])

MAX_MACHINES = 50  # applied at once
Text = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^\S(.*\S)?$")]
Values = Field(min_length=1, max_length=4)  # values to try for one setting; every combination is tried


class Grid(BaseModel):
    model_config = ConfigDict(extra="forbid")
    window: Annotated[list[Annotated[int, Field(ge=10, le=2_000)]], Values] = [200]
    k: Annotated[list[Annotated[float, Field(gt=0, le=50)]], Values] = [3.0, 4.0, 5.0]
    persist: Annotated[list[Annotated[int, Field(ge=1, le=10_000)]], Values] = [3]
    direction: Annotated[list[Literal["above", "below", "both"]], Values] = ["above"]
    cooldown: Annotated[list[Annotated[int, Field(ge=0, le=1_000_000)]], Values] = [0]
    flat_spread: Annotated[list[Annotated[float, Field(gt=0, le=1e12)]], Values] = [1.0]


class TemplateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,39}$")]
    machine_kind: Text  # a Machine node's `kind`, e.g. die-caster
    measure: Text  # a Signal node's `measure`, e.g. friction
    grid: Grid = Grid()
    horizon_seconds: Annotated[float, Field(gt=0, le=90 * 86400)] = 8 * 3600  # how long before a stop a warning counts
    codes: Annotated[list[Text], Field(max_length=50)] = []  # the downtime codes it should warn of (none: all)
    lateness_seconds: Annotated[float, Field(ge=0, le=7 * 86400)] = 300


class Template(BaseModel):
    id: uuid.UUID
    name: str
    machine_kind: str
    measure: str
    grid: Grid
    horizon_seconds: float
    codes: list[str]
    lateness_seconds: float
    created_by: str | None
    created_at: datetime


class ApplyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    place: Annotated[str | None, Field(max_length=200)] = None  # an ontology place; none: the whole site


class Applied(BaseModel):
    machine: str  # the Machine node
    label: str
    asset: str
    # created; exists (it has the detector already); no_signal (no Signal node measuring it);
    # no_tag (none linked to a catalogue tag); no_history (no readings to run on)
    result: Literal["created", "exists", "no_signal", "no_tag", "no_history"]
    signal_tag: str | None = None
    detector_id: uuid.UUID | None = None
    detector: str | None = None
    config: dict[str, Any] | None = None
    readings: int | None = None
    events: int | None = None
    recall: float | None = None
    precision: float | None = None
    false_per_day: float | None = None


class ApplyOut(BaseModel):
    template: str
    place: str | None
    machines: list[Applied]


class Backtest(BaseModel):
    detector_id: uuid.UUID
    template: str | None
    config: dict[str, Any]
    readings: int
    events: int
    recall: float | None
    precision: float | None
    false_per_day: float | None
    report: str  # Markdown
    created_by: str | None
    created_at: datetime


TEMPLATES = """
SELECT t.id, t.name, t.machine_kind, t.measure, t.grid, t.horizon_s AS horizon_seconds, t.codes,
       t.lateness_s AS lateness_seconds, u.name AS created_by, t.created_at
FROM detector_templates t LEFT JOIN users u ON u.id = t.created_by
WHERE t.site_id = %s
"""


def _template(ctx: SiteContext, template_id: uuid.UUID) -> dict[str, Any]:
    row = ctx.conn.execute(TEMPLATES + " AND t.id = %s", [ctx.site_id, template_id]).fetchone()
    if row is None:
        raise Problem(status.HTTP_404_NOT_FOUND, "template.not_found", "No such detector template")
    return dict(row)


@router.get("/sites/{site_id}/detector-templates", response_model=list[Template])
def list_templates(ctx: Ctx) -> list[dict[str, Any]]:
    """The site's detector templates, by name."""
    return ctx.conn.execute(TEMPLATES + " ORDER BY t.name", [ctx.site_id]).fetchall()


@router.post("/sites/{site_id}/detector-templates", response_model=Template, status_code=status.HTTP_201_CREATED)
def create_template(ctx: Editor, body: TemplateIn) -> dict[str, Any]:
    """Sets up a detector for a kind of machine: the signal it watches and the settings to try.
    Engineers and admins; audited."""
    row = ctx.conn.execute(
        """
        INSERT INTO detector_templates
            (site_id, name, machine_kind, measure, grid, horizon_s, codes, lateness_s, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (site_id, name) DO NOTHING RETURNING id
        """,
        [
            ctx.site_id,
            body.name,
            body.machine_kind,
            body.measure,
            Jsonb(body.grid.model_dump()),
            body.horizon_seconds,
            sorted(set(body.codes)),
            body.lateness_seconds,
            ctx.user.id,
        ],
    ).fetchone()
    if row is None:
        raise Problem(
            status.HTTP_409_CONFLICT, "template.name_taken", f"A template is already called {body.name}", name=body.name
        )
    ctx.audit("detector_template.create", "detector_template", str(row["id"]), after=body.model_dump(mode="json"))
    return _template(ctx, row["id"])


@router.delete("/sites/{site_id}/detector-templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_template(ctx: Editor, template_id: uuid.UUID) -> Response:
    """Removes a template; the detectors made from it stay. Engineers and admins; audited."""
    before = _template(ctx, template_id)
    ctx.conn.execute("DELETE FROM detector_templates WHERE site_id = %s AND id = %s", [ctx.site_id, template_id])
    ctx.audit("detector_template.delete", "detector_template", str(template_id), before={"name": before["name"]})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _same(a: object, b: str) -> bool:
    return isinstance(a, str) and a.strip().casefold() == b.strip().casefold()


def watched(graph: Graph, index: coverage.Index, machine: str, measure: str) -> str | None:
    """The machine's Signal node for `measure`: by its `measure` property, else by its label."""
    nodes = coverage.signal_nodes(index, machine)
    by_prop = [n for n in nodes if _same(graph["nodes"][n]["props"].get("measure"), measure)]
    by_label = [n for n in nodes if measure.casefold() in graph["nodes"][n]["label"].casefold()]
    return next(iter(by_prop or by_label), None)


def detector_name(template: str, asset: str) -> str:
    """`<template>-<asset>`, as a detector may be called."""
    slug = re.sub(r"[^a-z0-9._-]+", "-", asset.casefold()).strip("-._") or "machine"
    return f"{template}-{slug}"[:63].rstrip("-._")


def _events(ctx: SiteContext, asset: str, codes: list[str]) -> list[dict[str, Any]]:
    """The machine's unplanned downtime, as Warning performance counts it (performance.py)."""
    rows = ctx.conn.execute(
        """
        SELECT s.at, coalesce(s.value_text, s.value::text, s.value_bool::text) AS code
        FROM site_samples s JOIN signals g ON g.id = s.signal_id
        WHERE g.site_id = %(site)s AND g.event_kind = 'downtime' AND g.asset = %(asset)s
          AND coalesce(s.value <> 0, s.value_bool, s.value_text <> '')
          AND (cardinality(%(codes)s::text[]) = 0
               OR coalesce(s.value_text, s.value::text, s.value_bool::text) = ANY(%(codes)s::text[]))
          AND NOT tiles_planned(g.site_id, g.asset, s.at, coalesce(s.value_text, s.value::text, s.value_bool::text))
        ORDER BY s.at DESC LIMIT %(limit)s
        """,
        {"site": ctx.site_id, "asset": asset, "codes": codes, "limit": 1_000},
    ).fetchall()
    return [{"at": r["at"], "code": r["code"][:100]} for r in reversed(rows)]


def _apply_one(
    ctx: SiteContext, t: dict[str, Any], machine: str, label: str, asset: str, signal: dict[str, Any]
) -> dict[str, Any]:
    name = detector_name(t["name"], asset)
    out: dict[str, Any] = {"machine": machine, "label": label, "asset": asset, "signal_tag": signal["tag"]}
    if ctx.conn.execute("SELECT 1 FROM detectors WHERE site_id = %s AND name = %s", [ctx.site_id, name]).fetchone():
        return out | {"result": "exists", "detector": name}
    grid = Grid.model_validate(t["grid"])
    events = _events(ctx, asset, t["codes"])
    body = BacktestIn(
        signal_id=signal["id"],
        events=[EventIn(at=e["at"], code=e["code"]) for e in events],
        horizon_seconds=t["horizon_seconds"],
        **grid.model_dump(),
    )
    bt = run_backtest(ctx.conn, ctx.site_id, body, latest=True)
    if not bt["readings"]:
        return out | {"result": "no_history"}
    first = Config(**{k: v[0] for k, v in grid.model_dump().items()}).as_json()
    best = bt["settings"][0]  # ranked best first
    if not events:
        best = next((s for s in bt["settings"] if s["config"] == first), best)
    report = bt["report"]
    if not events:
        report += "\nNo unplanned downtime to score against: the detector takes each setting's first value.\n"
    made = api_detectors.insert(
        ctx, name, signal["id"], best["config"], t["lateness_seconds"], asset, template=uuid.UUID(str(t["id"]))
    )
    if made is None:  # another request made it a moment ago
        return out | {"result": "exists", "detector": name}
    scores = {k: best[k] for k in ("recall", "precision", "false_per_day")}
    ctx.conn.execute(
        """
        INSERT INTO detector_backtests (site_id, detector_id, template_id, config, readings, events, recall,
                                        precision, false_per_day, report, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        [
            ctx.site_id,
            made,
            t["id"],
            Jsonb(best["config"]),
            bt["readings"],
            len(events),
            scores["recall"],
            scores["precision"],
            scores["false_per_day"],
            report,
            ctx.user.id,
        ],
    )
    return (
        out
        | scores
        | {
            "result": "created",
            "detector_id": made,
            "detector": name,
            "config": best["config"],
            "readings": bt["readings"],
            "events": len(events),
        }
    )


@router.post("/sites/{site_id}/detector-templates/{template_id}/apply", response_model=ApplyOut)
def apply_template(ctx: Editor, template_id: uuid.UUID, body: ApplyIn) -> dict[str, Any]:
    """Applies the template to every machine of its kind at or under `place` (the whole site without
    one): a detector for each, tuned by a backtest on that machine's history and unplanned downtime,
    kept with its report. Machines that already have it are left as they are. Engineers and admins;
    audited."""
    t = _template(ctx, template_id)
    graph = ontology_store.load_head(ctx.conn, ctx.site_id)
    index = coverage.Index(graph)
    try:
        machines = coverage.machines_under(index, body.place)
    except coverage.NoPlace as e:
        raise Problem(
            status.HTTP_404_NOT_FOUND, "coverage.no_place", f"No place {body.place} in the plant model", place=str(e)
        ) from e
    machines = [m for m in machines if _same(graph["nodes"][m]["props"].get("kind"), t["machine_kind"])]
    if len(machines) > MAX_MACHINES:
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "template.too_many",
            f"More than {MAX_MACHINES} machines: apply it to a smaller place",
            most=MAX_MACHINES,
        )
    if not RUNNING.acquire(blocking=False):
        raise Problem(
            status.HTTP_429_TOO_MANY_REQUESTS, "backtest.busy", "Other backtests are running: try again shortly"
        )
    try:
        results = []
        for m in machines:
            label, asset = graph["nodes"][m]["label"], coverage.asset_of(graph, m)
            row: dict[str, Any] = {"machine": m, "label": label, "asset": asset}
            node = watched(graph, index, m, t["measure"])
            signal = (
                ctx.conn.execute(
                    "SELECT id, tag FROM signals WHERE site_id = %s AND node_id = %s", [ctx.site_id, node]
                ).fetchone()
                if node
                else None
            )
            if node is None:
                results.append(row | {"result": "no_signal"})
            elif signal is None:
                results.append(row | {"result": "no_tag"})
            else:
                try:
                    results.append(_apply_one(ctx, t, m, label, asset, dict(signal)))
                except ValueError as e:  # the settings can't fit any history (backtest.check_size)
                    raise Problem(
                        status.HTTP_422_UNPROCESSABLE_CONTENT, "backtest.invalid", str(e), reason=str(e)
                    ) from e
    finally:
        RUNNING.release()
    made = [r["detector"] for r in results if r["result"] == "created"]
    ctx.audit(
        "detector_template.apply",
        "detector_template",
        str(template_id),
        after={"place": body.place, "machines": len(results), "created": made},
    )
    return {"template": t["name"], "place": body.place, "machines": results}


@router.get("/sites/{site_id}/detectors/{detector_id}/backtest", response_model=Backtest)
def detector_backtest(ctx: Ctx, detector_id: uuid.UUID) -> dict[str, Any]:
    """The backtest a detector was tuned by, with its Markdown report."""
    row = ctx.conn.execute(
        """
        SELECT b.detector_id, t.name AS template, b.config, b.readings, b.events, b.recall, b.precision,
               b.false_per_day, b.report, u.name AS created_by, b.created_at
        FROM detector_backtests b
        LEFT JOIN detector_templates t ON t.id = b.template_id
        LEFT JOIN users u ON u.id = b.created_by
        WHERE b.site_id = %s AND b.detector_id = %s ORDER BY b.created_at DESC LIMIT 1
        """,
        [ctx.site_id, detector_id],
    ).fetchone()
    if row is None:
        raise Problem(status.HTTP_404_NOT_FOUND, "template.no_backtest", "This detector has no backtest kept")
    return dict(one(row))
