"""Readiness checks: can the API reach the services it depends on?"""

import logging
from collections.abc import Callable
from typing import Literal

import psycopg
import redis

from tiles_api.settings import Settings

log = logging.getLogger("tiles_api.readiness")

CheckResult = Literal["ok", "unavailable"]


def check_database(settings: Settings) -> None:
    timeout = max(1, round(settings.ready_timeout))
    # connect_timeout only bounds connecting; statement_timeout makes the server
    # cancel the query too if it accepts the connection but then stalls.
    statement_ms = max(1, round(settings.ready_timeout * 1000))
    with psycopg.connect(
        settings.database_url, connect_timeout=timeout, options=f"-c statement_timeout={statement_ms}"
    ) as conn:
        conn.execute("SELECT 1")


def check_redis(settings: Settings) -> None:
    client = redis.Redis.from_url(
        settings.redis_url,
        socket_connect_timeout=settings.ready_timeout,
        socket_timeout=settings.ready_timeout,
    )
    try:
        client.ping()
    finally:
        client.close()


CHECKS: dict[str, Callable[[Settings], None]] = {"database": check_database, "redis": check_redis}


def run_checks(settings: Settings) -> dict[str, CheckResult]:
    results: dict[str, CheckResult] = {}
    for name, check in CHECKS.items():
        try:
            check(settings)
            results[name] = "ok"
        except Exception as err:
            # Log the reason server-side; the response only says "unavailable"
            # so connection strings and hostnames are never exposed.
            log.warning("readiness check failed", extra={"check": name, "error": type(err).__name__})
            results[name] = "unavailable"
    return results
