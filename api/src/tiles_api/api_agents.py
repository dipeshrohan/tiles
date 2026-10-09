"""Edge agents (T2.01, ADR 003): site admins register agents; agents send heartbeats.

An agent runs on the plant network and only ever calls out to Tiles. It
authenticates with its own bearer token (`tla_…`), never a user's, and the
API keeps only the token's SHA-256 hash. Commands for an agent, when there
are any, travel back in the heartbeat answer: the agent pulls, Tiles never
connects in.
"""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Header, HTTPException, status
from psycopg import errors
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field

from tiles_api.api_ontology import Admin, Ctx
from tiles_api.store import DbConn, all_sites, one, scope_to_site

router = APIRouter(tags=["edge agents"])

TOKEN_PREFIX = "tla_"  # noqa: S105 - a public prefix, not a secret
# An agent counts as online until it has missed this many heartbeats.
MISSED_HEARTBEATS = 3

AgentName = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")]


def token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


class AgentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: AgentName


class Agent(BaseModel):
    id: uuid.UUID
    name: str
    created_at: datetime
    last_seen_at: datetime | None
    status: Literal["online", "offline", "never seen"]
    version: str | None
    hostname: str | None
    connectors: list[dict[str, Any]]
    buffer: dict[str, Any] | None


class NewAgent(BaseModel):
    agent: Agent
    # Shown once: only its hash is stored.
    token: str


class ConnectorStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=100)]
    kind: Annotated[str, Field(min_length=1, max_length=50)]
    status: Literal["ok", "degraded", "down"]
    detail: Annotated[str, Field(max_length=500)] = ""


Count = Annotated[int, Field(ge=0)]


class BufferStatus(BaseModel):
    """The agent's store-and-forward buffer (T2.04): what waits on its disk for Tiles."""

    model_config = ConfigDict(extra="forbid")
    queued: Count
    oldest_at: datetime | None = None
    sent: Count = 0
    dropped: Count = 0
    rejected: Count = 0
    problem: Annotated[str, Field(max_length=300)] = ""


class HeartbeatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Annotated[str, Field(min_length=1, max_length=50)]
    hostname: Annotated[str, Field(max_length=255)] = ""
    started_at: datetime
    heartbeat_seconds: Annotated[int, Field(ge=1, le=3600)]
    connectors: Annotated[list[ConnectorStatus], Field(max_length=100)] = []
    buffer: BufferStatus | None = None


class HeartbeatOut(BaseModel):
    agent_id: uuid.UUID
    site_id: uuid.UUID
    server_time: datetime
    # Work for the agent, pulled with each heartbeat. None exist yet.
    commands: list[dict[str, Any]]


AGENT_SQL = """
SELECT id, name, created_at, last_seen_at, last_status FROM edge_agents
WHERE site_id = %s AND revoked_at IS NULL
"""


def agent_view(row: dict[str, Any], now: datetime) -> Agent:
    status_: dict[str, Any] = row["last_status"] or {}
    seen: datetime | None = row["last_seen_at"]
    if seen is None:
        state: Literal["online", "offline", "never seen"] = "never seen"
    else:
        every = timedelta(seconds=int(status_.get("heartbeat_seconds", 30)))
        state = "online" if now - seen <= every * MISSED_HEARTBEATS else "offline"
    return Agent(
        id=row["id"],
        name=row["name"],
        created_at=row["created_at"],
        last_seen_at=seen,
        status=state,
        version=status_.get("version"),
        hostname=status_.get("hostname"),
        connectors=status_.get("connectors", []),
        buffer=status_.get("buffer"),
    )


def db_now(conn: Any) -> datetime:
    now: datetime = one(conn.execute("SELECT clock_timestamp() AS now").fetchone())["now"]
    return now


@router.get("/sites/{site_id}/agents", response_model=list[Agent])
def list_agents(ctx: Ctx) -> list[Agent]:
    """The site's edge agents (not revoked ones) and whether each is online."""
    now = db_now(ctx.conn)
    return [agent_view(r, now) for r in ctx.conn.execute(AGENT_SQL + " ORDER BY name", [ctx.site_id])]


@router.post("/sites/{site_id}/agents", response_model=NewAgent, status_code=status.HTTP_201_CREATED)
def register_agent(ctx: Admin, body: AgentIn) -> NewAgent:
    """Register an agent (admins only). The answer holds its token, which is never shown again."""
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    try:
        with ctx.conn.transaction():  # a savepoint, so a duplicate name doesn't abort the request's transaction
            row = one(
                ctx.conn.execute(
                    """
                    INSERT INTO edge_agents (org_id, site_id, name, token_hash, created_by)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING id, name, created_at, last_seen_at, last_status
                    """,
                    [ctx.org_id, ctx.site_id, body.name, token_hash(token), ctx.user.id],
                ).fetchone()
            )
    except errors.UniqueViolation:
        raise HTTPException(status.HTTP_409_CONFLICT, f"An agent named {body.name} already exists") from None
    ctx.audit("agent.register", "edge_agent", str(row["id"]), after={"name": body.name})
    return NewAgent(agent=agent_view(row, db_now(ctx.conn)), token=token)


@router.delete("/sites/{site_id}/agents/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_agent(ctx: Admin, agent_id: uuid.UUID) -> None:
    """Revoke an agent (admins only): its token stops working at once."""
    row = ctx.conn.execute(
        "UPDATE edge_agents SET revoked_at = clock_timestamp()"
        " WHERE id = %s AND site_id = %s AND revoked_at IS NULL RETURNING name",
        [agent_id, ctx.site_id],
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such agent on this site")
    ctx.audit("agent.revoke", "edge_agent", str(agent_id), before={"name": row["name"]})


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail, headers={"WWW-Authenticate": "Bearer"})


def agent_token(authorization: str) -> bytes:
    """The hash of the agent token in an Authorization header; 401 if there is none."""
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.startswith(TOKEN_PREFIX):
        raise _unauthorized("An edge agent token is required")
    return token_hash(token)


def calling_agent(conn: Any, authorization: str) -> dict[str, Any]:
    """The active agent whose token this is (id, site_id, name); 401 otherwise."""
    with all_sites(conn):  # the token says which site's agent it is
        row: dict[str, Any] | None = conn.execute(
            "SELECT id, site_id, name FROM edge_agents WHERE token_hash = %s AND revoked_at IS NULL",
            [agent_token(authorization)],
        ).fetchone()
    if row is None:
        raise _unauthorized("Unknown or revoked agent token")
    scope_to_site(conn, row["site_id"])  # the rest of the request is the agent's site's (T5.04)
    return row


@router.post("/agent/heartbeat", response_model=HeartbeatOut)
def heartbeat(body: HeartbeatIn, conn: DbConn, authorization: Annotated[str, Header()] = "") -> HeartbeatOut:
    """Called by an edge agent every `heartbeat_seconds`, with its own token."""
    agent = calling_agent(conn, authorization)
    row = conn.execute(
        """
        UPDATE edge_agents SET last_seen_at = clock_timestamp(), last_status = %s
        WHERE id = %s RETURNING id, site_id, last_seen_at
        """,
        [Jsonb(body.model_dump(mode="json")), agent["id"]],
    ).fetchone()
    if row is None:
        raise _unauthorized("Unknown or revoked agent token")
    return HeartbeatOut(
        agent_id=row["id"], site_id=row["site_id"], server_time=row["last_seen_at"].astimezone(UTC), commands=[]
    )
