"""Warnings and their workflow (T3.07). A detector raises a warning (api_detectors.py); engineers
then acknowledge it, assign it to someone, and resolve it with an outcome: a true alarm, a false
alarm, or unknown. A resolved warning can be reopened. Every step, and any comment, is kept in the
warning's activity, and audited.

`state` is the signal's side of it (still out, or back in); `status` is the people's (raised,
acknowledged, resolved). They are independent: a warning can be resolved while its signal is still
out, and one whose signal came back can still be waiting for someone.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field

from tiles_api.api_ontology import Ctx, Editor, SiteContext, can_edit

router = APIRouter(tags=["warnings"])

Outcome = Literal["true_alarm", "false_alarm", "unknown"]
Status = Literal["raised", "acknowledged", "resolved"]
Note = Annotated[str, Field(max_length=2000)]


class WarningOut(BaseModel):
    id: uuid.UUID
    detector_id: uuid.UUID
    detector: str
    signal_id: uuid.UUID
    signal_tag: str
    started_at: datetime
    last_at: datetime
    ended_at: datetime | None  # when the signal came back; None while it is still out
    side: Literal["above", "below"]
    peak: float
    baseline: float
    threshold: float
    readings: int
    status: Status
    acknowledged_at: datetime | None
    acknowledged_by: str | None
    assignee_id: uuid.UUID | None
    assignee: str | None
    resolved_at: datetime | None
    resolved_by: str | None
    outcome: Outcome | None
    resolution_note: str


class Activity(BaseModel):
    at: datetime
    action: Literal["raised", "acknowledged", "assigned", "unassigned", "resolved", "reopened", "commented"]
    # Raised is when the detector stored it, for people to see: later than its start when the
    # detector caught up on history. The others are people's steps.
    actor: str | None  # None for raised: the detector did it
    assignee: str | None
    outcome: Outcome | None
    note: str


class WarningDetail(WarningOut):
    detector_config: dict[str, Any]
    activity: list[Activity]  # oldest first, starting with raised


class NoteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: Note = ""


class CommentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: Annotated[str, Field(min_length=1, max_length=2000, pattern=r"\S")]


class AssignIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: uuid.UUID | None  # None unassigns
    note: Note = ""


class ResolveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Outcome
    note: Note = ""


WARNINGS = """
SELECT w.id, w.detector_id, d.name AS detector, w.signal_id, g.tag AS signal_tag, w.started_at, w.last_at,
       w.ended_at, w.side, w.peak, w.baseline, w.threshold, w.readings,
       CASE WHEN w.resolved_at IS NOT NULL THEN 'resolved'
            WHEN w.acknowledged_at IS NOT NULL THEN 'acknowledged'
            ELSE 'raised' END AS status,
       w.acknowledged_at, ack.name AS acknowledged_by, w.assignee_id, who.name AS assignee,
       w.resolved_at, res.name AS resolved_by, w.outcome, w.resolution_note{detail}
FROM warnings w
JOIN detectors d ON d.id = w.detector_id
JOIN signals g ON g.id = w.signal_id
LEFT JOIN users ack ON ack.id = w.acknowledged_by
LEFT JOIN users who ON who.id = w.assignee_id
LEFT JOIN users res ON res.id = w.resolved_by
WHERE w.site_id = %(site)s
"""

# Each filter is off when its parameter is null (or 'all').
FILTERS = """
  AND (%(signal)s::uuid IS NULL OR w.signal_id = %(signal)s)
  AND (%(state)s = 'all' OR (%(state)s = 'open') = (w.ended_at IS NULL))
  AND CASE %(status)s
        WHEN 'all' THEN true
        WHEN 'unresolved' THEN w.resolved_at IS NULL
        WHEN 'resolved' THEN w.resolved_at IS NOT NULL
        WHEN 'acknowledged' THEN w.acknowledged_at IS NOT NULL AND w.resolved_at IS NULL
        ELSE w.acknowledged_at IS NULL
      END
  AND (NOT %(unassigned)s OR w.assignee_id IS NULL)
  AND (%(assignee)s::uuid IS NULL OR w.assignee_id = %(assignee)s)
  AND (%(outcome)s::text IS NULL OR w.outcome = %(outcome)s)
"""


@router.get("/sites/{site_id}/warnings", response_model=list[WarningOut])
def list_warnings(
    ctx: Ctx,
    state: Literal["open", "ended", "all"] = "all",
    status_: Annotated[
        Literal["raised", "acknowledged", "resolved", "unresolved", "all"], Query(alias="status")
    ] = "all",
    assignee: Annotated[str | None, Query(description="me, none, or a user's id")] = None,
    outcome: Outcome | None = None,
    signal_id: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[dict[str, Any]]:
    """The site's warnings, newest first. `state`: the signal still out (open) or back (ended).
    `status`: raised (nobody has looked yet), acknowledged, resolved, or unresolved (either of
    the first two). `assignee`: me, none (unassigned), or a user's id."""
    who: uuid.UUID | None = None
    if assignee == "me":
        who = ctx.user.id
    elif assignee not in (None, "none"):
        try:
            who = uuid.UUID(assignee)
        except ValueError as e:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "assignee: me, none, or a user's id") from e
    params = {
        "site": ctx.site_id,
        "signal": signal_id,
        "state": state,
        "status": status_,
        "unassigned": assignee == "none",
        "assignee": who,
        "outcome": outcome,
        "limit": limit,
        "offset": offset,
    }
    return ctx.conn.execute(
        WARNINGS.format(detail="") + FILTERS + " ORDER BY w.started_at DESC, w.id LIMIT %(limit)s OFFSET %(offset)s",
        params,
    ).fetchall()


def _detail(ctx: SiteContext, warning_id: uuid.UUID) -> dict[str, Any]:
    query = WARNINGS.format(detail=", d.config AS detector_config, w.created_at") + " AND w.id = %(id)s"
    row = ctx.conn.execute(query, {"site": ctx.site_id, "id": warning_id}).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such warning")
    steps = ctx.conn.execute(
        """
        SELECT a.at, a.action, u.name AS actor, who.name AS assignee, a.outcome, a.note
        FROM warning_activity a
        LEFT JOIN users u ON u.id = a.actor_id
        LEFT JOIN users who ON who.id = a.assignee_id
        WHERE a.warning_id = %s ORDER BY a.id
        """,
        [warning_id],
    ).fetchall()
    raised = {"at": row["created_at"], "action": "raised", "actor": None, "assignee": None, "outcome": None, "note": ""}
    return row | {"activity": [raised, *steps]}


@router.get("/sites/{site_id}/warnings/{warning_id}", response_model=WarningDetail)
def get_warning(ctx: Ctx, warning_id: uuid.UUID) -> dict[str, Any]:
    """One warning, with its detector's settings and its activity."""
    return _detail(ctx, warning_id)


def _lock(ctx: SiteContext, warning_id: uuid.UUID, resolved: bool) -> dict[str, Any]:
    """The warning's row, locked until the change commits, so two people's steps go one at a time;
    409 unless it is resolved (or not) as the step needs."""
    row = ctx.conn.execute(
        "SELECT * FROM warnings WHERE site_id = %s AND id = %s FOR UPDATE", [ctx.site_id, warning_id]
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such warning")
    if resolved and row["resolved_at"] is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This warning is not resolved")
    if not resolved and row["resolved_at"] is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This warning is resolved; reopen it first")
    return row


def _step(
    ctx: SiteContext,
    warning_id: uuid.UUID,
    action: str,
    note: str = "",
    assignee: uuid.UUID | None = None,
    outcome: str | None = None,
) -> None:
    ctx.conn.execute(
        """
        INSERT INTO warning_activity (warning_id, actor_id, action, assignee_id, outcome, note)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        [warning_id, ctx.user.id, action, assignee, outcome, note],
    )


def _acknowledge(ctx: SiteContext, warning: dict[str, Any], note: str = "") -> bool:
    """Acknowledges the warning (and audits it) if nobody has yet; True if this did."""
    if warning["acknowledged_at"] is not None:
        return False
    ctx.conn.execute(
        "UPDATE warnings SET acknowledged_at = now(), acknowledged_by = %s WHERE id = %s", [ctx.user.id, warning["id"]]
    )
    _step(ctx, warning["id"], "acknowledged", note)
    ctx.audit("warning.acknowledge", "warning", str(warning["id"]), after={"note": note})
    return True


def _comment(ctx: SiteContext, warning_id: uuid.UUID, note: str) -> None:
    _step(ctx, warning_id, "commented", note)
    ctx.audit("warning.comment", "warning", str(warning_id), after={"note": note})


@router.post("/sites/{site_id}/warnings/{warning_id}/acknowledge", response_model=WarningDetail)
def acknowledge(ctx: Editor, warning_id: uuid.UUID, body: NoteIn) -> dict[str, Any]:
    """Say someone is looking at it."""
    warning = _lock(ctx, warning_id, resolved=False)
    if not _acknowledge(ctx, warning, body.note):
        raise HTTPException(status.HTTP_409_CONFLICT, "This warning is already acknowledged")
    return _detail(ctx, warning_id)


@router.put("/sites/{site_id}/warnings/{warning_id}/assignee", response_model=WarningDetail)
def assign(ctx: Editor, warning_id: uuid.UUID, body: AssignIn) -> dict[str, Any]:
    """Assign it to an engineer or admin of the site (acknowledging it, if nobody had), or unassign
    it (`user_id` null). Assigning it to whom it is already assigned only keeps the note, as a comment."""
    warning = _lock(ctx, warning_id, resolved=False)
    # Checked first: it stays with whom it is, even if they can no longer be given new ones.
    if body.user_id == warning["assignee_id"]:
        if body.note.strip():
            _comment(ctx, warning_id, body.note)
        return _detail(ctx, warning_id)
    if body.user_id is not None and not can_edit(ctx.conn, ctx.site_id, ctx.org_id, body.user_id):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Not an engineer or admin of this site")
    if body.user_id is not None:
        _acknowledge(ctx, warning)
    ctx.conn.execute("UPDATE warnings SET assignee_id = %s WHERE id = %s", [body.user_id, warning_id])
    _step(ctx, warning_id, "assigned" if body.user_id else "unassigned", body.note, assignee=body.user_id)
    before = {"assignee_id": str(warning["assignee_id"]) if warning["assignee_id"] else None}
    after = {"assignee_id": str(body.user_id) if body.user_id else None, "note": body.note}
    ctx.audit("warning.assign", "warning", str(warning_id), before=before, after=after)
    return _detail(ctx, warning_id)


@router.post("/sites/{site_id}/warnings/{warning_id}/resolve", response_model=WarningDetail)
def resolve(ctx: Editor, warning_id: uuid.UUID, body: ResolveIn) -> dict[str, Any]:
    """Close it with its outcome: a true alarm, a false alarm, or unknown (acknowledging it, if
    nobody had). Its signal may still be out."""
    warning = _lock(ctx, warning_id, resolved=False)
    _acknowledge(ctx, warning)
    ctx.conn.execute(
        """
        UPDATE warnings SET resolved_at = now(), resolved_by = %s, outcome = %s, resolution_note = %s
        WHERE id = %s
        """,
        [ctx.user.id, body.outcome, body.note, warning_id],
    )
    _step(ctx, warning_id, "resolved", body.note, outcome=body.outcome)
    ctx.audit("warning.resolve", "warning", str(warning_id), after={"outcome": body.outcome, "note": body.note})
    return _detail(ctx, warning_id)


@router.post("/sites/{site_id}/warnings/{warning_id}/reopen", response_model=WarningDetail)
def reopen(ctx: Editor, warning_id: uuid.UUID, body: NoteIn) -> dict[str, Any]:
    """Undo a resolution (it stays acknowledged, and assigned)."""
    warning = _lock(ctx, warning_id, resolved=True)
    ctx.conn.execute(
        """
        UPDATE warnings SET resolved_at = NULL, resolved_by = NULL, outcome = NULL, resolution_note = ''
        WHERE id = %s
        """,
        [warning_id],
    )
    _step(ctx, warning_id, "reopened", body.note)
    before = {"outcome": warning["outcome"], "note": warning["resolution_note"]}
    ctx.audit("warning.reopen", "warning", str(warning_id), before=before, after={"note": body.note})
    return _detail(ctx, warning_id)


@router.post(
    "/sites/{site_id}/warnings/{warning_id}/comments",
    response_model=WarningDetail,
    status_code=status.HTTP_201_CREATED,
)
def comment(ctx: Editor, warning_id: uuid.UUID, body: CommentIn) -> dict[str, Any]:
    """Add a note to its activity, whatever its status (without waiting on its other steps)."""
    if not ctx.conn.execute(
        "SELECT 1 FROM warnings WHERE site_id = %s AND id = %s", [ctx.site_id, warning_id]
    ).fetchone():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such warning")
    _comment(ctx, warning_id, body.note)
    return _detail(ctx, warning_id)
