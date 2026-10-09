"""SCIM 2.0 user provisioning (T5.05, RFC 7643 and 7644): an identity provider's provisioning
client (Entra ID's, say) creates, updates, deactivates and deletes an organisation's users.

It signs in with a SCIM token an organisation admin made (`/org/scim-tokens`), which names the
organisation: every call reaches that organisation's users only. Users only; groups aren't
provisioned (roles come from the token's app roles or groups at sign-in, and site admins set
memberships). A user's `userName` is their email. Deactivating (`active: false`) refuses their
sign-in and keeps their site memberships for when they come back; deleting also ends the
memberships and hides the user from SCIM, while the history that names them stays. Attributes
Tiles doesn't keep (title, phone numbers, …) are accepted and ignored, as provisioning clients
send them all.
"""

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

import psycopg
from fastapi import APIRouter, Depends, Header, Query, Request, status
from fastapi.responses import JSONResponse, Response

from tiles_api import audit
from tiles_api.auth import EMAIL
from tiles_api.org_sign_in import SCIM_TOKEN_PREFIX, scim_token_hash
from tiles_api.store import Conn, DbConn, all_sites

router = APIRouter(prefix="/scim/v2", tags=["provisioning"])

MEDIA = "application/scim+json"
USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error"
PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
MAX_COUNT = 200

USER_SQL = """
    SELECT id, email, name, external_id, active, created_at
    FROM users WHERE org_id = %s AND deleted_at IS NULL
"""


class ScimError(Exception):
    """A SCIM error response (RFC 7644 §3.12)."""

    def __init__(self, status_code: int, detail: str, scim_type: str | None = None) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.scim_type = scim_type


def error_response(_request: Request, exc: Exception) -> Response:
    if not isinstance(exc, ScimError):  # registered for ScimError only
        raise exc
    body: dict[str, Any] = {"schemas": [ERROR_SCHEMA], "status": str(exc.status_code), "detail": exc.detail}
    if exc.scim_type:
        body["scimType"] = exc.scim_type
    headers = {"WWW-Authenticate": "Bearer"} if exc.status_code == 401 else None
    return JSONResponse(body, status_code=exc.status_code, media_type=MEDIA, headers=headers)


def scim(body: Any, status_code: int = 200, location: str | None = None) -> JSONResponse:
    return JSONResponse(
        body, status_code=status_code, media_type=MEDIA, headers={"Location": location} if location else None
    )


@dataclass(frozen=True)
class ScimClient:
    conn: Conn
    org_id: uuid.UUID
    name: str


def scim_client(conn: DbConn, authorization: Annotated[str, Header()] = "") -> ScimClient:
    """Dependency: the organisation whose SCIM token this is; 401 otherwise."""
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.startswith(SCIM_TOKEN_PREFIX):
        raise ScimError(401, "A SCIM token is required")
    row = conn.execute(
        "UPDATE scim_tokens SET last_used_at = now() WHERE token_hash = %s AND revoked_at IS NULL"
        " RETURNING org_id, name",
        [scim_token_hash(token.strip())],
    ).fetchone()
    if row is None:
        raise ScimError(401, "Unknown or revoked SCIM token")
    return ScimClient(conn, row["org_id"], f"SCIM: {row['name']}")


Client = Annotated[ScimClient, Depends(scim_client, scope="function")]
scim_client.minimum_role = "SCIM token"  # type: ignore[attr-defined]  # read by apidoc.caller


def resource(row: dict[str, Any], request: Request) -> dict[str, Any]:
    created: datetime = row["created_at"]
    return {
        "schemas": [USER_SCHEMA],
        "id": str(row["id"]),
        **({"externalId": row["external_id"]} if row["external_id"] else {}),
        "userName": row["email"],
        "name": {"formatted": row["name"]},
        "displayName": row["name"],
        "emails": [{"value": row["email"], "type": "work", "primary": True}],
        "active": row["active"],
        "meta": {
            "resourceType": "User",
            "created": created.astimezone(UTC).isoformat(),
            "location": str(request.url_for("get_user", user_id=str(row["id"]))),
        },
    }


@dataclass
class Fields:
    """The attributes Tiles keeps, as a request sets them."""

    email: str | None = None  # the userName: Tiles' key for the person, their email address
    mail: str | None = None  # from emails: the email only for a new or replaced user without one
    name: str | None = None
    external_id: str | None = None
    active: bool | None = None
    given: str | None = None
    family: str | None = None


def _text(value: Any, what: str, limit: int = 200) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ScimError(400, f"{what} must be text of 1 to {limit} characters", "invalidValue")
    return value.strip()


def _email(value: Any) -> str:
    email = _text(value, "userName").lower()
    if not EMAIL.match(email):
        raise ScimError(400, "userName must be the user's email address", "invalidValue")
    return email


def _bool(value: Any) -> bool:
    # Some clients send "True"/"False" as text in PATCH values.
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in ("true", "false"):
        return value.lower() == "true"
    raise ScimError(400, "active must be true or false", "invalidValue")


def _primary_email(emails: Any) -> str | None:
    if not isinstance(emails, list):
        return None
    chosen = [e for e in emails if isinstance(e, dict) and e.get("primary")] or [
        e for e in emails if isinstance(e, dict)
    ]
    return str(chosen[0].get("value")) if chosen and chosen[0].get("value") else None


def _set(fields: Fields, attribute: str, value: Any) -> None:
    """One attribute by its SCIM path, e.g. `active`, `name.givenName`, `emails[type eq "work"].value`."""
    path = attribute.strip()
    if path.lower().startswith(USER_SCHEMA.lower() + ":"):
        path = path[len(USER_SCHEMA) + 1 :]
    key = path.lower()
    if key == "username":
        fields.email = _email(value)
    elif key == "active":
        fields.active = _bool(value)
    elif key == "externalid":
        fields.external_id = _text(value, "externalId", 500) if value is not None else ""
    elif key in ("displayname", "name.formatted"):
        fields.name = _text(value, "displayName")
    elif key == "name.givenname":
        fields.given = _text(value, "name.givenName")
    elif key == "name.familyname":
        fields.family = _text(value, "name.familyName")
    elif key == "name" and isinstance(value, dict):
        for sub, v in value.items():
            if sub in ("formatted", "givenName", "familyName") and v is not None:
                _set(fields, f"name.{sub}", v)
    elif key == "emails" or re.fullmatch(r"emails\[.*\]\.value", key):
        # A mail address, which may differ from the userName (Entra ID's userPrincipalName): it
        # never changes who the person is; see _from_resource.
        mail = str((_primary_email(value) if key == "emails" else value) or "").strip().lower()
        fields.mail = mail if EMAIL.match(mail) else None
    elif isinstance(value, dict) and key == "":
        for sub, v in value.items():
            _set(fields, sub, v)
    # Anything else (title, phoneNumbers, an enterprise extension, …): Tiles doesn't keep it.


def _from_resource(body: Any) -> Fields:
    """A whole User (create, replace). Its email is its userName, or when that isn't an email
    address, its primary email."""
    if not isinstance(body, dict):
        raise ScimError(400, "The body must be a SCIM User", "invalidSyntax")
    fields = Fields()
    for key in ("active", "externalId", "name", "displayName", "emails"):
        if key in body and body[key] is not None:
            _set(fields, key, body[key])
    user_name = str(body.get("userName") or "").strip().lower()
    fields.email = user_name if EMAIL.match(user_name) else fields.mail
    if fields.email is None:
        raise ScimError(400, "A user needs an email address: as its userName, or in emails", "invalidValue")
    return fields


def _name(fields: Fields, current: str | None, email: str) -> str:
    if fields.name:
        return fields.name
    parts = [p for p in (fields.given, fields.family) if p]
    if parts:
        return " ".join(parts)
    return current or email.split("@")[0]


def _load(client: ScimClient, user_id: str) -> dict[str, Any]:
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise ScimError(404, "No such user") from None
    row: dict[str, Any] | None = client.conn.execute(f"{USER_SQL} AND id = %s", [client.org_id, uid]).fetchone()
    if row is None:
        raise ScimError(404, "No such user")
    return row


def _audit(client: ScimClient, action: str, user_id: uuid.UUID, before: Any = None, after: Any = None) -> None:
    audit.record_org(
        client.conn,
        org_id=client.org_id,
        actor_id=None,
        actor_name=client.name,
        action=action,
        entity_type="user",
        entity_id=str(user_id),
        before=before,
        after=after,
    )


def _audited(row: dict[str, Any]) -> dict[str, Any]:
    return {"email": row["email"], "name": row["name"], "external_id": row["external_id"], "active": row["active"]}


def _write(client: ScimClient, user: dict[str, Any], fields: Fields) -> dict[str, Any]:
    """Applies `fields` to an existing user; 409 if the email is another user's."""
    email = fields.email or user["email"]
    external_id = user["external_id"] if fields.external_id is None else (fields.external_id or None)
    try:
        with client.conn.transaction():
            row: dict[str, Any] = (
                client.conn.execute(
                    "UPDATE users SET email = %s, name = %s, external_id = %s, active = %s WHERE id = %s"
                    " RETURNING id, email, name, external_id, active, created_at",
                    [
                        email,
                        _name(fields, user["name"], email),
                        external_id,
                        user["active"] if fields.active is None else fields.active,
                        user["id"],
                    ],
                ).fetchone()
                or {}
            )
    except psycopg.errors.UniqueViolation:
        raise ScimError(409, "Another user has that userName or externalId", "uniqueness") from None
    if _audited(row) != _audited(user):
        _audit(client, "scim.user.update", row["id"], _audited(user), _audited(row))
    return row


async def scim_body(request: Request) -> Any:
    """The request's JSON (application/scim+json), read on the event loop, so the handlers can be
    plain functions that run their database calls on worker threads."""
    try:
        return await request.json()
    except ValueError:
        raise ScimError(400, "The body must be JSON", "invalidSyntax") from None


Body = Annotated[Any, Depends(scim_body)]


@router.get("/ServiceProviderConfig")
def service_provider_config() -> JSONResponse:
    """What this SCIM service supports (public, as RFC 7644 allows)."""
    return scim(
        {
            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
            "patch": {"supported": True},
            "bulk": {"supported": False, "maxOperations": 0, "maxPayloadSize": 0},
            "filter": {"supported": True, "maxResults": MAX_COUNT},
            "changePassword": {"supported": False},
            "sort": {"supported": False},
            "etag": {"supported": False},
            "authenticationSchemes": [
                {"type": "oauthbearertoken", "name": "SCIM token", "description": "From /org/scim-tokens"}
            ],
        }
    )


@router.get("/ResourceTypes")
def resource_types() -> JSONResponse:
    """The resources: users only."""
    return scim(
        {
            "schemas": [LIST_SCHEMA],
            "totalResults": 1,
            "Resources": [
                {
                    "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
                    "id": "User",
                    "name": "User",
                    "endpoint": "/Users",
                    "schema": USER_SCHEMA,
                }
            ],
        }
    )


FILTER = re.compile(r'^\s*(userName|externalId|emails\.value|emails)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$', re.IGNORECASE)


@router.get("/Users")
def list_users(
    client: Client,
    request: Request,
    filter: Annotated[str | None, Query(max_length=500)] = None,
    start_index: Annotated[int, Query(alias="startIndex")] = 1,
    count: Annotated[int, Query()] = 100,
) -> JSONResponse:
    """The organisation's users, with `filter=userName eq "…"` (or `externalId`, `emails.value`),
    `startIndex` (from 1) and `count` (up to 200)."""
    sql, args = USER_SQL, list[object]([client.org_id])
    if filter:
        match = FILTER.match(filter)
        if not match:
            raise ScimError(400, 'Filters supported: userName, externalId or emails.value eq "…"', "invalidFilter")
        attribute, value = match.group(1).lower(), re.sub(r"\\(.)", r"\1", match.group(2))
        if attribute == "externalid":
            sql, args = sql + " AND external_id = %s", [*args, value]
        else:
            sql, args = sql + " AND email = %s", [*args, value.strip().lower()]
    start, count = max(start_index, 1), min(max(count, 0), MAX_COUNT)
    total = client.conn.execute(f"SELECT count(*) AS n FROM ({sql}) t", args).fetchone()  # noqa: S608 - constants
    rows = client.conn.execute(
        f"{sql} ORDER BY created_at, id OFFSET %s LIMIT %s", [*args, start - 1, count]
    ).fetchall()
    return scim(
        {
            "schemas": [LIST_SCHEMA],
            "totalResults": total["n"] if total else 0,
            "startIndex": start,
            "itemsPerPage": len(rows),
            "Resources": [resource(r, request) for r in rows],
        }
    )


@router.get("/Users/{user_id}", name="get_user")
def get_user(user_id: str, client: Client, request: Request) -> JSONResponse:
    """One user."""
    return scim(resource(_load(client, user_id), request))


@router.post("/Users", status_code=status.HTTP_201_CREATED)
def create_user(request: Request, client: Client, body: Body) -> JSONResponse:
    """Creates a user (they sign in later, and are linked by email). A user deleted before comes
    back with their history; 409 if the email or externalId is an existing user's."""
    fields = _from_resource(body)
    email = fields.email or ""
    conn = client.conn
    deleted = conn.execute(
        "SELECT id, email, name, external_id, active, created_at FROM users"
        " WHERE org_id = %s AND email = %s AND deleted_at IS NOT NULL",
        [client.org_id, email],
    ).fetchone()
    try:
        with conn.transaction():
            if deleted:
                conn.execute("UPDATE users SET deleted_at = NULL WHERE id = %s", [deleted["id"]])
                row: dict[str, Any] = (
                    conn.execute(
                        "UPDATE users SET name = %s, external_id = %s, active = %s WHERE id = %s"
                        " RETURNING id, email, name, external_id, active, created_at",
                        [
                            _name(fields, None, email),
                            fields.external_id or None,
                            True if fields.active is None else fields.active,
                            deleted["id"],
                        ],
                    ).fetchone()
                    or {}
                )
            else:
                row = (
                    conn.execute(
                        "INSERT INTO users (org_id, email, name, external_id, active) VALUES (%s, %s, %s, %s, %s)"
                        " RETURNING id, email, name, external_id, active, created_at",
                        [
                            client.org_id,
                            email,
                            _name(fields, None, email),
                            fields.external_id or None,
                            True if fields.active is None else fields.active,
                        ],
                    ).fetchone()
                    or {}
                )
    except psycopg.errors.UniqueViolation:
        raise ScimError(409, "A user with that userName or externalId exists", "uniqueness") from None
    _audit(client, "scim.user.create", row["id"], after=_audited(row))
    body = resource(row, request)
    return scim(body, 201, body["meta"]["location"])


@router.put("/Users/{user_id}")
def replace_user(user_id: str, request: Request, client: Client, body: Body) -> JSONResponse:
    """Replaces a user's attributes (those Tiles keeps)."""
    fields = _from_resource(body)
    user = _load(client, user_id)
    if fields.external_id is None:
        fields.external_id = ""  # a replacement without it clears it
    return scim(resource(_write(client, user, fields), request))


@router.patch("/Users/{user_id}")
def patch_user(user_id: str, request: Request, client: Client, body: Body) -> JSONResponse:
    """Changes a user with `Operations` (`add`, `replace`; `remove` of `externalId`), by path or
    by a value object without one, as Entra ID sends them."""
    ops = body.get("Operations") if isinstance(body, dict) else None
    if not isinstance(ops, list) or not ops:
        raise ScimError(400, "A PATCH needs Operations", "invalidSyntax")
    user = _load(client, user_id)
    fields = Fields()
    for op in ops:
        if not isinstance(op, dict):
            raise ScimError(400, "Each operation is an object", "invalidSyntax")
        kind = str(op.get("op", "")).lower()
        path = str(op.get("path") or "")
        if kind in ("add", "replace"):
            _set(fields, path, op.get("value"))
        elif kind == "remove":
            if path.lower() == "externalid":
                fields.external_id = ""
            elif path.lower() in ("username", "active"):
                raise ScimError(400, f"{path} can't be removed", "mutability")
        else:
            raise ScimError(400, f"Unknown operation {op.get('op')!r}", "invalidSyntax")
    return scim(resource(_write(client, user, fields), request))


@router.delete("/Users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: str, client: Client) -> Response:
    """Deletes a user: they can't sign in, their site memberships end, and SCIM no longer finds
    them. What they did stays in the history, under their name."""
    user = _load(client, user_id)
    conn = client.conn
    # The external ID goes too: the provider may give it to someone provisioned later.
    conn.execute("UPDATE users SET active = false, deleted_at = now(), external_id = NULL WHERE id = %s", [user["id"]])
    with all_sites(conn):  # the memberships are the organisation's sites' rows
        conn.execute("DELETE FROM site_members WHERE user_id = %s", [user["id"]])
    _audit(client, "scim.user.delete", user["id"], before=_audited(user))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
