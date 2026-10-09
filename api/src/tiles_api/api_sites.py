"""Setting up a site (T6.06): an organisation admin creates a site, and a site's onboarding progress
(its plant outline, an edge agent that has called in, tags mapped to the ontology, a machine with
live signals: the first dashboard), worked out from the site's own data each time, so the wizard
can be left and picked up again."""

import uuid
from dataclasses import dataclass
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from tiles_api import audit
from tiles_api import ontology as o
from tiles_api import ontology_store as store
from tiles_api.api_ontology import Auth, Ctx, Site
from tiles_api.identity import ensure_org, ensure_user
from tiles_api.store import Conn, DbConn, one, scope_to_site

router = APIRouter(tags=["sites"])


@dataclass(frozen=True)
class OrgCaller:
    """Someone who may manage an organisation's sites, and the organisation."""

    conn: Conn
    org_id: uuid.UUID
    org_slug: str
    user_id: uuid.UUID
    name: str


def org_admin(principal: Auth, conn: DbConn, org: Annotated[str | None, Query()] = None) -> OrgCaller:
    """Dependency: the caller, if they may create sites in their organisation: an organisation
    admin, or someone whose sign-in grants admin (tiles-admin), who would be admin of any site they
    open. The development identity, which has no organisation of its own, names one with `?org=`,
    or gets the only one there is."""
    slug = principal.org
    if slug is None:
        orgs = [r["slug"] for r in conn.execute("SELECT slug FROM orgs ORDER BY slug")]
        if org is not None and org in orgs:
            slug = org
        elif org is None and len(orgs) == 1:
            slug = orgs[0]
        else:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name the organisation with ?org=<slug>")
    elif org is not None and org != slug:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can create sites in your own organisation only")
    org_id = ensure_org(conn, slug)
    user = ensure_user(conn, principal, org_id)
    if not user["org_admin"] and principal.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Creating a site needs an organisation admin")
    return OrgCaller(conn, org_id, slug, user["id"], str(user["name"]))  # type: ignore[arg-type]


org_admin.minimum_role = "organisation admin"  # type: ignore[attr-defined]  # read by apidoc.caller

OrgAdmin = Annotated[OrgCaller, Depends(org_admin, scope="function")]


class NewSite(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,62}$", description="Lower case, digits and dashes")
    timezone: str = Field("UTC", description="An IANA time zone, e.g. Europe/Berlin")

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("A site needs a name")
        return v.strip()

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as e:
            raise ValueError(f"{v!r} is not a time zone") from e
        return v


@router.post("/sites", response_model=Site, status_code=status.HTTP_201_CREATED)
def create_site(body: NewSite, caller: OrgAdmin) -> dict[str, Any]:
    """Creates a site in your organisation, with you as its admin. Its slug must be new in the
    organisation (409 otherwise)."""
    conn = caller.conn
    try:
        with conn.transaction():
            row = one(
                conn.execute(
                    "INSERT INTO sites (org_id, slug, name, timezone) VALUES (%s, %s, %s, %s) RETURNING id",
                    [caller.org_id, body.slug, body.name, body.timezone],
                ).fetchone()
            )
    except psycopg.errors.UniqueViolation as e:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Your organisation already has a site called {body.slug}") from e
    site_id: uuid.UUID = row["id"]
    scope_to_site(conn, site_id)  # its rows: the membership and the audit entry (T5.04)
    conn.execute(
        "INSERT INTO site_members (site_id, user_id, role) VALUES (%s, %s, 'admin')", [site_id, caller.user_id]
    )
    audit.record(
        conn,
        org_id=caller.org_id,
        site_id=site_id,
        actor_id=caller.user_id,
        actor_name=caller.name,
        action="site.create",
        entity_type="site",
        entity_id=str(site_id),
        after=body.model_dump(),
    )
    return {"id": site_id, "slug": body.slug, "name": body.name, "org": caller.org_slug}


StepKey = Literal["site", "outline", "agent", "mapping", "dashboard"]


class Step(BaseModel):
    key: StepKey
    done: bool
    detail: str


class Onboarding(BaseModel):
    steps: list[Step]
    next: StepKey | None  # the first step not done; null once the site is set up
    machines: int  # in the committed ontology
    agents: int  # registered and not revoked
    agents_seen: int  # that have called in
    tags: int  # the site's tags (not a model's derived signals)
    mapped: int  # linked to a Signal node
    dashboard: dict[str, str] | None  # the machine to open first: {id, label}


def machine_of(graph: o.Graph, node_id: str) -> str | None:
    """The machine a Signal node belongs to: its PLC's (PLC emits it, the machine controlledBy the
    PLC), or the nearest Machine containing it. As the browser's js/lib/shopfloor.ts places it."""
    nodes, edges = graph["nodes"], list(graph["edges"].values())

    def into(to: str, rel: str) -> list[str]:
        return sorted(e["from"] for e in edges if e["to"] == to and e["rel"] == rel and e["from"] in nodes)

    for plc in into(node_id, "emits"):
        for m in into(plc, "controlledBy"):
            if nodes[m]["type"] == "Machine":
                return m
    seen = {node_id}
    at = node_id
    while parents := [p for p in into(at, "contains") if p not in seen]:
        at = parents[0]
        if nodes[at]["type"] == "Machine":
            return at
        seen.add(at)
    return None


def plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


@router.get("/sites/{site_id}/onboarding", response_model=Onboarding)
def onboarding(ctx: Ctx) -> Onboarding:
    """How far the site is set up, step by step: created, its plant outlined in the ontology, an
    edge agent that has called in, tags mapped to Signal nodes, and a machine with mapped signals
    (the first dashboard to open)."""
    conn = ctx.conn
    head = store.load_head(conn, ctx.site_id)
    machines = sum(1 for n in head["nodes"].values() if n["type"] == "Machine")
    agents = one(
        conn.execute(
            "SELECT count(*) AS n, count(last_seen_at) AS seen FROM edge_agents"
            " WHERE site_id = %s AND revoked_at IS NULL",
            [ctx.site_id],
        ).fetchone()
    )
    linked = [
        r["node_id"]
        for r in conn.execute(
            "SELECT node_id FROM signals WHERE site_id = %s AND node_id IS NOT NULL AND source NOT LIKE 'model:%%'",
            [ctx.site_id],
        )
    ]
    tags = one(
        conn.execute(
            "SELECT count(*) AS n FROM signals WHERE site_id = %s AND source NOT LIKE 'model:%%'", [ctx.site_id]
        ).fetchone()
    )
    # The machine with the most mapped signals: its page on Plant is the first dashboard.
    counts: dict[str, int] = {}
    for node in linked:
        if node in head["nodes"] and (m := machine_of(head, node)):
            counts[m] = counts.get(m, 0) + 1
    best = min(counts, key=lambda m: (-counts[m], head["nodes"][m]["label"], m)) if counts else None
    dashboard = {"id": best, "label": head["nodes"][best]["label"]} if best else None
    n_agents, seen, n_tags, mapped = int(agents["n"]), int(agents["seen"]), int(tags["n"]), len(linked)
    steps = [
        Step(key="site", done=True, detail="Created"),
        Step(
            key="outline",
            done=machines > 0,
            detail=f"{plural(machines, 'machine')} in the ontology" if machines else "No machines in the ontology yet",
        ),
        Step(
            key="agent",
            done=seen > 0,
            detail=f"{plural(seen, 'agent')} calling in"
            if seen
            else f"{plural(n_agents, 'agent')} registered, none has called in yet"
            if n_agents
            else "No edge agent yet",
        ),
        Step(
            key="mapping",
            done=mapped > 0,
            detail=f"{mapped} of {plural(n_tags, 'tag')} mapped" if n_tags else "No tags have arrived yet",
        ),
        Step(
            key="dashboard",
            done=dashboard is not None,
            detail=f"{dashboard['label']}: {plural(counts[best], 'mapped signal')}"
            if dashboard and best
            else "Needs a machine with a mapped signal",
        ),
    ]
    return Onboarding(
        steps=steps,
        next=next((s.key for s in steps if not s.done), None),
        machines=machines,
        agents=n_agents,
        agents_seen=seen,
        tags=n_tags,
        mapped=mapped,
        dashboard=dashboard,
    )
