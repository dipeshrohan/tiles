"""Database access: a connection pool shared by request handlers."""

import asyncio
import threading
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from typing import Annotated, Any

import psycopg
from fastapi import Depends, HTTPException, Request, status
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


def open_pool(settings: Settings, size: int | None = None) -> ConnectionPool[Conn]:
    """The API's connections: every one subject to row security (`act_as_app`). Scheduled jobs and
    migrations connect on their own, as the login they are given."""
    return ConnectionPool(
        settings.database_url.get_secret_value(),
        min_size=1,
        max_size=size or settings.db_pool_max,
        kwargs={"row_factory": dict_row},
        connection_class=psycopg.Connection[DictRow],
        configure=act_as_app,
        open=True,
    )


_pool_lock = threading.Lock()


async def db_slot(request: Request) -> AsyncIterator[None]:
    """Waits for one of the pool's connections to be free, on the event loop, before the request
    takes a worker thread for it (T5.15).

    Sync handlers run on worker threads (40), each taking a connection (`db_pool_max`). With more
    requests than connections, threads blocked on the pool left none for the requests holding a
    connection to run their handler, and every request stalled until the pool's timeout (found by
    the load test). Here the wait holds no thread; past `db_wait_seconds`, the answer is a 503.
    """
    state = request.app.state
    loop = asyncio.get_running_loop()
    if state.db_slots is None or state.db_slots[0] is not loop:  # one per event loop (tests run several)
        state.db_slots = (loop, asyncio.Semaphore(state.settings.db_pool_max))
    slots: asyncio.Semaphore = state.db_slots[1]
    try:
        async with asyncio.timeout(state.settings.db_wait_seconds):
            await slots.acquire()
    except TimeoutError:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Tiles is busy: try again in a moment", headers={"Retry-After": "2"}
        ) from None
    try:
        yield
    finally:
        slots.release()


def get_conn(request: Request, _slot: Annotated[None, Depends(db_slot, scope="function")]) -> Iterator[Conn]:
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


def side_pool(state: Any) -> ConnectionPool[Conn]:
    """Connections for work outside a request's own: the copilot's answer as it streams, sweeps
    running after their request. Kept apart from the requests' pool, whose every connection
    `db_slot` counts, so this work can't take one a queued request was promised."""
    if state.side_pool is None:
        with _pool_lock:
            if state.side_pool is None:
                state.side_pool = open_pool(state.settings, state.settings.db_side_pool_max)
    pool: ConnectionPool[Conn] = state.side_pool
    return pool


def close_pool(state: object) -> None:
    for name in ("pool", "side_pool"):
        pool: ConnectionPool[Conn] | None = getattr(state, name, None)
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
