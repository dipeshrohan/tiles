"""Similar past warnings over HTTP (T10.02): for a warning, the earlier warnings most like it
(similar.py), with how each was resolved and what followed it, and the batch tables to open in the
correlation finder.

The candidates are the site's warnings that started before it on the same signal, from the same
detector or for the same asset (the latest MAX_CANDIDATES). What followed a past warning is the first
event of its asset (downtime, scrap, other; planned downtime left out, T7.03) in the FOLLOW hours
after it started. A batch table is suggested when its name or description names the warning's
asset or tag, a column is named as the tag, or a row has the asset as a value. Everyone reads it.
"""

import uuid
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, status
from pydantic import BaseModel

from tiles_api import similar
from tiles_api.api_ontology import Ctx
from tiles_api.errors import Problem

router = APIRouter(tags=["warnings"])

MAX_CANDIDATES = 1000
FOLLOW = timedelta(hours=24)
MAX_DATASETS = 5


class Followed(BaseModel):
    kind: Literal["downtime", "scrap", "other"]
    code: str
    at: datetime
    hours_after: float  # after the warning started


class SimilarWarning(BaseModel):
    id: uuid.UUID
    detector: str
    signal_tag: str
    asset: str | None
    started_at: datetime
    ended_at: datetime | None
    status: Literal["raised", "acknowledged", "resolved"]
    outcome: Literal["true_alarm", "false_alarm", "unknown"] | None
    resolution_note: str
    resolved_at: datetime | None
    score: float  # 0 to 1
    shared: list[Literal["signal", "detector", "asset", "side"]]
    severity: float  # how far past its threshold: 1 at it
    hours: float  # how long the signal was out
    followed: Followed | None  # the first event of its asset within FOLLOW hours


class SuggestedDataset(BaseModel):
    id: uuid.UUID
    name: str
    why: Literal["name", "column", "value"]


class Similar(BaseModel):
    warning_id: uuid.UUID
    asset: str | None
    severity: float
    hours: float
    compared: int  # earlier warnings looked at
    similar: list[SimilarWarning]  # most alike first
    outcomes: dict[str, int]  # of those shown: true_alarm, false_alarm, unknown, open
    followed: int  # of those shown, how many an event followed
    datasets: list[SuggestedDataset]


SEEN = """
SELECT w.id, d.name AS detector, w.detector_id, w.signal_id, g.tag AS signal_tag, d.asset, w.side, w.peak,
       w.baseline, w.threshold, w.started_at, w.last_at, w.ended_at, w.outcome, w.resolution_note, w.resolved_at,
       CASE WHEN w.resolved_at IS NOT NULL THEN 'resolved'
            WHEN w.acknowledged_at IS NOT NULL THEN 'acknowledged' ELSE 'raised' END AS status
FROM warnings w JOIN detectors d ON d.id = w.detector_id JOIN signals g ON g.id = w.signal_id
WHERE w.site_id = %(site)s
"""


def _seen(r: dict[str, Any]) -> similar.Seen:
    return similar.Seen(
        signal=str(r["signal_id"]),
        detector=str(r["detector_id"]),
        asset=r["asset"],
        side=r["side"],
        peak=r["peak"],
        baseline=r["baseline"],
        threshold=r["threshold"],
        started_at=r["started_at"],
        until=r["ended_at"] or r["last_at"],
    )


@router.get("/sites/{site_id}/warnings/{warning_id}/similar", response_model=Similar)
def similar_warnings(ctx: Ctx, warning_id: uuid.UUID, limit: Annotated[int, Query(ge=1, le=20)] = 5) -> dict[str, Any]:
    """The earlier warnings most like this one (same signal, detector or asset; how far past its
    threshold and how long), with how each was resolved and the first event of its asset in the 24
    hours after it; and the batch tables that name its asset or tag, for the correlation finder."""
    this = ctx.conn.execute(SEEN + " AND w.id = %(id)s", {"site": ctx.site_id, "id": warning_id}).fetchone()
    if this is None:
        raise Problem(status.HTTP_404_NOT_FOUND, "warning.not_found", "No such warning")
    me = _seen(this)
    rows = ctx.conn.execute(
        SEEN
        + """
          AND w.id <> %(id)s AND w.started_at < %(start)s
          AND (w.signal_id = %(signal)s OR w.detector_id = %(detector)s
               OR (%(asset)s::text IS NOT NULL AND d.asset = %(asset)s))
        ORDER BY w.started_at DESC LIMIT %(limit)s
        """,
        {
            "site": ctx.site_id,
            "id": warning_id,
            "start": this["started_at"],
            "signal": this["signal_id"],
            "detector": this["detector_id"],
            "asset": this["asset"],
            "limit": MAX_CANDIDATES,
        },
    ).fetchall()
    scored = []
    for r in rows:
        s, shared = similar.score(me, seen := _seen(r))
        if s >= similar.MIN_SCORE:
            scored.append((s, r, shared, seen))
    scored.sort(key=lambda x: (-x[0], -x[1]["started_at"].timestamp()))
    shown = []
    for s, r, shared, seen in scored[:limit]:
        shown.append(
            {
                **r,
                "score": s,
                "shared": shared,
                "severity": round(seen.severity, 3),
                "hours": round(seen.hours, 3),
                "followed": _followed(ctx, r["asset"], r["started_at"]),
            }
        )
    outcomes = {"true_alarm": 0, "false_alarm": 0, "unknown": 0, "open": 0}
    for w in shown:
        outcomes[w["outcome"] or "open"] += 1
    return {
        "warning_id": warning_id,
        "asset": this["asset"],
        "severity": round(me.severity, 3),
        "hours": round(me.hours, 3),
        "compared": len(rows),
        "similar": shown,
        "outcomes": outcomes,
        "followed": sum(1 for w in shown if w["followed"]),
        "datasets": _datasets(ctx, this["asset"], this["signal_tag"]),
    }


def _followed(ctx: Ctx, asset: str | None, start: datetime) -> dict[str, Any] | None:
    if asset is None:
        return None
    row = ctx.conn.execute(
        """
        SELECT g.event_kind AS kind, c.code, s.at
        FROM site_samples s JOIN signals g ON g.id = s.signal_id,
             LATERAL (SELECT coalesce(s.value_text, s.value::text, s.value_bool::text) AS code) c
        WHERE g.site_id = %(site)s AND g.event_kind IS NOT NULL AND g.asset = %(asset)s
          AND s.at >= %(start)s AND s.at <= %(end)s
          AND coalesce(s.value <> 0, s.value_bool, s.value_text <> '')
          AND NOT (g.event_kind = 'downtime' AND tiles_planned(g.site_id, g.asset, s.at, c.code))
        ORDER BY s.at LIMIT 1
        """,
        {"site": ctx.site_id, "asset": asset, "start": start, "end": start + FOLLOW},
    ).fetchone()
    if row is None:
        return None
    return {**row, "hours_after": round((row["at"] - start).total_seconds() / 3600, 2)}


def _datasets(ctx: Ctx, asset: str | None, tag: str) -> list[dict[str, Any]]:
    """The batch tables that name the asset or tag (name, description), have a column named as the
    tag, or a row with the asset as a value; in that order, then by name."""
    words = [w for w in (asset, tag) if w]
    rows = ctx.conn.execute(
        """
        SELECT d.id, d.name,
               CASE WHEN EXISTS (SELECT 1 FROM unnest(%(words)s::text[]) w
                                 WHERE strpos(lower(d.name || ' ' || d.description), lower(w)) > 0) THEN 'name'
                    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(d.columns) c
                                 WHERE lower(c->>'name') = lower(%(tag)s)) THEN 'column'
                    WHEN %(asset)s::text IS NOT NULL AND EXISTS (
                        SELECT 1 FROM dataset_rows r WHERE r.dataset_id = d.id
                          AND jsonb_path_exists(r.row, '$.* ? (@ == $a)', jsonb_build_object('a', %(asset)s::text)))
                    THEN 'value' END AS why
        FROM datasets d WHERE d.site_id = %(site)s
        """,
        {"site": ctx.site_id, "words": words, "tag": tag, "asset": asset},
    ).fetchall()
    order = {"name": 0, "column": 1, "value": 2}
    found = sorted((r for r in rows if r["why"]), key=lambda r: (order[r["why"]], r["name"].lower()))
    return found[:MAX_DATASETS]
