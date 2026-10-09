"""Database access: a connection pool shared by request handlers."""

import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated

import psycopg
from fastapi import Depends, Request
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool

from tiles_api.settings import Settings

Conn = psycopg.Connection[DictRow]


APP_ROLE = "tiles_app"  # migration 0024


def act_as_app(conn: Conn) -> None:
    """Makes the connection's work subject to row security (T5.04): a login that would skip it (a
    superuser, as Compose's is, or one with BYPASSRLS) works as `tiles_app` from here on. A login
    without those powers is left as it is: its own tables' policies are forced."""
    row = conn.execute("SELECT rolsuper OR rolbypassrls AS skips FROM pg_roles WHERE rolname = current_user").fetchone()
    if row is not None and row["skips"]:
        if conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", [APP_ROLE]).fetchone() is None:
            raise RuntimeError(f"Run the migrations: the {APP_ROLE} role (row security, 0024) is missing")
        conn.execute(f"SET ROLE {APP_ROLE}")
    conn.commit()


def open_pool(settings: Settings) -> ConnectionPool[Conn]:
    """The API's connections: every one subject to row security (`act_as_app`). Scheduled jobs and
    migrations connect on their own, as the login they are given."""
    return ConnectionPool(
        settings.database_url,
        min_size=1,
        max_size=settings.db_pool_max,
        kwargs={"row_factory": dict_row},
        connection_class=psycopg.Connection[DictRow],
        configure=act_as_app,
        open=True,
    )


_pool_lock = threading.Lock()


def get_conn(request: Request) -> Iterator[Conn]:
    """FastAPI dependency: one connection and transaction per request.

    The pool is created on first use, so the app (and /health) starts without
    a database. Use it as `DbConn` (function scope): the transaction then
    commits before the response is sent, so a client that gets a 201 can read
    its write straight away.
    """
    state = request.app.state
    if state.pool is None:
        # Sync dependencies run in a thread pool: create the pool only once.
        with _pool_lock:
            if state.pool is None:
                state.pool = open_pool(state.settings)
    pool: ConnectionPool[Conn] = state.pool
    with pool.connection() as conn:
        yield conn


def close_pool(state: object) -> None:
    pool: ConnectionPool[Conn] | None = getattr(state, "pool", None)
    if pool is not None:
        pool.close()


def scope_to_site(conn: Conn, site_id: uuid.UUID) -> None:
    """Scopes the rest of the transaction to one site's rows (row security, migration 0024)."""
    conn.execute("SELECT set_config('tiles.site_id', %s, true)", [str(site_id)])


UNSCOPED = "-c tiles.site_id=*"  # psycopg.connect(options=…) for jobs: every site's rows


@contextmanager
def all_sites(conn: Conn) -> Iterator[None]:
    """Every site's rows for the statements inside (an organisation's totals, an agent's token),
    then the scope it had again. Use it only for what spans sites by design."""
    before = one(conn.execute("SELECT coalesce(current_setting('tiles.site_id', true), '') AS s").fetchone())["s"]
    conn.execute("SELECT set_config('tiles.site_id', '*', true)")
    yield
    # Restored only after the block succeeded: after an error the transaction is rolled back
    # (and the setting with it), and the error is the one to see.
    conn.execute("SELECT set_config('tiles.site_id', %s, true)", [before])


def one[T](row: T | None) -> T:
    """The row a RETURNING or single-row query must produce."""
    if row is None:
        raise RuntimeError("query returned no row")
    return row


DbConn = Annotated[Conn, Depends(get_conn, scope="function")]
