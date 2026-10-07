"""The audit log: every write, with who, what, when and before/after (ADR 004).

Entries are written in the same transaction as the change, so an entry
exists exactly when the change does. The table itself is append-only.
"""

import uuid
from typing import Any

from psycopg.types.json import Jsonb

from tiles_api.logging import request_id_var
from tiles_api.store import Conn


# `at` is clock_timestamp(), when the write happened, rather than the column
# default now(), which is when the transaction began (possibly before it waited
# for a lock).
def record(
    conn: Conn,
    *,
    org_id: uuid.UUID,
    site_id: uuid.UUID | None,
    actor_id: uuid.UUID | None,
    actor_name: str,
    action: str,
    entity_type: str,
    entity_id: str,
    before: Any = None,
    after: Any = None,
) -> None:
    conn.execute(
        """
        INSERT INTO audit_log
            (at, org_id, site_id, actor_id, actor_name, action, entity_type, entity_id, before, after, request_id)
        VALUES (clock_timestamp(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        [
            org_id,
            site_id,
            actor_id,
            actor_name,
            action,
            entity_type,
            entity_id,
            None if before is None else Jsonb(before),
            None if after is None else Jsonb(after),
            request_id_var.get(),
        ],
    )


# Newest first by time, which the (site_id, at DESC) index serves; id breaks ties
# so paging is stable.
def entries(conn: Conn, site_id: uuid.UUID, limit: int, offset: int) -> list[dict[str, Any]]:
    return conn.execute(
        """
        SELECT id, at, actor_id, actor_name, action, entity_type, entity_id, before, after, request_id
        FROM audit_log WHERE site_id = %s ORDER BY at DESC, id DESC LIMIT %s OFFSET %s
        """,
        [site_id, limit, offset],
    ).fetchall()
