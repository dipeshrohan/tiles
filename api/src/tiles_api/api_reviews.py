"""Change approval (T2.12): ontology changes reviewed by a second engineer before they are committed.

An engineer turns their staged changes (or the revert of a commit) into a change
request, optionally naming the engineer who should review it. Another engineer
reads the diff, comments, and approves it, which commits the ops with the
requester as author and the approver recorded as reviewer, or rejects it with a
reason. The author can take an open or rejected request back into their staged
changes to rework it.

A site admin can require a review for every change (`review-policy`); direct
commits and reverts are then refused. Every step is audited.

The copilot proposes changes the same way (T4.09, `copilot_tools.propose_ontology_change`): a
request authored by the person who asked, with `source` "copilot", which that person can't
approve; it never commits anything itself, whatever the review policy.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from tiles_api import ontology as o
from tiles_api import ontology_store as store
from tiles_api.api_ontology import Admin, Ctx, DiffStats, Editor, SiteContext, can_edit
from tiles_api.store import one

router = APIRouter(tags=["reviews"])

NO_NUL = r"^[^\x00]*$"  # PostgreSQL text can't hold NUL
Status = Literal["open", "approved", "rejected", "withdrawn"]


class Policy(BaseModel):
    required: bool


class PolicyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    required: StrictBool


class ReviewComment(BaseModel):
    id: int
    author: str
    body: str
    verdict: Literal["approved", "rejected", "withdrawn"] | None  # the decision this entry records
    created_at: datetime


class ReviewSummary(BaseModel):
    number: int
    message: str
    author: str
    author_id: uuid.UUID | None
    reviewer: str | None  # the engineer asked to review it; None: anyone
    reviewer_id: uuid.UUID | None
    status: Status
    stats: DiffStats
    reverts: str | None  # the commit it reverts
    source: Literal["person", "copilot"]  # who wrote the ops: its author, or the copilot for them (T4.09)
    created_at: datetime
    decided_by: str | None
    decided_at: datetime | None
    commit_id: str | None  # the commit an approval made
    comments: int


class Review(ReviewSummary):
    ops: list[dict[str, Any]]
    thread: list[ReviewComment]
    # Why the ops no longer apply to the committed ontology (open requests only); None when they do.
    conflict: str | None


class ReviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: Annotated[str, Field(max_length=2000, pattern=NO_NUL)] = ""
    reviewer_id: uuid.UUID | None = None
    # Request the revert of this commit instead of your staged changes.
    reverts: Annotated[str, Field(min_length=1, max_length=200, pattern=NO_NUL)] | None = None


class CommentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    body: Annotated[str, Field(max_length=4000, pattern=NO_NUL)]


class DecisionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    comment: Annotated[str, Field(max_length=4000, pattern=NO_NUL)] = ""


SUMMARY = """
SELECT r.number, r.message, r.author_name AS author, r.author_id, ru.name AS reviewer, r.reviewer_id, r.status,
       r.stats, r.reverts, r.source, r.created_at, r.decided_by_name AS decided_by, r.decided_at, r.commit_id,
       (SELECT count(*) FROM change_request_comments c
        WHERE c.site_id = r.site_id AND c.number = r.number AND c.body <> '') AS comments
FROM change_requests r LEFT JOIN users ru ON ru.id = r.reviewer_id
WHERE r.site_id = %s
"""


def _find(ctx: SiteContext, number: int, *, lock: bool = False) -> dict[str, Any]:
    """A change request with its ops (the list leaves them out: they can be thousands)."""
    row = ctx.conn.execute(
        SUMMARY + " AND r.number = %s" + (" FOR UPDATE OF r" if lock else ""), [ctx.site_id, number]
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Change request #{number} not found")
    ops = one(
        ctx.conn.execute(
            "SELECT ops FROM change_requests WHERE site_id = %s AND number = %s", [ctx.site_id, number]
        ).fetchone()
    )
    return {**row, "ops": ops["ops"]}


def _review(ctx: SiteContext, number: int, *, fits: bool = False) -> dict[str, Any]:
    """The request as the API shows it; `fits`: its ops were just checked against the head."""
    row = _find(ctx, number)
    thread = ctx.conn.execute(
        """
        SELECT id, author_name AS author, body, verdict, created_at FROM change_request_comments
        WHERE site_id = %s AND number = %s ORDER BY id
        """,
        [ctx.site_id, number],
    ).fetchall()
    conflict = None
    if row["status"] == "open" and not fits:
        try:
            o.apply_ops(store.load_head(ctx.conn, ctx.site_id), row["ops"])
        except o.OntologyError as e:
            conflict = str(e)
    return {**row, "thread": thread, "conflict": conflict}


def _note(ctx: SiteContext, number: int, body: str, verdict: str | None = None) -> None:
    ctx.conn.execute(
        """
        INSERT INTO change_request_comments (site_id, number, author_id, author_name, body, verdict)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        [ctx.site_id, number, ctx.user.id, ctx.user.name, body, verdict],
    )


def _close(ctx: SiteContext, number: int, new_status: Status, commit_id: str | None = None) -> None:
    ctx.conn.execute(
        """
        UPDATE change_requests SET status = %s, decided_by_id = %s, decided_by_name = %s,
               decided_at = clock_timestamp(), commit_id = %s
        WHERE site_id = %s AND number = %s
        """,
        [new_status, ctx.user.id, ctx.user.name, commit_id, ctx.site_id, number],
    )


def _may_decide(ctx: SiteContext, req: dict[str, Any]) -> None:
    if req["status"] != "open":
        raise HTTPException(status.HTTP_409_CONFLICT, f"Change request #{req['number']} is already {req['status']}")
    if req["author_id"] == ctx.user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can't review your own change: ask another engineer")
    if req["reviewer_id"] not in (None, ctx.user.id) and ctx.user.role != "admin":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, f"Change request #{req['number']} waits for {req['reviewer']} (or an admin)"
        )


@router.get("/sites/{site_id}/ontology/review-policy", response_model=Policy)
def get_policy(ctx: Ctx) -> dict[str, bool]:
    """Whether every ontology change on this site needs a review."""
    row = one(ctx.conn.execute("SELECT review_required FROM sites WHERE id = %s", [ctx.site_id]).fetchone())
    return {"required": row["review_required"]}


@router.put("/sites/{site_id}/ontology/review-policy", response_model=Policy)
def set_policy(ctx: Admin, body: PolicyIn) -> dict[str, bool]:
    """Require (or stop requiring) a review for every ontology change on this site (admins)."""
    before = store.lock_site(ctx.conn, ctx.site_id)
    if before != body.required:
        ctx.conn.execute("UPDATE sites SET review_required = %s WHERE id = %s", [body.required, ctx.site_id])
        ctx.audit("ontology.review_policy", "site", str(ctx.site_id), {"required": before}, {"required": body.required})
    return {"required": body.required}


@router.get("/sites/{site_id}/ontology/reviews", response_model=list[ReviewSummary])
def list_reviews(
    ctx: Ctx,
    state: Literal["open", "closed", "all"] = "open",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[dict[str, Any]]:
    """Change requests, newest first: open ones (default), closed ones (approved, rejected, withdrawn) or all."""
    where = {"open": " AND r.status = 'open'", "closed": " AND r.status <> 'open'", "all": ""}[state]
    return ctx.conn.execute(
        SUMMARY + where + " ORDER BY r.number DESC LIMIT %s OFFSET %s", [ctx.site_id, limit, offset]
    ).fetchall()


@router.get("/sites/{site_id}/ontology/reviews/{number}", response_model=Review)
def get_review(ctx: Ctx, number: int) -> dict[str, Any]:
    """A change request with its ops, its comments and, while open, whether it still applies."""
    return _review(ctx, number)


@router.post("/sites/{site_id}/ontology/reviews", response_model=Review, status_code=status.HTTP_201_CREATED)
def request_review(ctx: Editor, body: ReviewIn) -> dict[str, Any]:
    """Send your staged changes (or the revert of a commit) for review. Your staged changes move into the request."""
    store.lock_site(ctx.conn, ctx.site_id)
    staged = store.load_staged(ctx.conn, ctx.site_id, ctx.user)
    message = body.message.strip()
    if body.reverts is not None:
        if staged:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Request a review of your staged changes or discard them first"
            )
        try:
            target = store.find_commit(ctx.conn, ctx.site_id, body.reverts)
        except store.NotFound as e:
            raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
        ops = target["inverses"]
        message = message or o.revert_info(target, ctx.user.name)["message"]
    else:
        ops = staged
        if not ops:
            raise HTTPException(status.HTTP_409_CONFLICT, "Nothing to review: stage some changes first")
        if not message:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "A change request needs a message")
    number = open_request(ctx, ops, message, body.reviewer_id, body.reverts)
    if body.reverts is None:
        ctx.conn.execute("DELETE FROM staged_ops WHERE site_id = %s AND user_id = %s", [ctx.site_id, ctx.user.id])
    audit_request(ctx, number, message, ops, body.reviewer_id, body.reverts)
    return _review(ctx, number, fits=True)


def open_request(
    ctx: SiteContext,
    ops: list[o.Op],
    message: str,
    reviewer_id: uuid.UUID | None = None,
    reverts: str | None = None,
    source: Literal["person", "copilot"] = "person",
    conversation_id: uuid.UUID | None = None,
) -> int:
    """Opens a change request of `ops` by the user, after checking they fit the committed ontology
    and the reviewer may review; its number. The caller holds the site's lock and audits it."""
    try:
        o.apply_ops(store.load_head(ctx.conn, ctx.site_id), ops)
    except o.OntologyError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    if reviewer_id is not None:
        if reviewer_id == ctx.user.id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Ask someone else to review your change")
        if not can_edit(ctx.conn, ctx.site_id, ctx.org_id, reviewer_id):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "The reviewer must be an engineer or admin of this site"
            )
    number: int = one(
        ctx.conn.execute(
            """
            INSERT INTO change_requests (site_id, number, message, author_id, author_name, reviewer_id, ops, stats,
                                         reverts, source, conversation_id)
            VALUES (%s, (SELECT coalesce(max(number), 0) + 1 FROM change_requests WHERE site_id = %s),
                    %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING number
            """,
            [
                ctx.site_id,
                ctx.site_id,
                message,
                ctx.user.id,
                ctx.user.name,
                reviewer_id,
                Jsonb(ops),
                Jsonb(o.diff_stats(ops)),
                reverts,
                source,
                conversation_id,
            ],
        ).fetchone()
    )["number"]
    return number


def audit_request(
    ctx: SiteContext,
    number: int,
    message: str,
    ops: list[o.Op],
    reviewer_id: uuid.UUID | None = None,
    reverts: str | None = None,
    source: Literal["person", "copilot"] = "person",
    conversation_id: uuid.UUID | None = None,
) -> None:
    """The audit entry of an opened change request, the same whoever opened it."""
    after = {
        "message": message,
        "ops": ops,
        "reviewer_id": reviewer_id and str(reviewer_id),
        "reverts": reverts,
        "source": source,
        "conversation_id": conversation_id and str(conversation_id),
    }
    ctx.audit("ontology.review.request", "change_request", str(number), after=after)


@router.post("/sites/{site_id}/ontology/reviews/{number}/comments", response_model=Review)
def comment(ctx: Editor, number: int, body: CommentIn) -> dict[str, Any]:
    """Comment on a change request."""
    text = body.body.strip()
    if not text:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Write a comment first")
    _find(ctx, number, lock=True)
    _note(ctx, number, text)
    ctx.audit("ontology.review.comment", "change_request", str(number), after={"body": text})
    return _review(ctx, number)


@router.post("/sites/{site_id}/ontology/reviews/{number}/approve", response_model=Review)
def approve(ctx: Editor, number: int, body: DecisionIn) -> dict[str, Any]:
    """Approve a change request: its ops are committed, with its author as author and you as reviewer."""
    store.lock_site(ctx.conn, ctx.site_id)
    req = _find(ctx, number, lock=True)
    _may_decide(ctx, req)
    try:
        entry = store.record(
            ctx.conn,
            ctx.site_id,
            (req["author_id"], req["author"]),
            req["ops"],
            req["message"],
            req["reverts"],
            reviewer=ctx.user.name,
        )
    except o.OntologyError as e:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"This change no longer fits the ontology ({e}). Its author can rework it."
        ) from e
    _close(ctx, number, "approved", entry["id"])
    _note(ctx, number, body.comment.strip(), "approved")
    ctx.audit("ontology.review.approve", "change_request", str(number), after={"commit": entry})
    return _review(ctx, number)


@router.post("/sites/{site_id}/ontology/reviews/{number}/reject", response_model=Review)
def reject(ctx: Editor, number: int, body: DecisionIn) -> dict[str, Any]:
    """Reject a change request, saying why. Nothing is committed; its author can rework it."""
    reason = body.comment.strip()
    if not reason:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Say why the change is rejected")
    req = _find(ctx, number, lock=True)
    _may_decide(ctx, req)
    _close(ctx, number, "rejected")
    _note(ctx, number, reason, "rejected")
    ctx.audit("ontology.review.reject", "change_request", str(number), after={"comment": reason})
    return _review(ctx, number)


@router.post("/sites/{site_id}/ontology/reviews/{number}/rework", response_model=Review)
def rework(ctx: Editor, number: int) -> dict[str, Any]:
    """Take your change request back into your staged changes, to change and send again.

    An open request is withdrawn; a rejected or withdrawn one stays as it is. A revert
    is not staged (sent again it would no longer be a revert): an open one is only
    withdrawn, and a closed one is requested again from the history.
    """
    store.lock_site(ctx.conn, ctx.site_id)
    req = _find(ctx, number, lock=True)
    if req["author_id"] != ctx.user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the author of a change request can rework it")
    if req["status"] == "approved":
        raise HTTPException(status.HTTP_409_CONFLICT, f"Change request #{number} is already committed")
    if req["reverts"] is not None:
        if req["status"] != "open":
            raise HTTPException(status.HTTP_409_CONFLICT, "Request the revert again from the history")
        _close(ctx, number, "withdrawn")
        _note(ctx, number, "", "withdrawn")
        ctx.audit("ontology.review.rework", "change_request", str(number), after={"ops": []})
        return _review(ctx, number)
    if store.load_staged(ctx.conn, ctx.site_id, ctx.user):
        raise HTTPException(status.HTTP_409_CONFLICT, "Commit, send or discard your staged changes first")
    try:
        store.stage(ctx.conn, ctx.site_id, ctx.user, *req["ops"])
    except o.OntologyError as e:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"This change no longer fits the ontology ({e}). Make it again instead."
        ) from e
    if req["status"] == "open":
        _close(ctx, number, "withdrawn")
        _note(ctx, number, "", "withdrawn")
    ctx.audit("ontology.review.rework", "change_request", str(number), after={"ops": req["ops"]})
    return _review(ctx, number)
