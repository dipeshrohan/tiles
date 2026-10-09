"""Design runs (T4.11): the Design Studio's runs, stored and shared on the site.

A run is a design model version (models/design.py) with its parameters and the output the API
computes from them, never one the browser sends. It names its parent (the run it was changed from)
and, when it restores an earlier run, that run; with its note and author it is kept as it was
(migration 0020), so a design's lineage can be followed back to its first run and exported for
audit (T4.13). Runs are numbered per site.

- `POST /sites/{id}/runs` (engineers) runs a model and stores the run. The model is a registry
  key ("cell-swelling") or the browser's id ("swelling", with versions like "2.0").
- `POST /sites/{id}/runs/{n}/restore` (engineers) runs run n's version and parameters again as a
  new run, after the latest run of that model in its project: the design goes back to it, and the
  history keeps what came between.
- `GET /sites/{id}/runs/compare?a=&b=` gives what changed between two runs of a model: version,
  parameters and outputs.

Runs belong to a site's shared design project (T4.14, migration 0022), or to none (runs made
before projects): a run's parent, and the latest run a restore follows, are in its project.

The audit export (T4.13): `GET /sites/{id}/runs/{n}/audit` is run n with its whole lineage back
to the first run (and the runs they restored), each with the spec of the model version it ran, a
SHA-256 digest of the runs, and who exported it when; `…/audit.pdf` is the same as a report.
"""

import hashlib
import json
import math
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Response, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt

from tiles_api import pdf
from tiles_api.api_ontology import Ctx, Editor, SiteContext
from tiles_api.models import design, store
from tiles_api.models.registry import Model, ModelError, evaluate, registry, version_key
from tiles_api.store import one

router = APIRouter(tags=["runs"])

MAX_LINEAGE = 1000  # parents followed back from a run


class RunIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: Annotated[str, Field(min_length=1, max_length=100)]
    version: Annotated[str | None, Field(max_length=40)] = None  # the latest unless named
    # Numbers only (not true or "90"); those not given take their defaults.
    params: Annotated[dict[Annotated[str, Field(max_length=63)], StrictFloat | StrictInt], Field(max_length=50)] = {}
    note: Annotated[str, Field(max_length=500, pattern=r"^[^\x00]*$")] = ""
    parent: Annotated[int | None, Field(ge=1)] = None  # the run this one was changed from, in its project
    project: uuid.UUID | None = None  # the design project it belongs to (T4.14)


class ProjectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=200, pattern=r"^[^\x00]*\S[^\x00]*$")]
    description: Annotated[str, Field(max_length=2000, pattern=r"^[^\x00]*$")] = ""


class Project(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    created_by: str
    created_at: datetime
    runs: int
    last_run_at: datetime | None


class RestoreIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: Annotated[str, Field(max_length=500, pattern=r"^[^\x00]*$")] = ""


class Change(BaseModel):
    key: str  # a parameter, or "version"
    before: float | str | None
    after: float | str | None


class Author(BaseModel):
    name: str
    email: str


class Run(BaseModel):
    number: int
    model: str
    version: str
    model_name: str
    params: dict[str, float]
    output: dict[str, float | None]
    units: dict[str, str]  # of the parameters and outputs
    parent: int | None
    restored_from: int | None
    project: uuid.UUID | None
    note: str
    author: Author
    created_at: datetime
    changes: list[Change]  # from its parent


class RunDetail(Run):
    lineage: list[int]  # its parent, that run's parent, … back to the first run
    lineage_complete: bool  # false when cut at MAX_LINEAGE runs


class RunPage(BaseModel):
    runs: list[Run]
    total: int


class OutputChange(BaseModel):
    name: str
    unit: str
    a: float | None
    b: float | None
    delta: float | None
    percent: float | None  # of a's value


class Comparison(BaseModel):
    a: Run
    b: Run
    changes: list[Change]
    outputs: list[OutputChange]


def _key(model: str) -> str:
    """The registry's key for a model named by it or by the browser's id."""
    return design.BROWSER_KEYS.get(model, model)


def _model(key: str, version: str | None) -> Model:
    """A design model by the registry's key or the browser's id, its latest version unless named."""
    # The browser's versions have no patch number ("2.0"), whichever name the model is given by.
    full = None if version is None else version if version.count(".") == 2 else f"{version}.0"
    try:
        model = registry.get(_key(key), full)
    except KeyError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e.args[0])) from e
    if model.spec.kind != "design":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"{model.spec.key} is a {model.spec.kind} model: only design models run",
        )
    return model


def _units(model: Model) -> dict[str, str]:
    s = model.spec
    return {p.name: p.unit for p in s.params} | {p.name: p.unit for p in s.outputs}


def _stored_model(row: dict[str, Any]) -> Model | None:
    """A stored run's model version, or None if it is no longer registered (the run still shows)."""
    try:
        return registry.get(row["model"], row["version"])
    except KeyError:
        return None


def changes(a: dict[str, Any], b: dict[str, Any]) -> list[dict[str, Any]]:
    """What changed from run `a` to run `b`: the version, then each parameter in `b`'s order."""
    out = [{"key": "version", "before": a["version"], "after": b["version"]}] if a["version"] != b["version"] else []
    keys = list(b["params"]) + [k for k in a["params"] if k not in b["params"]]
    return out + [
        {"key": k, "before": a["params"].get(k), "after": b["params"].get(k)}
        for k in keys
        if a["params"].get(k) != b["params"].get(k)
    ]


RUNS = """
SELECT r.id, r.number, r.model_key AS model, r.version, r.params, r.output, r.note, r.created_at,
       r.author_name, r.author_email, p.number AS parent, p.params AS parent_params, p.version AS parent_version,
       s.number AS restored_from, r.project_id AS project
FROM design_runs r
LEFT JOIN design_runs p ON p.id = r.parent_id
LEFT JOIN design_runs s ON s.id = r.restored_from
WHERE r.site_id = %(site)s
"""


OF_MODEL = (
    " AND (%(model)s::text IS NULL OR r.model_key = %(model)s)"
    " AND (%(project)s::uuid IS NULL OR r.project_id = %(project)s)"
)
COUNT = "SELECT count(*) AS n FROM design_runs r WHERE r.site_id = %(site)s" + OF_MODEL  # noqa: S608 - constants


def _shown(row: dict[str, Any]) -> dict[str, Any]:
    model = _stored_model(row)
    parent = {"version": row["parent_version"], "params": row["parent_params"]} if row["parent"] is not None else None
    return {
        "number": row["number"],
        "model": row["model"],
        "version": row["version"],
        "model_name": model.spec.name if model else row["model"],
        "params": row["params"],
        "output": row["output"],
        "units": _units(model) if model else {},
        "parent": row["parent"],
        "restored_from": row["restored_from"],
        "project": row["project"],
        "note": row["note"],
        "author": {"name": row["author_name"], "email": row["author_email"]},
        "created_at": row["created_at"],
        "changes": changes(parent, row) if parent else [],
    }


def _row(ctx: SiteContext, number: int) -> dict[str, Any]:
    row = ctx.conn.execute(RUNS + " AND r.number = %(n)s", {"site": ctx.site_id, "n": number}).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No run {number} on this site")
    return row


def _lock(ctx: SiteContext) -> None:
    """Runs of a site are stored one at a time, so a new run's parent (the model's latest run, on
    restore) is still the latest when it is stored."""
    ctx.conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [f"design-runs:{ctx.site_id}"])


def _run(model: Model, params: dict[str, float]) -> tuple[dict[str, float], dict[str, float | None]]:
    """Every parameter as run (defaults filled in) and the outputs."""
    try:
        out = evaluate(model, {}, params)
    except ModelError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    full = {p.name: float(params.get(p.name, p.default)) for p in model.spec.params}
    return full, {name: values[0] if values else None for name, values in out.items()}


def _store(
    ctx: SiteContext,
    model: Model,
    run: tuple[dict[str, float], dict[str, float | None]],
    note: str,
    parent_id: uuid.UUID | None,
    restored_from: uuid.UUID | None,
    project_id: uuid.UUID | None,
) -> int:
    """Stores a run of `model` (its parameters and outputs, from _run); its number."""
    s = model.spec
    full, output = run
    try:
        model_id = store.model_id(ctx.conn, ctx.org_id, model)
    except store.ModelChanged as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    number: int = one(
        ctx.conn.execute(
            """
            INSERT INTO run_numbers (site_id, last) VALUES (%s, 1)
            ON CONFLICT (site_id) DO UPDATE SET last = run_numbers.last + 1 RETURNING last
            """,
            [ctx.site_id],
        ).fetchone()
    )["last"]
    ctx.conn.execute(
        """
        INSERT INTO design_runs (site_id, number, model_id, model_key, version, params, output, parent_id,
                                 restored_from, note, author_id, author_name, author_email, project_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        [
            ctx.site_id,
            number,
            model_id,
            s.key,
            s.version,
            Jsonb(full),
            Jsonb(output),
            parent_id,
            restored_from,
            note,
            ctx.user.id,
            ctx.user.name,
            ctx.user.email,
            project_id,
        ],
    )
    return number


@router.get("/sites/{site_id}/runs", response_model=RunPage)
def list_runs(
    ctx: Ctx,
    model: Annotated[str | None, Query(max_length=100)] = None,
    project: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict[str, Any]:
    """The site's runs, the latest first; of one model (a registry key or the browser's id) and one
    project if named."""
    key = _key(model) if model else None
    args = {"site": ctx.site_id, "model": key, "project": project, "limit": limit, "offset": offset}
    rows = ctx.conn.execute(RUNS + OF_MODEL + " ORDER BY r.number DESC LIMIT %(limit)s OFFSET %(offset)s", args)
    total = one(ctx.conn.execute(COUNT, args).fetchone())["n"]
    return {"runs": [_shown(r) for r in rows.fetchall()], "total": total}


@router.post("/sites/{site_id}/runs", response_model=RunDetail, status_code=status.HTTP_201_CREATED)
def create_run(ctx: Editor, body: RunIn) -> dict[str, Any]:
    """Run a registered design model with these parameters and keep the result, computed here, as the
    site's next numbered run, in a project and after a parent run if given."""
    model = _model(body.model, body.version)
    run = _run(model, body.params)
    _lock(ctx)
    if (
        body.project is not None
        and not ctx.conn.execute(
            "SELECT 1 FROM design_projects WHERE site_id = %s AND id = %s", [ctx.site_id, body.project]
        ).fetchone()
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such design project on this site")
    parent_id = None
    if body.parent is not None:
        parent = _row(ctx, body.parent)
        if parent["model"] != model.spec.key:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"Run {body.parent} is of {parent['model']}, not {model.spec.key}",
            )
        if parent["project"] != body.project:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Run {body.parent} is in another project")
        parent_id = parent["id"]
    number = _store(ctx, model, run, body.note.strip(), parent_id, None, body.project)
    ctx.audit(
        "run.create",
        "design_run",
        str(number),
        after={
            "model": model.spec.key,
            "version": model.spec.version,
            "parent": body.parent,
            "project": body.project and str(body.project),
        },
    )
    return get_run(ctx, number)


@router.get("/sites/{site_id}/runs/compare", response_model=Comparison)
def compare(ctx: Ctx, a: Annotated[int, Query(ge=1)], b: Annotated[int, Query(ge=1)]) -> dict[str, Any]:
    """What changed from run `a` to run `b` (of one model, in any versions)."""
    ra, rb = _row(ctx, a), _row(ctx, b)
    if ra["model"] != rb["model"]:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"Run {a} is of {ra['model']} and run {b} of {rb['model']}"
        )
    sa, sb = _shown(ra), _shown(rb)
    outputs = []
    for name in [*sb["output"], *(n for n in sa["output"] if n not in sb["output"])]:  # one a version dropped too
        before, after = sa["output"].get(name), sb["output"].get(name)
        delta = after - before if after is not None and before is not None else None
        percent = 100 * delta / abs(before) if delta is not None and before else None
        outputs.append(
            {
                "name": name,
                "unit": sb["units"].get(name) or sa["units"].get(name, ""),
                "a": before,
                "b": after,
                "delta": delta,
                "percent": percent if percent is None or math.isfinite(percent) else None,
            }
        )
    return {"a": sa, "b": sb, "changes": changes(ra, rb), "outputs": outputs}


@router.get("/sites/{site_id}/runs/{number}", response_model=RunDetail)
def get_run(ctx: Ctx, number: int) -> dict[str, Any]:
    """A run by its number, with its inputs, results and lineage (the runs it was changed from)."""
    row = _row(ctx, number)
    lineage = ctx.conn.execute(
        """
        WITH RECURSIVE up (id, parent_id, number, depth) AS (
            SELECT p.id, p.parent_id, p.number, 1 FROM design_runs p
            WHERE p.id = (SELECT parent_id FROM design_runs WHERE id = %(id)s)
          UNION ALL
            SELECT p.id, p.parent_id, p.number, up.depth + 1 FROM design_runs p JOIN up ON p.id = up.parent_id
            WHERE up.depth < %(max)s
        )
        SELECT up.number, p.parent_id IS NULL AS first FROM up JOIN design_runs p ON p.id = up.id ORDER BY depth
        """,
        {"id": row["id"], "max": MAX_LINEAGE},
    ).fetchall()
    complete = not lineage or bool(lineage[-1]["first"])
    return _shown(row) | {"lineage": [r["number"] for r in lineage], "lineage_complete": complete}


@router.post("/sites/{site_id}/runs/{number}/restore", response_model=RunDetail, status_code=status.HTTP_201_CREATED)
def restore_run(ctx: Editor, number: int, body: RestoreIn | None = None) -> dict[str, Any]:
    """Run `number`'s version and parameters again, as a new run after its model's latest run in its project."""
    row = _row(ctx, number)
    model = _stored_model(row)
    if model is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Run {number}'s model {row['model']} {row['version']} is no longer registered"
        )
    run = _run(model, row["params"])
    if run[1] != row["output"]:  # a published version never changes (models/published.json)
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Run {number} gives another output now: model {row['model']} {row['version']} changed",
        )
    _lock(ctx)
    head = one(
        ctx.conn.execute(
            "SELECT id, number FROM design_runs WHERE site_id = %s AND model_key = %s"
            " AND project_id IS NOT DISTINCT FROM %s ORDER BY number DESC LIMIT 1",
            [ctx.site_id, row["model"], row["project"]],
        ).fetchone()
    )
    note = (body.note.strip() if body else "") or f"Restored run {number}"
    new = _store(ctx, model, run, note, head["id"], row["id"], row["project"])
    ctx.audit("run.restore", "design_run", str(new), after={"restored_from": number, "parent": head["number"]})
    return get_run(ctx, new)


PROJECTS = """
SELECT p.id, p.name, p.description, p.created_by, p.created_at,
       count(r.id) AS runs, max(r.created_at) AS last_run_at
FROM design_projects p LEFT JOIN design_runs r ON r.site_id = p.site_id AND r.project_id = p.id
WHERE p.site_id = %(site)s
"""


def _project(ctx: SiteContext, project_id: uuid.UUID) -> dict[str, Any]:
    row = ctx.conn.execute(
        PROJECTS + " AND p.id = %(id)s GROUP BY p.id", {"site": ctx.site_id, "id": project_id}
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such design project on this site")
    return row


@router.get("/sites/{site_id}/design-projects", response_model=list[Project])
def list_projects(ctx: Ctx) -> list[dict[str, Any]]:
    """The site's design projects, the one with the latest run first (T4.14)."""
    return ctx.conn.execute(
        PROJECTS + " GROUP BY p.id ORDER BY greatest(max(r.created_at), p.created_at) DESC LIMIT 200",
        {"site": ctx.site_id},
    ).fetchall()


@router.post("/sites/{site_id}/design-projects", response_model=Project, status_code=status.HTTP_201_CREATED)
def create_project(ctx: Editor, body: ProjectIn) -> dict[str, Any]:
    """Start a design project on this site; its name must be new on the site."""
    name = body.name.strip()
    row = ctx.conn.execute(
        """
        INSERT INTO design_projects (site_id, name, description, created_by) VALUES (%s, %s, %s, %s)
        ON CONFLICT DO NOTHING RETURNING id
        """,
        [ctx.site_id, name, body.description.strip(), ctx.user.name],
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"There is already a project called {name!r}")
    ctx.audit("design_project.create", "design_project", str(row["id"]), after={"name": name})
    return _project(ctx, row["id"])


# ---- the audit export (T4.13) ---------------------------------------------------------------

MAX_AUDIT_RUNS = 5000  # the lineage and the runs it restored, in one record


def _digest(record: dict[str, Any]) -> str:
    """SHA-256 of the record without its digest, as canonical JSON (keys sorted, no spaces, as
    Python's json writes it): recomputed from the exported file, it shows nothing in it changed."""
    body = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(body.encode()).hexdigest()


def _utc(t: datetime) -> str:
    """A time as ISO 8601 in UTC, whatever the database session's time zone."""
    return t.astimezone(UTC).isoformat()


def audit_record(ctx: SiteContext, number: int) -> dict[str, Any]:
    """Run `number` with its lineage (its parent, that run's parent, … back to the first run) and
    the runs any of them restored, newest first; the spec of every model version they ran."""
    row = _row(ctx, number)
    # Each run once (UNION drops a row already reached by another path); the most recent kept, the
    # exported run first among them (its parent and the run it restored are older).
    ids = ctx.conn.execute(
        """
        WITH RECURSIVE chain (id, parent_id, restored_from) AS (
            SELECT id, parent_id, restored_from FROM design_runs WHERE id = %(id)s
          UNION
            SELECT r.id, r.parent_id, r.restored_from FROM design_runs r
            JOIN chain ON r.id = chain.parent_id OR r.id = chain.restored_from
        )
        SELECT chain.id FROM chain JOIN design_runs r USING (id) ORDER BY r.number DESC LIMIT %(limit)s
        """,
        {"id": row["id"], "limit": MAX_AUDIT_RUNS + 1},
    ).fetchall()
    complete = len(ids) <= MAX_AUDIT_RUNS
    rows = ctx.conn.execute(
        RUNS + " AND r.id = ANY(%(ids)s) ORDER BY r.number DESC",
        {"site": ctx.site_id, "ids": [r["id"] for r in ids[:MAX_AUDIT_RUNS]]},
    ).fetchall()
    runs = [_shown(r) | {"created_at": _utc(r["created_at"])} for r in rows]
    lineage = [number]
    by_number = {r["number"]: r for r in runs}
    while (parent := by_number[lineage[-1]]["parent"]) is not None and parent in by_number:
        lineage.append(parent)
    models = sorted(
        ctx.conn.execute(
            """
            SELECT DISTINCT m.key, m.version, m.name, m.kind, m.domain, m.spec
            FROM design_runs r JOIN models m ON m.id = r.model_id
            WHERE r.site_id = %(site)s AND r.id = ANY(%(ids)s)
            """,
            {"site": ctx.site_id, "ids": [r["id"] for r in ids[:MAX_AUDIT_RUNS]]},
        ).fetchall(),
        key=lambda m: (m["key"], version_key(m["version"])),
    )
    names = one(
        ctx.conn.execute(
            "SELECT s.name AS site, o.name AS org FROM sites s JOIN orgs o ON o.id = s.org_id WHERE s.id = %s",
            [ctx.site_id],
        ).fetchone()
    )
    project = (
        ctx.conn.execute("SELECT id, name FROM design_projects WHERE id = %s", [row["project"]]).fetchone()
        if row["project"]
        else None
    )
    record = {
        "format": "tiles-design-audit/1",
        "exported_at": _utc(datetime.now(UTC)),
        "exported_by": {"name": ctx.user.name, "email": ctx.user.email},
        "organisation": names["org"],
        "site": {"id": str(ctx.site_id), "name": names["site"]},
        "project": project and {"id": str(project["id"]), "name": project["name"]},
        "run": number,
        "lineage": lineage,  # run numbers, the exported run first, back to the first run
        "complete": complete and lineage[-1] in by_number and by_number[lineage[-1]]["parent"] is None,
        "runs": runs,
        "models": models,
    }
    return record | {"digest": {"algorithm": "sha256", "of": "the record without its digest", "value": _digest(record)}}


@router.get("/sites/{site_id}/runs/{number}/audit")
def get_audit_record(ctx: Ctx, number: int) -> Response:
    """Run `number`'s audit record, as JSON to keep (T4.13)."""
    record = audit_record(ctx, number)
    _audit_export(ctx, number, "json", record)
    body = json.dumps(record, indent=2, ensure_ascii=False, default=str)
    return Response(
        body,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="tiles-run-{number}-audit.json"'},
    )


def _audit_export(ctx: SiteContext, number: int, kind: str, record: dict[str, Any]) -> None:
    """An export is recorded too: who took which run's lineage out, and the digest they got."""
    ctx.audit(
        "run.audit_export",
        "design_run",
        str(number),
        after={"format": kind, "runs": len(record["runs"]), "digest": record["digest"]["value"]},
    )


def _when(iso: str) -> str:
    return datetime.fromisoformat(iso).astimezone(UTC).strftime("%Y-%m-%d %H:%M")


def _value(v: Any, unit: str = "") -> str:
    text = f"{v:.6g}" if isinstance(v, float) else str(v)
    return f"{text} {unit}".strip()


def audit_pdf(record: dict[str, Any]) -> bytes:
    """The audit record as a PDF report."""
    digest = record["digest"]["value"]
    project = record["project"]
    report = pdf.Report(
        footer=f"Tiles design audit · {record['site']['name']} · run {record['run']} · sha256 {digest[:16]}"
    )
    report.add(f"Design run audit: run {record['run']}", "title")
    report.add(
        f"{record['organisation']} · {record['site']['name']}" + (f" · project {project['name']}" if project else "")
    )
    report.add(
        f"Exported {_when(record['exported_at'])} UTC by {record['exported_by']['name']}"
        f" ({record['exported_by']['email']})"
    )
    report.add(
        "Lineage, the exported run first: "
        + " <- ".join(f"#{n}" for n in record["lineage"])
        + ("" if record["complete"] else " (cut: the record holds the most recent runs only)")
    )
    report.add("SHA-256 of the JSON record without its digest (keys sorted, no spaces):")
    report.add(digest, "mono").space()
    for run in record["runs"]:
        units = run["units"]
        report.add(
            f"Run {run['number']} · {run['model_name']} {run['version']} · {_when(run['created_at'])} UTC",
            "heading",
        )
        report.add(
            f"By {run['author']['name']} ({run['author']['email']})" + (f": {run['note']}" if run["note"] else "")
        )
        parent = f"after run {run['parent']}" if run["parent"] is not None else "the first run"
        restored = f"; restores run {run['restored_from']}" if run["restored_from"] is not None else ""
        report.add(parent[0].upper() + parent[1:] + restored)
        report.add("Output: " + ", ".join(f"{k} = {_value(v, units.get(k, ''))}" for k, v in run["output"].items()))
        report.add("Parameters: " + ", ".join(f"{k} = {_value(v, units.get(k, ''))}" for k, v in run["params"].items()))
        if run["changes"]:
            report.add(
                "Changed from its parent: "
                + "; ".join(f"{c['key']} {_value(c['before'])} -> {_value(c['after'])}" for c in run["changes"])
            )
        report.space()
    report.add("Model versions", "heading")
    for m in record["models"]:
        report.add(f"{m['name']} ({m['key']}) {m['version']} · {m['domain']}")
        if m["spec"].get("description"):
            report.add(m["spec"]["description"])
        for p in m["spec"].get("params", []):
            low, high = p.get("min"), p.get("max")
            bounds = (
                f", {_value(low)} to {_value(high)}"
                if low is not None and high is not None
                else f", at least {_value(low)}"
                if low is not None
                else f", at most {_value(high)}"
                if high is not None
                else ""
            )
            report.add(
                f"  {p['name']}: {p.get('description', '')}"
                f" ({p.get('unit', '')}; default {_value(p['default'])}{bounds})",
                "mono",
            )
        report.space()
    return report.render()


@router.get("/sites/{site_id}/runs/{number}/audit.pdf")
def get_audit_pdf(ctx: Ctx, number: int) -> Response:
    """Run `number`'s audit record as a PDF report (T4.13)."""
    record = audit_record(ctx, number)
    _audit_export(ctx, number, "pdf", record)
    return Response(
        audit_pdf(record),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="tiles-run-{number}-audit.pdf"'},
    )
