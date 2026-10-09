"""Running scheduled jobs over many items (model bindings, detectors), e.g. from cron: each item
in its own transaction, so one failing keeps the others' work, and the exit code says if any did."""

import sys
import uuid
from collections.abc import Callable
from typing import Literal

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from tiles_api.settings import get_settings
from tiles_api.store import UNSCOPED, Conn


def enabled(conn: Conn, table: Literal["model_bindings", "detectors"], site_id: uuid.UUID | None) -> list[uuid.UUID]:
    """The enabled rows of `table`, of one site if given, oldest first."""
    query = sql.SQL(
        "SELECT id FROM {} WHERE enabled AND (%s::uuid IS NULL OR site_id = %s) ORDER BY created_at"
    ).format(sql.Identifier(table))
    return [r["id"] for r in conn.execute(query, [site_id, site_id])]


def run_each(ids: Callable[[Conn], list[uuid.UUID]], run_one: Callable[[Conn, uuid.UUID], tuple[str, bool]]) -> None:
    """Runs `run_one` on each id, one transaction each, printing the line it returns. An item that
    raises, or reports it didn't go well (False), makes the exit code 1."""
    failed = False
    with psycopg.connect(
        get_settings().database_url.get_secret_value(), row_factory=dict_row, autocommit=True, options=UNSCOPED
    ) as conn:
        for item in ids(conn):
            try:
                with conn.transaction():
                    line, ok = run_one(conn, item)
            except Exception as e:
                failed = True
                print(f"{item}: not run ({e})", file=sys.stderr)
                continue
            print(f"{item}: {line}")
            failed = failed or not ok
    if failed:
        raise SystemExit(1)
