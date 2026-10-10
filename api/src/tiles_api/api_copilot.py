"""The copilot over HTTP (T4.01): each user's conversations on a site, and questions answered by
Claude with tool use, streamed as server-sent events.

`POST …/conversations/{id}/messages` stores the question, then streams the answer:
`text` (a piece of the answer as it is written), `tool_use` and `tool_result` (a tool the model
called, and whether it answered), then `done` (with the tokens used) or `error`. Every message of
the exchange is stored as it completes, so the next question carries the whole conversation.

Conversations are private to their user. Anyone on the site may use the copilot: its tools only
read, as the user who asked. It is off until TILES_ANTHROPIC_API_KEY and TILES_COPILOT_MODEL are
set, and on each site until its admins turn it on (threat model G-A4: the questions and the tool
results the copilot reads go to the AI provider; `PUT …/copilot/policy`). Rate limits and token
budgets (copilot_usage.py, T4.07) refuse a question with 429; admins read the usage at
`GET …/copilot/usage`.
"""

import json
import logging
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from tiles_api import assistant, copilot_usage, grounding
from tiles_api.api_ontology import Admin, Ctx, SiteContext
from tiles_api.copilot_tools import tools_for
from tiles_api.store import Conn, one, scope_to_site, side_pool

router = APIRouter(tags=["copilot"])
log = logging.getLogger("tiles_api.copilot")

MAX_MESSAGES = 200  # stored per conversation (each tool round adds two)
MAX_HISTORY_CHARS = 400_000  # about 100,000 tokens of conversation sent with each question
BUSY_MINUTES = 10  # an answer that has stored nothing for this long is taken as lost
SITE_OFF = "The copilot is off on this site: an admin turns it on in Settings"
NO_NUL = r"^[^\x00]*$"  # PostgreSQL text can't hold NUL


class Status(BaseModel):
    configured: bool
    enabled: bool


class PolicyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool


class ConversationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Annotated[str, Field(max_length=200, pattern=NO_NUL)] = ""


class Conversation(BaseModel):
    id: uuid.UUID
    title: str
    created_at: datetime
    updated_at: datetime
    messages: int
    input_tokens: int
    output_tokens: int


class Feedback(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rating: Literal["up", "down"]
    comment: Annotated[str, Field(max_length=2000, pattern=NO_NUL)] = ""


class Message(BaseModel):
    seq: int
    role: str
    content: list[dict[str, Any]]  # Messages API content blocks: text, tool_use, tool_result
    meta: dict[str, Any]  # an answer's grounding report (T4.03)
    created_at: datetime
    feedback: Feedback | None = None  # yours, on an answer (T4.04)


class FeedbackRow(Feedback):
    conversation_id: uuid.UUID
    seq: int
    user: str
    question: str  # the question the answer was to
    answer: str
    grounded: bool | None
    updated_at: datetime


class ConversationDetail(Conversation):
    history: list[Message]


class UsageDay(BaseModel):
    day: date
    questions: int
    answered: int
    failed: int
    over_budget: int
    ungrounded: int  # answered, but the grounding check found what no result supports
    model_calls: int
    input_tokens: int
    output_tokens: int
    cache_write_tokens: int
    cache_read_tokens: int
    billed_tokens: int
    first_text_p50_ms: float | None
    first_text_p95_ms: float | None
    total_p50_ms: float | None
    total_p95_ms: float | None


class UsageUser(BaseModel):
    user: str
    email: str
    questions: int
    billed_tokens: int


class UsageToday(BaseModel):
    org_billed_tokens: int
    site_billed_tokens: int


class UsageLimits(BaseModel):
    question_tokens: int
    org_daily_tokens: int
    org_questions_per_minute: int
    user_questions_per_minute: int
    max_tokens_per_call: int
    max_rounds: int


class Usage(BaseModel):
    days: list[UsageDay]
    users: list[UsageUser]
    today: UsageToday
    limits: UsageLimits


class AskIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: Annotated[str, Field(min_length=1, max_length=8000, pattern=NO_NUL)]


def model_for(request: Request) -> assistant.Model | None:
    """The model to answer with: the one tests set, or Claude when the settings name a key and a
    model; None while the copilot is off."""
    state = request.app.state
    if state.copilot_model is not None:
        model: assistant.Model = state.copilot_model
        return model
    settings = state.settings
    key = settings.anthropic_api_key.get_secret_value() if settings.anthropic_api_key else ""
    if not key or not settings.copilot_model:  # unset, or set empty (as Compose passes an unset one)
        return None
    if state.copilot_client is None:
        import anthropic

        state.copilot_client = anthropic.Anthropic(api_key=key, max_retries=2, timeout=120)
    return assistant.AnthropicModel(state.copilot_client, settings.copilot_model, settings.copilot_max_tokens)


CONVERSATIONS = """
SELECT c.id, c.title, c.created_at, c.updated_at, c.input_tokens, c.output_tokens,
       (SELECT count(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS messages
FROM conversations c WHERE c.site_id = %s AND c.user_id = %s
"""


def _own(ctx: SiteContext, conversation_id: uuid.UUID, *, lock: bool = False) -> dict[str, Any]:
    """The user's own conversation (another user's is not found)."""
    if lock:
        ctx.conn.execute(
            "SELECT 1 FROM conversations WHERE id = %s AND site_id = %s AND user_id = %s FOR UPDATE",
            [conversation_id, ctx.site_id, ctx.user.id],
        )
    row = ctx.conn.execute(CONVERSATIONS + " AND c.id = %s", [ctx.site_id, ctx.user.id, conversation_id]).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such conversation")
    return row


def _history(conn: Conn, conversation_id: uuid.UUID) -> list[dict[str, Any]]:
    return conn.execute(
        "SELECT seq, role, content, meta, created_at FROM conversation_messages"
        " WHERE conversation_id = %s ORDER BY seq",
        [conversation_id],
    ).fetchall()


def _shown_history(conn: Conn, conversation_id: uuid.UUID) -> list[dict[str, Any]]:
    """The stored messages with your rating of each answer, as the page shows them."""
    return conn.execute(
        """
        SELECT m.seq, m.role, m.content, m.meta, m.created_at,
               CASE WHEN f.rating IS NULL THEN NULL
                    ELSE jsonb_build_object('rating', f.rating, 'comment', f.comment) END AS feedback
        FROM conversation_messages m LEFT JOIN copilot_feedback f USING (conversation_id, seq)
        WHERE m.conversation_id = %s ORDER BY m.seq
        """,
        [conversation_id],
    ).fetchall()


@router.get("/sites/{site_id}/copilot", response_model=Status)
def copilot_status(ctx: Ctx, request: Request) -> dict[str, Any]:
    """Whether the copilot is set up on this API (an Anthropic API key and a model are configured),
    and whether this site's admins have turned it on."""
    return _status(request, _enabled(ctx.conn, ctx.site_id))


@router.put("/sites/{site_id}/copilot/policy", response_model=Status)
def set_copilot_policy(ctx: Admin, request: Request, body: PolicyIn) -> dict[str, Any]:
    """Turn the copilot on or off for this site (admins). On, each question and the tool results the
    copilot reads to answer it (the site's data, as the user who asked may see it) go to the AI
    provider."""
    before = _enabled(ctx.conn, ctx.site_id, lock=True)
    if before != body.enabled:
        ctx.conn.execute("UPDATE sites SET copilot_enabled = %s WHERE id = %s", [body.enabled, ctx.site_id])
        ctx.audit("copilot.policy", "site", str(ctx.site_id), {"enabled": before}, {"enabled": body.enabled})
    return _status(request, body.enabled)


def _status(request: Request, enabled: bool) -> dict[str, bool]:
    return {"configured": model_for(request) is not None, "enabled": enabled}


def _enabled(conn: Conn, site_id: uuid.UUID, *, lock: bool = False) -> bool:
    query = ENABLED_FOR_UPDATE if lock else ENABLED
    return bool(one(conn.execute(query, [site_id]).fetchone())["copilot_enabled"])


ENABLED = "SELECT copilot_enabled FROM sites WHERE id = %s"
ENABLED_FOR_UPDATE = ENABLED + " FOR UPDATE"


@router.get("/sites/{site_id}/copilot/conversations", response_model=list[Conversation])
def list_conversations(ctx: Ctx) -> list[dict[str, Any]]:
    """Your conversations on this site, the latest first."""
    return ctx.conn.execute(
        CONVERSATIONS + " ORDER BY c.updated_at DESC LIMIT 100", [ctx.site_id, ctx.user.id]
    ).fetchall()


@router.post("/sites/{site_id}/copilot/conversations", response_model=Conversation, status_code=status.HTTP_201_CREATED)
def create_conversation(ctx: Ctx, body: ConversationIn) -> dict[str, Any]:
    """Start a conversation with the copilot on this site; it is yours alone."""
    row = one(
        ctx.conn.execute(
            "INSERT INTO conversations (site_id, user_id, title) VALUES (%s, %s, %s) RETURNING id",
            [ctx.site_id, ctx.user.id, body.title.strip()],
        ).fetchone()
    )
    ctx.audit("copilot.conversation.create", "conversation", str(row["id"]))
    return _own(ctx, row["id"])


@router.get("/sites/{site_id}/copilot/conversations/{conversation_id}", response_model=ConversationDetail)
def get_conversation(ctx: Ctx, conversation_id: uuid.UUID) -> dict[str, Any]:
    """One of your conversations, with its messages and the tools the copilot used."""
    return _own(ctx, conversation_id) | {"history": _shown_history(ctx.conn, conversation_id)}


@router.delete("/sites/{site_id}/copilot/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(ctx: Ctx, conversation_id: uuid.UUID) -> None:
    """Delete one of your conversations, unless the copilot is still answering in it (409)."""
    _own(ctx, conversation_id, lock=True)
    if _busy(ctx.conn, conversation_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "The copilot is still answering in this conversation")
    ctx.conn.execute("DELETE FROM conversations WHERE id = %s", [conversation_id])
    ctx.audit("copilot.conversation.delete", "conversation", str(conversation_id))


def _busy(conn: Conn, conversation_id: uuid.UUID) -> bool:
    return bool(
        one(
            conn.execute(
                "SELECT coalesce(busy_since > now() - %s * interval '1 minute', false) AS busy"
                " FROM conversations WHERE id = %s",
                [BUSY_MINUTES, conversation_id],
            ).fetchone()
        )["busy"]
    )


# The next message of a conversation, numbered after the last one stored.
STORE = """
INSERT INTO conversation_messages (conversation_id, seq, role, content, meta)
SELECT %(c)s, coalesce(max(seq), -1) + 1, %(role)s, %(content)s, %(meta)s
FROM conversation_messages WHERE conversation_id = %(c)s
"""


def _event(kind: str, data: dict[str, Any]) -> str:
    return f"event: {kind}\ndata: {json.dumps(data, default=str, ensure_ascii=False)}\n\n"


@router.post("/sites/{site_id}/copilot/conversations/{conversation_id}/messages")
def ask(ctx: Ctx, request: Request, conversation_id: uuid.UUID, body: AskIn) -> StreamingResponse:
    """Ask a question in the conversation; the answer streams back as server-sent events."""
    model = model_for(request)
    if model is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "The copilot is off: set TILES_ANTHROPIC_API_KEY and TILES_COPILOT_MODEL on the API",
        )
    if not _enabled(ctx.conn, ctx.site_id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "The copilot is off on this site: an admin turns it on in Settings"
        )
    conversation = _own(ctx, conversation_id, lock=True)
    settings = request.app.state.settings
    if _busy(ctx.conn, conversation_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "The copilot is still answering in this conversation")
    text = body.text.strip()
    if not text:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Ask a question")
    stored = _history(ctx.conn, conversation_id)
    # Room for the question and every round of its answer, and a conversation the model can still read.
    if conversation["messages"] + 1 + 2 * settings.copilot_max_rounds > MAX_MESSAGES:
        raise HTTPException(status.HTTP_409_CONFLICT, "This conversation is full: start a new one")
    if sum(len(json.dumps(m["content"])) for m in stored) > MAX_HISTORY_CHARS:
        raise HTTPException(status.HTTP_409_CONFLICT, "This conversation is too long to carry on: start a new one")
    usage_id = copilot_usage.admit(ctx.conn, settings, ctx.org_id, ctx.site_id, ctx.user.id, conversation_id)
    started = time.monotonic()
    question = {"role": "user", "content": [{"type": "text", "text": text}]}
    history = assistant.repaired([*stored, question])
    ctx.conn.execute(
        STORE, {"c": conversation_id, "role": "user", "content": Jsonb(question["content"]), "meta": Jsonb({})}
    )
    ctx.conn.execute(
        """
        UPDATE conversations SET busy_since = now(), updated_at = now(),
                                 title = CASE WHEN title = '' THEN left(%s, 80) ELSE title END
        WHERE id = %s
        """,
        [text, conversation_id],
    )
    ctx.audit("copilot.ask", "conversation", str(conversation_id), after={"chars": len(text)})
    names = one(
        ctx.conn.execute(
            "SELECT s.name AS site, o.name AS org FROM sites s JOIN orgs o ON o.id = s.org_id WHERE s.id = %s",
            [ctx.site_id],
        ).fetchone()
    )
    pool = side_pool(request.app.state)  # the answer streams after the request's connection is back
    site_id, org_id, user = ctx.site_id, ctx.org_id, ctx.user

    @contextmanager
    def open_ctx() -> Iterator[SiteContext]:
        with pool.connection() as conn:
            yield SiteContext(conn, site_id, org_id, user)

    @contextmanager
    def site_conn() -> Iterator[Conn]:
        """A pooled connection scoped to this site (row security, T5.04)."""
        with pool.connection() as conn:
            scope_to_site(conn, site_id)
            yield conn

    def ms() -> int:
        return round((time.monotonic() - started) * 1000)

    def stream() -> Iterator[str]:
        # Every call's tokens, so a broken-off answer is counted too; saved with each stored message.
        tally = copilot_usage.Tally(usage_id, org_id)
        over_daily: list[str] = []  # why the organisation may not go on today, found after a message

        def stop() -> str | None:  # asked before each model call after the first
            if over_daily:
                return over_daily[0]
            with site_conn() as conn:  # turned off meanwhile: nothing more goes to the provider
                return None if _enabled(conn, site_id) else SITE_OFF

        try:
            events = assistant.respond(
                model,
                assistant.SYSTEM.format(site=names["site"], org=names["org"], decline=grounding.DECLINE),
                history,
                assistant_tools,
                settings.copilot_max_rounds,
                settings.copilot_question_tokens,
                stop=stop,
            )
            for event in events:
                if event.kind == "usage":
                    tally.add_call(event.data, assistant.billed(event.data))
                    continue
                if event.kind == "text" and tally.first_text_ms is None:
                    tally.first_text_ms = ms()  # the user sees text (a draft withdrawn later, too)
                elif event.kind == "done":
                    tally.outcome, tally.grounded = "answered", bool(event.data.get("grounded"))
                elif event.kind == "error" and event.data.get("over_budget") and event.data["detail"] != SITE_OFF:
                    tally.outcome = "over_budget"
                if event.kind == "message":
                    with site_conn() as conn:  # stored, the answer's lease renewed, its usage so far
                        conn.execute(
                            STORE,
                            {
                                "c": conversation_id,
                                "role": event.data["role"],
                                "content": Jsonb(event.data["content"]),
                                "meta": Jsonb(event.data.get("meta", {})),
                            },
                        )
                        conn.execute("UPDATE conversations SET busy_since = now() WHERE id = %s", [conversation_id])
                        copilot_usage.save(conn, tally)
                        if reason := copilot_usage.over_daily(conn, settings, org_id):
                            over_daily[:] = [reason]
                    continue
                yield _event(event.kind, event.data)
        except Exception:
            log.exception("copilot answer failed", extra={"conversation": str(conversation_id)})
            yield _event("error", {"detail": "The copilot could not answer: try again in a moment"})
        finally:
            if tally.outcome == "running":  # it ended without an answer
                tally.outcome = "failed"
            t = tally.tokens
            with site_conn() as conn:
                conn.execute(
                    """
                    UPDATE conversations SET busy_since = NULL, updated_at = now(),
                           input_tokens = input_tokens + %s, output_tokens = output_tokens + %s
                    WHERE id = %s
                    """,
                    [
                        # The whole prompt: cached or not, the model read it.
                        t.get("input_tokens", 0)
                        + t.get("cache_creation_input_tokens", 0)
                        + t.get("cache_read_input_tokens", 0),
                        t.get("output_tokens", 0),
                        conversation_id,
                    ],
                )
                copilot_usage.save(conn, tally, ms())

    # Engineers and admins may have the copilot propose ontology changes, for another engineer to review.
    can_propose = ctx.user.role in ("engineer", "admin")
    assistant_tools = tools_for(open_ctx, can_propose=can_propose, conversation_id=conversation_id)
    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


def _answer(ctx: SiteContext, conversation_id: uuid.UUID, seq: int) -> None:
    """Your own conversation's answer (an assistant message with text) at `seq`, or 404."""
    _own(ctx, conversation_id)
    row = ctx.conn.execute(
        "SELECT role, content FROM conversation_messages WHERE conversation_id = %s AND seq = %s",
        [conversation_id, seq],
    ).fetchone()
    final = row is not None and not any(b.get("type") == "tool_use" for b in row["content"])
    if row is None or row["role"] != "assistant" or not final or not grounding.text_of(row).strip():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such answer in this conversation")


@router.put("/sites/{site_id}/copilot/conversations/{conversation_id}/messages/{seq}/feedback", response_model=Feedback)
def rate_answer(ctx: Ctx, conversation_id: uuid.UUID, seq: int, body: Feedback) -> dict[str, Any]:
    """Rate one of your answers up or down, with a comment; your site's admins read it, with the
    question and the answer, to improve the copilot."""
    _answer(ctx, conversation_id, seq)
    comment = body.comment.strip()
    ctx.conn.execute(
        """
        INSERT INTO copilot_feedback (conversation_id, seq, site_id, user_id, rating, comment)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (conversation_id, seq) DO UPDATE
        SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()
        """,
        [conversation_id, seq, ctx.site_id, ctx.user.id, body.rating, comment],
    )
    ctx.audit("copilot.feedback", "conversation", str(conversation_id), after={"seq": seq, "rating": body.rating})
    return {"rating": body.rating, "comment": comment}


@router.delete(
    "/sites/{site_id}/copilot/conversations/{conversation_id}/messages/{seq}/feedback",
    status_code=status.HTTP_204_NO_CONTENT,
)
def unrate_answer(ctx: Ctx, conversation_id: uuid.UUID, seq: int) -> None:
    """Withdraw your rating of an answer."""
    _answer(ctx, conversation_id, seq)
    ctx.conn.execute("DELETE FROM copilot_feedback WHERE conversation_id = %s AND seq = %s", [conversation_id, seq])
    ctx.audit("copilot.feedback.delete", "conversation", str(conversation_id), after={"seq": seq})


@router.get("/sites/{site_id}/copilot/usage", response_model=Usage)
def usage(ctx: Admin, request: Request, days: Annotated[int, Query(ge=1, le=90)] = 30) -> dict[str, Any]:
    """The site's copilot usage by UTC day and by user, with the limits and today's budget (admins)."""
    return copilot_usage.dashboard(ctx.conn, request.app.state.settings, ctx.org_id, ctx.site_id, days)


@router.get("/sites/{site_id}/copilot/feedback", response_model=list[FeedbackRow])
def list_feedback(
    ctx: Admin, rating: Literal["up", "down"] | None = None, limit: Annotated[int, Query(ge=1, le=200)] = 100
) -> list[dict[str, Any]]:
    """The site's rated answers, newest first, with their question (admins)."""
    rows = ctx.conn.execute(
        """
        SELECT f.conversation_id, f.seq, f.rating, f.comment, f.updated_at, u.name AS user, a.content AS answer,
               a.meta -> 'grounding' -> 'grounded' AS grounded,
               (SELECT q.content FROM conversation_messages q
                WHERE q.conversation_id = f.conversation_id AND q.seq < f.seq AND q.role = 'user'
                  AND EXISTS (SELECT 1 FROM jsonb_array_elements(q.content) b WHERE b ->> 'type' = 'text')
                ORDER BY q.seq DESC LIMIT 1) AS question
        FROM copilot_feedback f JOIN users u ON u.id = f.user_id
        JOIN conversation_messages a ON a.conversation_id = f.conversation_id AND a.seq = f.seq
        WHERE f.site_id = %s AND (%s::text IS NULL OR f.rating = %s)
        ORDER BY f.updated_at DESC LIMIT %s
        """,
        [ctx.site_id, rating, rating, limit],
    ).fetchall()
    return [
        r
        | {
            "answer": grounding.text_of({"content": r["answer"]}),
            "question": grounding.text_of({"content": r["question"] or []}),
        }
        for r in rows
    ]
