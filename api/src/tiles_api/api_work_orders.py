"""Work orders out (T9.02): drafted from a warning or a component's remaining life (or by hand),
approved by a person, exported for the plant's CMMS, and closed with their outcome. Audited.

Outbound only: Tiles never reads or changes the CMMS. The first way out is a CSV file the planner
imports (most CMMSs take one: SAP PM through LSMW or a mass upload, Maximo through its integration
framework); an API connection to SAP PM or Maximo comes once the partner's IT allows one.

A draft names its machine by the MES's asset name: the warning's detector's asset, or the machine
whose Signal node the component's tag is linked to (coverage.asset_of), else the signal's own asset.
Someone other than its drafter approves it, admins included, as change requests are reviewed, so
two people see every work order. One open work order per warning: a second draft from it names the first.

Lifecycle: draft → approved → exported → done; draft, approved or exported → cancelled.
"""

import csv
import io
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, status
from pydantic import AwareDatetime, BaseModel, Field, model_validator

from tiles_api import coverage, ontology_store
from tiles_api.api_ontology import Admin, Ctx, Editor, SiteContext
from tiles_api.errors import Problem
from tiles_api.store import Conn, one

router = APIRouter(tags=["work orders"])

Status = Literal["draft", "approved", "exported", "done", "cancelled"]
OPEN: tuple[Status, ...] = ("draft", "approved", "exported")
MAX_LIST = 500
MAX_ASSET = 100  # characters, as the MES's asset names are kept

# The CSV's columns, in order: what a CMMS's import needs to raise a notification or work order.
CSV_COLUMNS = (
    "number",
    "asset",
    "title",
    "description",
    "priority",
    "due",
    "source",
    "warning_signal",
    "warning_started",
    "component_signal",
    "drafted_by",
    "approved_by",
)


class WorkOrderIn(BaseModel):
    source: Literal["warning", "remaining_life", "manual"]
    warning_id: uuid.UUID | None = None
    signal_id: uuid.UUID | None = None  # the component's wear signal (remaining life)
    asset: Annotated[str, Field(min_length=1, max_length=100)] | None = None  # by hand
    title: Annotated[str, Field(min_length=1, max_length=200)]
    description: Annotated[str, Field(max_length=4000)] = ""
    priority: Literal["low", "medium", "high"] = "medium"
    due_at: AwareDatetime | None = None

    @model_validator(mode="after")
    def _source(self) -> "WorkOrderIn":
        if self.source == "warning" and self.warning_id is None:
            raise Problem(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "work_order.needs_warning", "Name the warning it is drafted from"
            )
        if self.source == "remaining_life" and self.signal_id is None:
            raise Problem(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "work_order.needs_signal",
                "Name the component's signal it is drafted from",
            )
        return self


class WorkOrderNote(BaseModel):
    note: Annotated[str, Field(max_length=2000)] = ""


class WorkOrderOutcome(BaseModel):
    outcome: Literal["done", "not_needed"]
    note: Annotated[str, Field(max_length=2000)] = ""


class WorkOrder(BaseModel):
    number: int
    source: Literal["warning", "remaining_life", "manual"]
    warning_id: uuid.UUID | None
    warning_tag: str | None
    warning_started_at: datetime | None
    signal_id: uuid.UUID | None
    signal_tag: str | None
    asset: str | None
    title: str
    description: str
    priority: Literal["low", "medium", "high"]
    due_at: datetime | None
    status: Status
    drafted_by: str
    drafted_at: datetime
    approved_by: str | None
    approved_at: datetime | None
    exported_at: datetime | None
    export_ref: str | None
    outcome: Literal["done", "not_needed"] | None
    outcome_note: str
    closed_at: datetime | None
    mine: bool  # drafted by the person asking: someone else approves it


class WorkOrderExportIn(BaseModel):
    again: Annotated[str, Field(min_length=1, max_length=100)] | None = None  # an earlier export's name


class WorkOrderExport(BaseModel):
    name: str  # the file's name, also each work order's export_ref
    numbers: list[int]
    csv: str


SELECT = """
SELECT o.*, g.tag AS signal_tag, wg.tag AS warning_tag, w.started_at AS warning_started_at
FROM work_orders o
LEFT JOIN signals g ON g.id = o.signal_id
LEFT JOIN warnings w ON w.id = o.warning_id
LEFT JOIN signals wg ON wg.id = w.signal_id
WHERE o.site_id = %(site)s
"""


def _out(ctx: SiteContext, row: dict[str, Any]) -> dict[str, Any]:
    return {**row, "mine": row["drafted_by_id"] == ctx.user.id}


def get(ctx: SiteContext, number: int, lock: bool = False) -> dict[str, Any]:
    if lock:
        ctx.conn.execute(
            "SELECT 1 FROM work_orders WHERE site_id = %s AND number = %s FOR UPDATE", [ctx.site_id, number]
        )
    row: dict[str, Any] | None = ctx.conn.execute(
        SELECT + " AND o.number = %(n)s", {"site": ctx.site_id, "n": number}
    ).fetchone()
    if row is None:
        raise Problem(
            status.HTTP_404_NOT_FOUND, "work_order.not_found", f"No work order {number} on this site", number=number
        )
    return row


def _expect(row: dict[str, Any], *allowed: Status) -> None:
    if row["status"] not in allowed:
        raise Problem(
            status.HTTP_409_CONFLICT,
            "work_order.wrong_status",
            f"Work order {row['number']} is {row['status']}",
            number=row["number"],
            status=row["status"],
        )


@router.get("/sites/{site_id}/work-orders", response_model=list[WorkOrder])
def list_work_orders(
    ctx: Ctx,
    show: Annotated[Literal["open", "all", "draft", "approved", "exported", "done", "cancelled"], Query()] = "open",
) -> list[dict[str, Any]]:
    """The site's work orders, newest first: those still open (draft, approved or exported) by
    default, all of them, or those with one status."""
    statuses = list(OPEN) if show == "open" else None if show == "all" else [show]
    rows = ctx.conn.execute(
        SELECT + " AND (%(statuses)s::text[] IS NULL OR o.status = ANY(%(statuses)s)) ORDER BY o.number DESC"
        " LIMIT %(limit)s",
        {"site": ctx.site_id, "statuses": statuses, "limit": MAX_LIST},
    ).fetchall()
    return [_out(ctx, r) for r in rows]


class WorkOrderPolicy(BaseModel):
    # Tiles drafts a work order for each component predicted to reach its wear limit within this
    # many days (tiles-draft-work-orders); None: it doesn't.
    lead_days: Annotated[int, Field(ge=1, le=365)] | None = None


@router.get("/sites/{site_id}/work-orders/policy", response_model=WorkOrderPolicy)
def get_policy(ctx: Ctx) -> dict[str, Any]:
    """Whether Tiles drafts work orders for components nearing their wear limit, and how early."""
    row = one(ctx.conn.execute("SELECT work_order_lead_days FROM sites WHERE id = %s", [ctx.site_id]).fetchone())
    return {"lead_days": row["work_order_lead_days"]}


@router.put("/sites/{site_id}/work-orders/policy", response_model=WorkOrderPolicy)
def set_policy(ctx: Admin, body: WorkOrderPolicy) -> dict[str, Any]:
    """Sets how many days before a component's predicted wear limit Tiles drafts a work order for it,
    or turns that off (admins). Audited."""
    before = get_policy(ctx)
    ctx.conn.execute("UPDATE sites SET work_order_lead_days = %s WHERE id = %s", [body.lead_days, ctx.site_id])
    ctx.audit("work_order.policy", "site", str(ctx.site_id), before=before, after=body.model_dump())
    return body.model_dump()


@router.get("/sites/{site_id}/work-orders/{number}", response_model=WorkOrder)
def get_work_order(ctx: Ctx, number: int) -> dict[str, Any]:
    """One work order."""
    return _out(ctx, get(ctx, number))


def fit_asset(asset: Any) -> str | None:
    """An asset name the work order can keep: 1 to 100 characters, else none."""
    text = str(asset).strip() if asset else ""
    return text if 0 < len(text) <= MAX_ASSET else None


def machine_asset(conn: Conn, site_id: uuid.UUID, signal_id: uuid.UUID) -> str | None:
    """The asset of the machine whose Signal node the tag is linked to, else the signal's own."""
    signal = conn.execute(
        "SELECT node_id, asset FROM signals WHERE site_id = %s AND id = %s", [site_id, signal_id]
    ).fetchone()
    if signal is None:
        raise Problem(status.HTTP_404_NOT_FOUND, "signal.not_found", "No such signal on this site")
    if signal["node_id"]:
        graph = ontology_store.load_head(conn, site_id)
        index = coverage.Index(graph)
        machine = next(
            (m for m in coverage.machines_under(index, None) if signal["node_id"] in coverage.signal_nodes(index, m)),
            None,
        )
        if machine and (found := fit_asset(coverage.asset_of(graph, machine))):
            return found
    return fit_asset(signal["asset"])


def _asset_of(ctx: SiteContext, body: WorkOrderIn) -> str | None:
    """The machine's asset: the warning's detector's, else the machine of its signal; the machine of
    the component's signal; or the one given by hand."""
    if body.warning_id is not None:
        found = ctx.conn.execute(
            "SELECT d.asset, w.signal_id FROM warnings w JOIN detectors d ON d.id = w.detector_id"
            " WHERE w.site_id = %s AND w.id = %s",
            [ctx.site_id, body.warning_id],
        ).fetchone()
        if found is None:
            raise Problem(status.HTTP_404_NOT_FOUND, "warning.not_found", "No such warning")
        return fit_asset(found["asset"]) or machine_asset(ctx.conn, ctx.site_id, found["signal_id"])
    if body.signal_id is not None:
        return machine_asset(ctx.conn, ctx.site_id, body.signal_id)
    return body.asset


@router.post("/sites/{site_id}/work-orders", response_model=WorkOrder, status_code=status.HTTP_201_CREATED)
def draft(ctx: Editor, body: WorkOrderIn) -> dict[str, Any]:
    """Drafts a work order from a warning, a component's remaining life or by hand (engineers and
    admins); someone else approves it. Audited."""
    asset = _asset_of(ctx, body)
    if body.warning_id is not None:
        # One open work order per warning, whoever drafts it.
        ctx.conn.execute("SELECT 1 FROM warnings WHERE id = %s FOR UPDATE", [body.warning_id])
        taken = ctx.conn.execute(
            "SELECT number FROM work_orders WHERE site_id = %s AND warning_id = %s AND status = ANY(%s)",
            [ctx.site_id, body.warning_id, list(OPEN)],
        ).fetchone()
        if taken:
            raise Problem(
                status.HTTP_409_CONFLICT,
                "work_order.exists",
                f"Work order {taken['number']} is already open for this warning",
                number=taken["number"],
            )
    if body.source == "remaining_life" and body.signal_id is not None:
        _component_free(ctx.conn, ctx.site_id, body.signal_id)
    number = insert(
        ctx.conn,
        ctx.site_id,
        source=body.source,
        warning_id=body.warning_id,
        signal_id=body.signal_id,
        asset=asset,
        title=body.title,
        description=body.description,
        priority=body.priority,
        due_at=body.due_at,
        drafted_by_id=ctx.user.id,
        drafted_by=ctx.user.name,
    )
    row = get(ctx, number)
    ctx.audit("work_order.draft", "work_order", str(number), after=audited(row))
    return _out(ctx, row)


def open_for_component(conn: Conn, site_id: uuid.UUID, signal_id: uuid.UUID) -> int | None:
    """The number of the component's open work order, if it has one (locking the signal, so two
    drafts at once can't both find none)."""
    conn.execute("SELECT 1 FROM signals WHERE site_id = %s AND id = %s FOR UPDATE", [site_id, signal_id])
    row = conn.execute(
        "SELECT number FROM work_orders WHERE site_id = %s AND signal_id = %s AND source = 'remaining_life'"
        " AND status = ANY(%s)",
        [site_id, signal_id, list(OPEN)],
    ).fetchone()
    return int(row["number"]) if row else None


def _component_free(conn: Conn, site_id: uuid.UUID, signal_id: uuid.UUID) -> None:
    taken = open_for_component(conn, site_id, signal_id)
    if taken is not None:
        raise Problem(
            status.HTTP_409_CONFLICT,
            "work_order.exists_component",
            f"Work order {taken} is already open for this component",
            number=taken,
        )


def insert(
    conn: Conn,
    site_id: uuid.UUID,
    *,
    source: str,
    warning_id: uuid.UUID | None,
    signal_id: uuid.UUID | None,
    asset: str | None,
    title: str,
    description: str,
    priority: str,
    due_at: datetime | None,
    drafted_by_id: uuid.UUID | None,  # None: drafted by Tiles
    drafted_by: str,
) -> int:
    """A new draft, numbered after the site's last; its number."""
    number = int(
        one(
            conn.execute(
                "INSERT INTO work_order_numbers (site_id, last) VALUES (%s, 1)"
                " ON CONFLICT (site_id) DO UPDATE SET last = work_order_numbers.last + 1 RETURNING last",
                [site_id],
            ).fetchone()
        )["last"]
    )
    conn.execute(
        """
        INSERT INTO work_orders (site_id, number, source, warning_id, signal_id, asset, title, description,
                                 priority, due_at, drafted_by_id, drafted_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        [
            site_id,
            number,
            source,
            warning_id,
            signal_id,
            asset,
            title,
            description,
            priority,
            due_at,
            drafted_by_id,
            drafted_by,
        ],
    )
    return number


def audited(row: dict[str, Any]) -> dict[str, Any]:
    keys = ("number", "status", "source", "asset", "title", "priority", "due_at", "warning_id", "signal_id")
    return {k: str(row[k]) if isinstance(row[k], (uuid.UUID, datetime)) else row[k] for k in keys}


@router.post("/sites/{site_id}/work-orders/{number}/approve", response_model=WorkOrder)
def approve(ctx: Editor, number: int, body: WorkOrderNote) -> dict[str, Any]:
    """Approves a draft for export (engineers and admins; not its drafter). Audited."""
    row = get(ctx, number, lock=True)
    _expect(row, "draft")
    if row["drafted_by_id"] == ctx.user.id:
        raise Problem(
            status.HTTP_403_FORBIDDEN,
            "work_order.own_draft",
            "You drafted this work order, so someone else approves it: ask another engineer",
        )
    ctx.conn.execute(
        "UPDATE work_orders SET status = 'approved', approved_by_id = %s, approved_by = %s,"
        " approved_at = clock_timestamp() WHERE site_id = %s AND number = %s",
        [ctx.user.id, ctx.user.name, ctx.site_id, number],
    )
    ctx.audit("work_order.approve", "work_order", str(number), before={"status": "draft"}, after={"note": body.note})
    return _out(ctx, get(ctx, number))


@router.post("/sites/{site_id}/work-orders/{number}/cancel", response_model=WorkOrder)
def cancel(ctx: Editor, number: int, body: WorkOrderNote) -> dict[str, Any]:
    """Cancels an open work order (engineers and admins), with why. Audited."""
    row = get(ctx, number, lock=True)
    _expect(row, *OPEN)
    ctx.conn.execute(
        "UPDATE work_orders SET status = 'cancelled', outcome_note = %s, closed_at = clock_timestamp()"
        " WHERE site_id = %s AND number = %s",
        [body.note, ctx.site_id, number],
    )
    ctx.audit(
        "work_order.cancel", "work_order", str(number), before={"status": row["status"]}, after={"note": body.note}
    )
    return _out(ctx, get(ctx, number))


@router.post("/sites/{site_id}/work-orders/{number}/outcome", response_model=WorkOrder)
def record_outcome(ctx: Editor, number: int, body: WorkOrderOutcome) -> dict[str, Any]:
    """Closes an approved or exported work order with its outcome: done, or not needed once looked
    at (engineers and admins). Audited."""
    row = get(ctx, number, lock=True)
    _expect(row, "approved", "exported")
    ctx.conn.execute(
        "UPDATE work_orders SET status = 'done', outcome = %s, outcome_note = %s, closed_at = clock_timestamp()"
        " WHERE site_id = %s AND number = %s",
        [body.outcome, body.note, ctx.site_id, number],
    )
    ctx.audit(
        "work_order.outcome",
        "work_order",
        str(number),
        before={"status": row["status"]},
        after={"outcome": body.outcome, "note": body.note},
    )
    return _out(ctx, get(ctx, number))


def _cell(value: Any) -> str:
    """A CSV cell; text that a spreadsheet would run as a formula starts with a quote instead."""
    text = "" if value is None else value.isoformat() if isinstance(value, datetime) else str(value)
    return f"'{text}" if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


@router.post("/sites/{site_id}/work-orders/export", response_model=WorkOrderExport)
def export(ctx: Editor, body: WorkOrderExportIn | None = None) -> dict[str, Any]:
    """Every approved work order as one CSV file for the CMMS, each then marked exported with the
    file's name (engineers and admins); or, with `again`, an earlier export's file once more (its
    work orders as they were sent, whatever they are now, but cancelled ones). Audited."""
    again = body.again if body else None
    if again:
        rows = ctx.conn.execute(
            SELECT + " AND o.export_ref = %(ref)s AND o.status <> 'cancelled' ORDER BY o.number",
            {"site": ctx.site_id, "ref": again},
        ).fetchall()
        if not rows:
            raise Problem(
                status.HTTP_404_NOT_FOUND, "work_order.no_export", f"No export {again} on this site", file=again
            )
        name = again
    else:
        rows = ctx.conn.execute(
            SELECT + " AND o.status = 'approved' ORDER BY o.number FOR UPDATE OF o", {"site": ctx.site_id}
        ).fetchall()
        if not rows:
            raise Problem(status.HTTP_409_CONFLICT, "work_order.none_approved", "No approved work order to export")
        # Named to the millisecond, with its first work order's number: two exports never share a name.
        now = datetime.now(UTC)
        name = f"tiles-work-orders-{now:%Y%m%d-%H%M%S}-{now.microsecond // 1000:03d}-{rows[0]['number']}.csv"
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(CSV_COLUMNS)
    for r in rows:
        writer.writerow(
            _cell(v)
            for v in (
                r["number"],
                r["asset"],
                r["title"],
                r["description"],
                r["priority"],
                r["due_at"],
                r["source"],
                r["warning_tag"],
                r["warning_started_at"],
                r["signal_tag"],
                r["drafted_by"],
                r["approved_by"],
            )
        )
    numbers = [r["number"] for r in rows]
    if not again:
        ctx.conn.execute(
            "UPDATE work_orders SET status = 'exported', exported_at = clock_timestamp(), export_ref = %s"
            " WHERE site_id = %s AND number = ANY(%s)",
            [name, ctx.site_id, numbers],
        )
    ctx.audit(
        "work_order.export_again" if again else "work_order.export",
        "site",
        str(ctx.site_id),
        after={"file": name, "numbers": numbers},
    )
    return {"name": name, "numbers": numbers, "csv": out.getvalue()}
