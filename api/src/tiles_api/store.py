"""Database access: a connection pool shared by request handlers."""

from collections.abc import Iterator
from typing import Annotated

import psycopg
from fastapi import Depends, Request
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool

from tiles_api.settings import Settings

Conn = psycopg.Connection[DictRow]


def open_pool(settings: Settings) -> ConnectionPool[Conn]:
    return ConnectionPool(
        settings.database_url,
        min_size=1,
        max_size=settings.db_pool_max,
        kwargs={"row_factory": dict_row},
        connection_class=psycopg.Connection[DictRow],
        open=True,
    )


def get_conn(request: Request) -> Iterator[Conn]:
    """FastAPI dependency: one connection and transaction per request.

    The pool is created on first use, so the app (and /health) starts without
    a database. Use it as `DbConn` (function scope): the transaction then
    commits before the response is sent, so a client that gets a 201 can read
    its write straight away.
    """
    state = request.app.state
    if getattr(state, "pool", None) is None:
        state.pool = open_pool(state.settings)
    pool: ConnectionPool[Conn] = state.pool
    with pool.connection() as conn:
        yield conn


def close_pool(state: object) -> None:
    pool: ConnectionPool[Conn] | None = getattr(state, "pool", None)
    if pool is not None:
        pool.close()


def one[T](row: T | None) -> T:
    """The row a RETURNING or single-row query must produce."""
    if row is None:
        raise RuntimeError("query returned no row")
    return row


DbConn = Annotated[Conn, Depends(get_conn, scope="function")]
