"""Planned stops over HTTP (T7.03, migration 0039): planned downtime that Warning performance and the
ROI report leave out, entered by hand per asset (or for the whole site) or marked by the MES's
planned-downtime codes. Engineers change them, audited; everyone reads them."""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query, Response, status
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from tiles_api.api_ontology import Ctx, Editor
from tiles_api.errors import Problem
from tiles_api.store import one

router = APIRouter(tags=["warnings"])

Asset = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^\S(.*\S)?$")]
Code = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^\S(.*\S)?$")]


class StopIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asset: Asset | None = None  # the machine as the MES names it; none: the whole site
    starts_at: AwareDatetime
    ends_at: AwareDatetime
    reason: str = Field("", max_length=200)


class Stop(BaseModel):
    id: uuid.UUID
    asset: str | None
    starts_at: datetime
    ends_at: datetime
    reason: str
    created_by: str | None
    created_at: datetime


class CodesIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    codes: list[Code] = Field(max_length=200)


class Planned(BaseModel):
    stops: list[Stop]
    more: bool  # more stops than these overlap the range: ask for a shorter one
    codes: list[str]  # the MES's planned-downtime codes


MAX_STOPS = 500

STOPS = """
SELECT p.id, p.asset, p.starts_at, p.ends_at, p.reason, u.name AS created_by, p.created_at
FROM planned_stops p LEFT JOIN users u ON u.id = p.created_by
"""


def _codes(ctx: Ctx) -> list[str]:
    rows = ctx.conn.execute("SELECT code FROM planned_codes WHERE site_id = %s ORDER BY code", [ctx.site_id])
    return [r["code"] for r in rows.fetchall()]


@router.get("/sites/{site_id}/planned-stops", response_model=Planned)
def planned_stops(
    ctx: Ctx,
    since: Annotated[AwareDatetime | None, Query()] = None,
    until: Annotated[AwareDatetime | None, Query()] = None,
) -> dict[str, Any]:
    """The site's planned stops that overlap `since`…`until` (all of them without), latest first, at
    most 500 (`more` says there are others), and its planned-downtime codes."""
    rows = ctx.conn.execute(
        STOPS + " WHERE p.site_id = %(site)s AND (%(until)s::timestamptz IS NULL OR p.starts_at < %(until)s)"
        " AND (%(since)s::timestamptz IS NULL OR p.ends_at > %(since)s) ORDER BY p.starts_at DESC LIMIT %(limit)s",
        {"site": ctx.site_id, "since": since, "until": until, "limit": MAX_STOPS + 1},
    ).fetchall()
    return {"stops": rows[:MAX_STOPS], "more": len(rows) > MAX_STOPS, "codes": _codes(ctx)}


@router.post("/sites/{site_id}/planned-stops", response_model=Stop, status_code=status.HTTP_201_CREATED)
def add_planned_stop(ctx: Editor, body: StopIn) -> dict[str, Any]:
    """Enters a planned stop for an asset (or, without one, for the whole site). Engineers and
    admins; audited."""
    if body.ends_at <= body.starts_at:
        raise Problem(status.HTTP_422_UNPROCESSABLE_CONTENT, "planned.order", "A planned stop must end after it starts")
    row = ctx.conn.execute(
        "INSERT INTO planned_stops (site_id, asset, starts_at, ends_at, reason, created_by)"
        " VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
        [ctx.site_id, body.asset, body.starts_at, body.ends_at, body.reason, ctx.user.id],
    ).fetchone()
    stop = one(ctx.conn.execute(STOPS + " WHERE p.id = %s", [one(row)["id"]]).fetchone())
    ctx.audit("planned_stop.create", "planned_stop", str(stop["id"]), after=body.model_dump(mode="json"))
    return dict(stop)


@router.delete("/sites/{site_id}/planned-stops/{stop_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_planned_stop(ctx: Editor, stop_id: uuid.UUID) -> Response:
    """Removes a planned stop. Engineers and admins; audited."""
    gone = ctx.conn.execute(
        "DELETE FROM planned_stops WHERE site_id = %s AND id = %s RETURNING asset, starts_at, ends_at, reason",
        [ctx.site_id, stop_id],
    ).fetchone()
    if gone is None:
        raise Problem(status.HTTP_404_NOT_FOUND, "planned.not_found", "No such planned stop")
    ctx.audit(
        "planned_stop.delete",
        "planned_stop",
        str(stop_id),
        before={k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in gone.items()},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/sites/{site_id}/planned-codes", response_model=Planned)
def set_planned_codes(ctx: Editor, body: CodesIn) -> dict[str, Any]:
    """Sets the MES's planned-downtime codes: a downtime event with one of them is planned, and
    Warning performance and the ROI report leave it out. Engineers and admins; audited."""
    before = _codes(ctx)
    after = sorted(set(body.codes))
    # One change of a site's codes at a time, so two at once can't both insert a code.
    ctx.conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('planned_codes:' || %s::text, 0))", [ctx.site_id])
    ctx.conn.execute("DELETE FROM planned_codes WHERE site_id = %s", [ctx.site_id])
    ctx.conn.execute("INSERT INTO planned_codes (site_id, code) SELECT %s, unnest(%s::text[])", [ctx.site_id, after])
    if before != after:
        ctx.audit("planned_codes.update", "site", str(ctx.site_id), before={"codes": before}, after={"codes": after})
    return planned_stops(ctx)
