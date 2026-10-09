"""Saved insights (T3.12). An engineer saves a finding with the query that found it, the evidence it
gave and the actions it proposes; another engineer accepts or rejects it. Each insight has a number
per site, so it can be linked to (the browser's `#/insights/<number>`).

The evidence is computed here from the query, never sent by the browser: a correlation of one of
the site's datasets (api_datasets.run), or signals over a time range (api_series.read_series). It
is kept as it was when saved, so the insight shows what was seen even after the data changes.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from psycopg.types.json import Jsonb
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from tiles_api import api_datasets, api_series
from tiles_api.api_ontology import Ctx, Editor, SiteContext
from tiles_api.store import one

router = APIRouter(tags=["insights"])

MAX_FINDINGS = 60  # of a correlation, kept as evidence (largest effects first)
MAX_SIGNALS = 8
TITLE = r"^\S(.*\S)?$"
Status = Literal["proposed", "accepted", "rejected"]
Action = Annotated[str, Field(min_length=1, max_length=500)]


class CorrelationSource(api_datasets.CorrelateIn):
    """A correlation of one of the site's datasets, as the correlation finder runs it."""

    kind: Literal["correlation"]
    dataset_id: uuid.UUID
    min_effect: Annotated[float, Field(ge=0, le=10)] = 0.8


class SeriesSource(BaseModel):
    """Signals over a time range, as the Data explorer plots them."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["series"]
    signals: Annotated[list[uuid.UUID], Field(min_length=1, max_length=MAX_SIGNALS)]
    start: AwareDatetime
    end: AwareDatetime  # excluded
    points: Annotated[int, Field(ge=10, le=1000)] = 600  # per signal

    @model_validator(mode="after")
    def _distinct(self) -> "SeriesSource":
        if len(set(self.signals)) != len(self.signals):
            raise ValueError("Each signal once")
        if self.end <= self.start:
            raise ValueError("The end must be after the start")
        if self.end - self.start > api_series.MAX_SPAN:
            raise ValueError("The range can be at most five years")
        return self


Source = Annotated[CorrelationSource | SeriesSource, Field(discriminator="kind")]


class InsightIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Annotated[str, Field(min_length=1, max_length=200, pattern=TITLE)]
    summary: Annotated[str, Field(max_length=5000)] = ""
    actions: Annotated[list[Action], Field(max_length=20)] = []
    source: Source


class InsightEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Annotated[str, Field(min_length=1, max_length=200, pattern=TITLE)] | None = None
    summary: Annotated[str, Field(max_length=5000)] | None = None
    actions: Annotated[list[Action], Field(max_length=20)] | None = None


class ReviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["accepted", "rejected"]
    note: Annotated[str, Field(max_length=2000)] = ""


class InsightSummary(BaseModel):
    number: int
    title: str
    summary: str
    actions: list[str]
    kind: Literal["correlation", "series"]
    status: Status
    author: str
    author_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    reviewer: str | None
    reviewed_at: datetime | None
    review_note: str


class Insight(InsightSummary):
    query: dict[str, Any]  # what produced the evidence (the source sent)
    evidence: dict[str, Any]  # what it gave when saved


class InsightList(BaseModel):
    insights: list[InsightSummary]
    total: int


SUMMARY = """
SELECT number, title, summary, actions, kind, status, author_name AS author, author_id, created_at, updated_at,
       reviewer_name AS reviewer, reviewed_at, review_note
FROM insights WHERE site_id = %s AND (%s::text IS NULL OR status = %s)
"""
DETAIL = """
SELECT number, title, summary, actions, kind, status, author_name AS author, author_id, created_at, updated_at,
       reviewer_name AS reviewer, reviewed_at, review_note, query, evidence
FROM insights WHERE site_id = %s AND number = %s
"""


def _find(ctx: SiteContext, number: int, *, lock: bool = False) -> dict[str, Any]:
    row = ctx.conn.execute(DETAIL + (" FOR UPDATE" if lock else ""), [ctx.site_id, number]).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Insight #{number} not found")
    return row


def _own(ctx: SiteContext, insight: dict[str, Any], what: str) -> None:
    if insight["author_id"] != ctx.user.id and ctx.user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"Only its author (or an admin) {what} an insight")


def evidence_for(ctx: SiteContext, source: CorrelationSource | SeriesSource) -> dict[str, Any]:
    """What the query gives now, as kept with the insight."""
    if isinstance(source, CorrelationSource):
        d = api_datasets.find_dataset(ctx, source.dataset_id)
        result = api_datasets.run(ctx, d, source, source.min_effect)
        # The largest effects, and every one the explanations name, in their order.
        explained = {(e["segment"], e["variable"]) for e in result["explanations"]}
        kept = [
            f
            for i, f in enumerate(result["findings"])
            if i < MAX_FINDINGS or (f["segment"], f["variable"]) in explained
        ]
        return {
            "dataset": {"id": str(d["id"]), "name": d["name"], "row_count": d["row_count"]},
            "result": result | {"findings": kept},
            "findings_total": len(result["findings"]),
        }
    series = [api_series.read_series(ctx, s, source.start, source.end, source.points) for s in source.signals]
    return {"series": [s.model_dump(mode="json") for s in series]}


@router.get("/sites/{site_id}/insights", response_model=InsightList)
def list_insights(
    ctx: Ctx,
    state: Annotated[Status | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict[str, Any]:
    """The site's insights, newest first; only those in one status if given."""
    args = [ctx.site_id, state, state]
    rows = ctx.conn.execute(SUMMARY + " ORDER BY number DESC LIMIT %s OFFSET %s", [*args, limit, offset]).fetchall()
    total = one(
        ctx.conn.execute(
            "SELECT count(*) AS n FROM insights WHERE site_id = %s AND (%s::text IS NULL OR status = %s)", args
        ).fetchone()
    )["n"]
    return {"insights": rows, "total": total}


@router.get("/sites/{site_id}/insights/{number}", response_model=Insight)
def get_insight(ctx: Ctx, number: int) -> dict[str, Any]:
    """A saved insight by its number: the finding, its query, the evidence kept with it, the proposed
    actions and its review."""
    return _find(ctx, number)


@router.post("/sites/{site_id}/insights", response_model=Insight, status_code=status.HTTP_201_CREATED)
def create_insight(ctx: Editor, body: InsightIn) -> dict[str, Any]:
    """Save a finding: its evidence is computed from `source` now and kept as it is. It waits for
    another engineer to accept or reject it."""
    evidence = evidence_for(ctx, body.source)
    # The site's next number (two saving at once wait for each other); never one given before.
    number = one(
        ctx.conn.execute(
            """
            INSERT INTO insight_numbers (site_id, last) VALUES (%s, 1)
            ON CONFLICT (site_id) DO UPDATE SET last = insight_numbers.last + 1 RETURNING last
            """,
            [ctx.site_id],
        ).fetchone()
    )["last"]
    ctx.conn.execute(
        """
        INSERT INTO insights (site_id, number, title, summary, actions, kind, query, evidence, author_id,
                              author_name)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        [
            ctx.site_id,
            number,
            body.title,
            body.summary,
            Jsonb(body.actions),
            body.source.kind,
            Jsonb(body.source.model_dump(mode="json")),
            Jsonb(evidence),
            ctx.user.id,
            ctx.user.name,
        ],
    )
    ctx.audit("insight.create", "insight", str(number), after={"title": body.title, "kind": body.source.kind})
    return _find(ctx, number)


@router.patch("/sites/{site_id}/insights/{number}", response_model=Insight)
def edit_insight(ctx: Editor, number: int, body: InsightEdit) -> dict[str, Any]:
    """Change the title, summary or actions while it waits for review (its author, or an admin).
    The query and evidence stay: a different finding is a new insight."""
    insight = _find(ctx, number, lock=True)
    _own(ctx, insight, "edits")
    if insight["status"] != "proposed":
        raise HTTPException(status.HTTP_409_CONFLICT, f"Insight #{number} is {insight['status']}: reopen it first")
    changes = body.model_dump(exclude_none=True)
    if not changes:
        return insight
    ctx.conn.execute(
        """
        UPDATE insights SET title = coalesce(%s, title), summary = coalesce(%s, summary),
                            actions = coalesce(%s, actions), updated_at = now()
        WHERE site_id = %s AND number = %s
        """,
        [
            body.title,
            body.summary,
            Jsonb(body.actions) if body.actions is not None else None,
            ctx.site_id,
            number,
        ],
    )
    ctx.audit(
        "insight.update",
        "insight",
        str(number),
        before={k: insight[k] for k in changes},
        after=changes,
    )
    return _find(ctx, number)


@router.post("/sites/{site_id}/insights/{number}/review", response_model=Insight)
def review_insight(ctx: Editor, number: int, body: ReviewIn) -> dict[str, Any]:
    """Accept or reject it: another engineer than its author; rejecting says why."""
    insight = _find(ctx, number, lock=True)
    if insight["author_id"] == ctx.user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Another engineer reviews your insight")
    if insight["status"] != "proposed":
        raise HTTPException(status.HTTP_409_CONFLICT, f"Insight #{number} is already {insight['status']}")
    note = body.note.strip()
    if body.decision == "rejected" and not note:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Say why the insight is rejected")
    ctx.conn.execute(
        """
        UPDATE insights SET status = %s, reviewer_id = %s, reviewer_name = %s, reviewed_at = now(),
                            review_note = %s, updated_at = now()
        WHERE site_id = %s AND number = %s
        """,
        [body.decision, ctx.user.id, ctx.user.name, note, ctx.site_id, number],
    )
    ctx.audit("insight.review", "insight", str(number), after={"decision": body.decision, "note": note})
    return _find(ctx, number)


@router.post("/sites/{site_id}/insights/{number}/reopen", response_model=Insight)
def reopen_insight(ctx: Editor, number: int) -> dict[str, Any]:
    """Back to waiting for review (its author, or an admin), e.g. to revise a rejected one."""
    insight = _find(ctx, number, lock=True)
    _own(ctx, insight, "reopens")
    if insight["status"] == "proposed":
        raise HTTPException(status.HTTP_409_CONFLICT, f"Insight #{number} already waits for review")
    ctx.conn.execute(
        """
        UPDATE insights SET status = 'proposed', reviewer_id = NULL, reviewer_name = NULL, reviewed_at = NULL,
                            review_note = '', updated_at = now()
        WHERE site_id = %s AND number = %s
        """,
        [ctx.site_id, number],
    )
    ctx.audit("insight.reopen", "insight", str(number), before={"status": insight["status"]})
    return _find(ctx, number)


@router.delete("/sites/{site_id}/insights/{number}", status_code=status.HTTP_204_NO_CONTENT)
def delete_insight(ctx: Editor, number: int) -> None:
    """Delete an insight (its author, or an admin)."""
    insight = _find(ctx, number, lock=True)
    _own(ctx, insight, "deletes")
    ctx.conn.execute("DELETE FROM insights WHERE site_id = %s AND number = %s", [ctx.site_id, number])
    ctx.audit("insight.delete", "insight", str(number), before={"title": insight["title"], "status": insight["status"]})
