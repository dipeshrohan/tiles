"""Signal catalogue (T2.08): the site's signals, searchable, with their unit, sample rate,
source and the ontology node each is mapped to.

Signals appear on their own: an edge agent or a file import that sends a new
tag adds it, with the agent or the import as its source. Engineers then fill in
what the tag alone doesn't say (unit, sample rate, a description, the expected
range) and link it to a Signal node of the committed ontology, so models and
pages can find a node's readings. Each change is audited. Every signal carries
the report of its latest data-quality check (T2.09, see quality.py).
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal, LiteralString

from fastapi import APIRouter, HTTPException, Query, status
from psycopg import errors, sql
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat

from tiles_api.api_ontology import Ctx, Editor
from tiles_api.quality import DEFAULT_HOURS, SIGNAL, Badge, Report, check_signal, check_site
from tiles_api.store import one

router = APIRouter(tags=["signals"])

NO_NUL = r"^[^\x00]*$"  # PostgreSQL text can't hold NUL
EDITABLE = ("unit", "sample_rate_hz", "description", "node_id", "range_min", "range_max", "stuck_after_s")
# Changing one of these changes what the quality check finds, so the signal is checked again.
CHECKED = {"unit", "sample_rate_hz", "node_id", "range_min", "range_max", "stuck_after_s"}


class Signal(BaseModel):
    id: uuid.UUID
    tag: str
    unit: str | None
    sample_rate_hz: float | None
    source: str  # edge:<agent>, import:<file> or manual
    description: str
    node_id: str | None
    node_label: str | None  # None when unlinked, or when the ontology no longer has it as a Signal node
    range_min: float | None  # the values expected; readings outside are flagged
    range_max: float | None
    stuck_after_s: float | None  # how long one value may repeat (None: an hour)
    created_at: datetime
    last_at: datetime | None  # the latest reading
    last_value: float | str | bool | None
    quality: Report | None  # the latest data-quality check; None until checked


class SignalPage(BaseModel):
    total: int
    signals: list[Signal]


class SignalPatch(BaseModel):
    """Only the fields given change; null clears one."""

    model_config = ConfigDict(extra="forbid")
    unit: Annotated[str, Field(min_length=1, max_length=40, pattern=NO_NUL)] | None = None
    sample_rate_hz: Annotated[float, Field(gt=0, le=1_000_000)] | None = None
    description: Annotated[str, Field(max_length=1000, pattern=NO_NUL)] | None = None
    node_id: Annotated[str, Field(min_length=1, max_length=200, pattern=NO_NUL)] | None = None
    range_min: FiniteFloat | None = None
    range_max: FiniteFloat | None = None
    stuck_after_s: Annotated[float, Field(gt=0, le=30 * 86400)] | None = None


class QualityCheckIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    signal_ids: Annotated[list[uuid.UUID], Field(min_length=1, max_length=1000)] | None = None  # None: all
    hours: Annotated[float, Field(gt=0, le=720)] = DEFAULT_HOURS


class QualityCheckOut(BaseModel):
    checked: int
    badges: dict[Badge, int]


SELECT: LiteralString = """
SELECT g.id, g.tag, g.unit, g.sample_rate_hz, g.source, g.description, g.node_id, g.range_min, g.range_max,
       g.stuck_after_s, g.created_at, n.label AS node_label, l.at AS last_at, coalesce(to_jsonb(l.value),
       to_jsonb(l.value_text), to_jsonb(l.value_bool)) AS last_value, q.report AS quality
FROM signals g
LEFT JOIN ontology_nodes n ON n.site_id = g.site_id AND n.id = g.node_id AND n.type = 'Signal'
LEFT JOIN signal_quality q ON q.signal_id = g.id
LEFT JOIN LATERAL (
    SELECT at, value, value_text, value_bool FROM samples s WHERE s.signal_id = g.id ORDER BY at DESC LIMIT 1
) l ON true
"""


def _like(text: str) -> str:
    """A search term as an ILIKE pattern that matches it anywhere, taken literally."""
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


@router.get("/sites/{site_id}/signals", response_model=SignalPage)
def list_signals(
    ctx: Ctx,
    q: Annotated[str, Query(max_length=200, pattern=NO_NUL)] = "",
    source: Literal["", "edge", "import", "manual"] = "",
    linked: Literal["", "yes", "no"] = "",
    quality: Literal["", "good", "warn", "bad", "unknown", "unchecked"] = "",
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> SignalPage:
    """The site's signals in tag order. `q` searches tags, descriptions and linked node labels;
    `source` keeps those from edge agents, imports or entered by hand; `linked` those (not) mapped
    to an ontology node; `quality` those whose latest check gave that badge (or that are unchecked)."""
    where: list[LiteralString] = ["g.site_id = %s"]
    args: list[Any] = [ctx.site_id]
    if q.strip():
        where.append("(g.tag ILIKE %s OR g.description ILIKE %s OR n.label ILIKE %s)")
        args += [_like(q.strip())] * 3
    if source == "manual":
        where.append("g.source = 'manual'")
    elif source:
        where.append("g.source LIKE %s")
        args.append(f"{source}:%")
    if linked:
        where.append("g.node_id IS NOT NULL" if linked == "yes" else "g.node_id IS NULL")
    if quality == "unchecked":
        where.append("q.badge IS NULL")
    elif quality:
        where.append("q.badge = %s")
        args.append(quality)
    condition = sql.SQL(" AND ").join(sql.SQL(w) for w in where)
    total = ctx.conn.execute(
        sql.SQL(
            "SELECT count(*) AS n FROM signals g LEFT JOIN ontology_nodes n ON n.site_id = g.site_id"
            " AND n.id = g.node_id AND n.type = 'Signal' LEFT JOIN signal_quality q ON q.signal_id = g.id WHERE {}"
        ).format(condition),
        args,
    ).fetchone()
    query = sql.SQL("{} WHERE {} ORDER BY g.tag LIMIT %s OFFSET %s").format(sql.SQL(SELECT), condition)
    rows = ctx.conn.execute(query, [*args, limit, offset])
    return SignalPage(total=total["n"] if total else 0, signals=[Signal(**r) for r in rows])


def _get(ctx: Any, signal_id: uuid.UUID) -> Signal:
    row = ctx.conn.execute(SELECT + " WHERE g.id = %s AND g.site_id = %s", [signal_id, ctx.site_id]).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such signal on this site")
    return Signal(**row)


@router.get("/sites/{site_id}/signals/{signal_id}", response_model=Signal)
def get_signal(ctx: Ctx, signal_id: uuid.UUID) -> Signal:
    return _get(ctx, signal_id)


@router.patch("/sites/{site_id}/signals/{signal_id}", response_model=Signal)
def update_signal(ctx: Editor, signal_id: uuid.UUID, body: SignalPatch) -> Signal:
    """Sets a signal's unit, sample rate, description or ontology link (engineers and admins).
    A link must name a Signal node of the committed ontology that no other tag is linked to."""
    # Lock the row first, so that `before` (for the audit log) is what this change replaces.
    ctx.conn.execute("SELECT 1 FROM signals WHERE id = %s AND site_id = %s FOR UPDATE", [signal_id, ctx.site_id])
    before = _get(ctx, signal_id)
    changes = {k: getattr(body, k) for k in EDITABLE if k in body.model_fields_set}
    if "description" in changes and changes["description"] is None:
        changes["description"] = ""
    node_id = changes.get("node_id")
    if node_id is not None:
        node = ctx.conn.execute(
            "SELECT type FROM ontology_nodes WHERE site_id = %s AND id = %s", [ctx.site_id, node_id]
        ).fetchone()
        if node is None or node["type"] != "Signal":
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"{node_id} is not a Signal node of the committed ontology; commit it there first",
            )
    low = changes.get("range_min", before.range_min)
    high = changes.get("range_max", before.range_max)
    if low is not None and high is not None and low >= high:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "The expected range's minimum must be below its maximum"
        )
    if not changes:
        return before
    assignments = sql.SQL(", ").join(sql.SQL("{} = %s").format(sql.Identifier(k)) for k in changes)
    try:
        with ctx.conn.transaction():  # a savepoint, so a clash doesn't abort the request's transaction
            ctx.conn.execute(
                sql.SQL("UPDATE signals SET {} WHERE id = %s AND site_id = %s").format(assignments),
                [*changes.values(), signal_id, ctx.site_id],
            )
    except errors.UniqueViolation:
        other = ctx.conn.execute(
            "SELECT tag FROM signals WHERE site_id = %s AND node_id = %s", [ctx.site_id, node_id]
        ).fetchone()
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"{node_id} is already linked to {other['tag'] if other else 'another signal'}"
        ) from None
    ctx.audit(
        "signal.update",
        "signal",
        str(signal_id),
        before={"tag": before.tag, **{k: getattr(before, k) for k in changes}},
        after={"tag": before.tag, **changes},
    )
    if CHECKED & changes.keys():
        now = one(ctx.conn.execute("SELECT clock_timestamp() AS now").fetchone())["now"]
        signal = one(ctx.conn.execute(SIGNAL + " WHERE g.id = %s", [signal_id]).fetchone())
        hours = before.quality.window_hours if before.quality else DEFAULT_HOURS
        check_signal(ctx.conn, signal, now, hours)
    return _get(ctx, signal_id)


@router.post("/sites/{site_id}/signals/quality", response_model=QualityCheckOut)
def check_quality(ctx: Editor, body: QualityCheckIn) -> QualityCheckOut:
    """Checks the quality of the site's signals (all, or those listed) over the `hours` up to each one's
    latest reading, and stores each report as the signal's latest (engineers and admins). Audited."""
    badges = check_site(ctx.conn, ctx.site_id, body.signal_ids, body.hours)
    checked = sum(badges.values())
    ctx.audit(
        "signal.quality_check",
        "site",
        str(ctx.site_id),
        after={"hours": body.hours, "checked": checked, **badges},
    )
    return QualityCheckOut(checked=checked, badges=badges)
