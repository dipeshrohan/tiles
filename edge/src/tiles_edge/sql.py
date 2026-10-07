"""SQL connector (T2.05): polls MES and quality databases for new rows.

Each [[sql.queries]] runs every `poll_seconds` with `:watermark` bound to where
the previous poll stopped: the largest value of its watermark column read so
far (an increasing ID, or the time a row was written). The new position is
saved in the disk buffer in the same transaction as the samples it produced,
so a crash or restart neither skips rows nor reads them twice. A poll reads at
most `max_rows` rows; if there are more, the next poll follows straight away.

The agent only reads (ADR 003): queries must be a single SELECT, PostgreSQL
sessions are read-only, SQLite files are opened read-only, and every poll runs
in a transaction that is rolled back.

Engines: sqlite (standard library), postgresql (the `postgresql` extra,
psycopg) and sqlserver (the `sqlserver` extra, Microsoft's mssql-python with
its ODBC driver). Network engines use TLS with the server's certificate and
host name verified.
"""

import contextlib
import itertools
import json
import logging
import math
import sqlite3
import threading
from collections.abc import Sequence
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, Literal

from tiles_edge.buffer import BufferError
from tiles_edge.config import WATERMARK_PARAM, SqlConfig, SqlQuery, Watermark
from tiles_edge.samples import Sample, StateSink, Value

log = logging.getLogger("tiles_edge.sql")

Status = Literal["ok", "degraded", "down"]


class ConnectorError(Exception):
    """Why a database or query can't be read; the message says what to fix."""


# ---- statements and watermarks ----------------------------------------------------------------


def statement(engine: str, query: str) -> str:
    """The query with :watermark in the driver's parameter style."""
    if engine == "sqlite":
        return query  # sqlite3 takes :watermark as it is
    if engine == "postgresql":
        # psycopg's style is %(name)s, so a literal % (as in LIKE 'a%') must be doubled.
        return WATERMARK_PARAM.sub("%(watermark)s", query.replace("%", "%%"))
    return WATERMARK_PARAM.sub("?", query)


def bind(engine: str, watermark: Watermark | float | Decimal) -> dict[str, Any] | tuple[Any, ...]:
    if engine == "sqlite" and isinstance(watermark, datetime):
        # SQLite keeps date-times as text, written like datetime('now') does.
        return {"watermark": watermark.isoformat(sep=" ")}
    return {"watermark": watermark} if engine in ("sqlite", "postgresql") else (watermark,)


def encode(value: object) -> dict[str, str | int]:
    """A watermark as JSON that keeps its type, so it binds the same way after a restart."""
    if isinstance(value, bool):
        raise ConnectorError("the watermark column holds true/false; it must increase with every row")
    if isinstance(value, int):
        return {"int": value}
    if isinstance(value, float):
        return {"float": repr(value)}
    if isinstance(value, Decimal):
        return {"decimal": str(value)}
    if isinstance(value, str):
        return {"text": value}
    if isinstance(value, datetime):
        return {"datetime": value.isoformat()}
    if isinstance(value, date):
        return {"date": value.isoformat()}
    raise ConnectorError(f"the watermark column holds {type(value).__name__} values; use a number or a date-time")


def decode(raw: dict[str, Any]) -> Any:
    [(kind, value)] = raw.items()
    match kind:
        case "int":
            return int(value)
        case "float":
            return float(value)
        case "decimal":
            return Decimal(value)
        case "text":
            return str(value)
        case "datetime":
            return datetime.fromisoformat(value)
        case "date":
            return date.fromisoformat(value)
    raise ValueError(f"unknown watermark type {kind}")


# ---- values -----------------------------------------------------------------------------------


def reading(raw: object) -> Value | None:
    """A column value as a Tiles reading; None for NULL. Raises ValueError for what can't be one."""
    if raw is None:
        return None
    if isinstance(raw, bool | int | str):
        return raw
    if isinstance(raw, float | Decimal):
        number = float(raw)
        if not math.isfinite(number):
            raise ValueError(f"{raw} is not a finite number")
        return number
    if isinstance(raw, datetime | date):
        return raw.isoformat()
    raise ValueError(f"a {type(raw).__name__} value can't be a reading")


def moment(raw: object, zone: Any) -> datetime:
    """A reading's time in UTC. Date-times stored without a time zone are in the connector's `timezone`."""
    if isinstance(raw, str):
        raw = datetime.fromisoformat(raw)
    if not isinstance(raw, datetime):
        raise ValueError(f"the time column holds a {type(raw).__name__}, not a date-time")
    if raw.tzinfo is None:
        raw = raw.replace(tzinfo=zone)
    return raw.astimezone(UTC)


# ---- connecting -------------------------------------------------------------------------------


def _password(config: SqlConfig) -> str:
    if config.password_file is None:  # the config requires one for network engines
        raise ConnectorError("no password_file")
    try:
        return config.password_file.read_text().strip()
    except OSError as e:
        raise ConnectorError(f"can't read the password file {config.password_file}: {e.strerror}") from None


def _odbc(value: str) -> str:
    """An ODBC connection-string value, braced so ; and } in it can't add settings."""
    return "{" + value.replace("}", "}}") + "}"


def connect(config: SqlConfig) -> Any:
    """A DB-API connection, in a transaction that is never committed. Raises ConnectorError or the driver's error."""
    login_timeout = min(config.timeout_seconds, 30)
    if config.engine == "sqlite":
        if config.path is None or not config.path.is_file():
            raise ConnectorError(f"there is no database file at {config.path}")
        uri = f"{config.path.resolve().as_uri()}?mode=ro"  # read-only: the agent never writes
        return sqlite3.connect(uri, uri=True, timeout=config.timeout_seconds, check_same_thread=False)
    password = _password(config)
    if config.engine == "postgresql":
        import psycopg

        # verify-full: the server's certificate must chain to a trusted CA and name this host.
        root = str(config.ca_file) if config.ca_file else "system"
        return psycopg.connect(
            host=config.host,
            port=config.port,
            dbname=config.database,
            user=config.username,
            password=password,
            connect_timeout=login_timeout,
            application_name="tiles-edge",
            options=f"-c default_transaction_read_only=on -c statement_timeout={config.timeout_seconds * 1000}",
            sslmode="verify-full" if config.tls else "disable",
            sslrootcert=root if config.tls else None,
        )
    import mssql_python

    settings = {
        "Server": f"tcp:{config.host},{config.port}",
        "Database": config.database or "",
        "UID": config.username or "",
        "PWD": password,
        # Encrypt=yes with TrustServerCertificate=no: the certificate must chain to a CA this
        # machine trusts and name this host.
        "Encrypt": "yes" if config.tls else "no",
        "TrustServerCertificate": "no",
        "ApplicationIntent": "ReadOnly",
    }
    conn = mssql_python.connect(
        ";".join(f"{k}={_odbc(v)}" for k, v in settings.items()), autocommit=False, timeout=login_timeout
    )
    conn.timeout = config.timeout_seconds  # per query
    return conn


def explain(e: BaseException) -> str:
    """A short, readable reason from a driver's error."""
    if isinstance(e, ConnectorError):
        return str(e)
    text = " ".join(str(e).split()) or type(e).__name__
    for noise in ("Driver Error: ", "DDBC Error: ", "[Microsoft]", "[ODBC Driver 18 for SQL Server]"):
        text = text.replace(noise, "")
    return text[:300]


# ---- the connector ----------------------------------------------------------------------------


class SqlConnector:
    kind = "sql"

    def __init__(self, config: SqlConfig, sink: StateSink, *, max_retry_seconds: float = 60) -> None:
        self.config = config
        self.sink = sink
        self.max_retry_seconds = max_retry_seconds
        self.rows = 0
        self.samples = 0
        self.unreadable = 0  # values or rows that couldn't be read
        self.unmapped = 0  # long rows whose signal_column value isn't in signals
        self.last_problem = ""
        self._lock = threading.Lock()
        self._state: tuple[Status, str] = ("down", "not started")
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def name(self) -> str:
        return self.config.name

    def status(self) -> dict[str, str]:
        with self._lock:
            state, detail = self._state
            counts = f"{self.rows} rows, {self.samples} samples"
            if self.unmapped:
                counts += f", {self.unmapped} rows of unmapped signals"
            if self.unreadable:
                counts += f", {self.unreadable} unreadable values (last: {self.last_problem})"
        return {"name": self.name, "kind": self.kind, "status": state, "detail": f"{detail}; {counts}"[:500]}

    def _set(self, state: Status, detail: str) -> None:
        with self._lock:
            changed = self._state[0] != state
            self._state = (state, detail)
        if changed:
            log.log(logging.INFO if state == "ok" else logging.WARNING, "connector %s", state,
                    extra={"connector": self.name, "detail": detail})  # fmt: skip

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"sql-{self.name}", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 10) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)

    # ---- position -----------------------------------------------------------------------------

    def _key(self, q: SqlQuery) -> str:
        return f"sql/{self.name}/{q.name}"

    def position(self, q: SqlQuery) -> Any:
        """Where the next poll starts: the saved watermark, or `start` the first time (or once
        `start` is changed in the config, which is how to read again from a given point)."""
        saved = self.sink.state(self._key(q))
        if saved is not None:
            stored = json.loads(saved)
            if stored.get("start") == encode(q.start):
                return decode(stored["watermark"])
        return q.start

    # ---- polling ------------------------------------------------------------------------------

    def _cursor(self, conn: Any) -> Any:
        if self.config.engine == "postgresql":
            return conn.cursor(name="tiles_edge")  # server-side: rows arrive in batches, not all at once
        return conn.cursor()

    def _execute(self, conn: Any, q: SqlQuery, watermark: Any, limit: int) -> tuple[list[str], list[Sequence[Any]]]:
        cur = self._cursor(conn)
        try:
            cur.execute(statement(self.config.engine, q.query), bind(self.config.engine, watermark))
            names = [str(d[0]) for d in cur.description or ()]
            rows = list(cur.fetchmany(limit))
        finally:
            cur.close()
            conn.rollback()  # the agent never commits
        return names, rows

    def _columns(self, q: SqlQuery, names: list[str]) -> dict[str, int]:
        index = {n.casefold(): i for i, n in enumerate(names)}
        wanted = [q.watermark, q.time, *q.columns]
        if q.signal_column and q.value_column:
            wanted += [q.signal_column, q.value_column]
        missing = [c for c in wanted if c.casefold() not in index]
        if missing:
            raise ConnectorError(
                f"query {q.name}: the result has no column {', '.join(missing)} (it has {', '.join(names) or 'none'})"
            )
        return {c: index[c.casefold()] for c in wanted}

    def check(self, conn: Any) -> None:
        """Runs each query from its current position and checks its columns; reads nothing."""
        for q in self.config.queries:
            names, _ = self._execute(conn, q, self.position(q), 1)
            self._columns(q, names)

    def poll(self, conn: Any, q: SqlQuery) -> bool:
        """Reads one batch of new rows and stores their samples with the new position.
        Returns whether there may be more rows waiting."""
        before = self.position(q)
        names, rows = self._execute(conn, q, before, self.config.max_rows)
        col = self._columns(q, names)
        full = len(rows) == self.config.max_rows

        if before is not None and rows:
            # Rows the database finds after the position but Python doesn't were read already: SQL
            # Server keeps date-times to 100 ns, Python to 1 µs, so the last row of a poll could
            # otherwise come back in every poll after it.
            with contextlib.suppress(TypeError):  # e.g. the column's type changed: the order check explains
                rows = [r for r in rows if r[col[q.watermark]] is None or r[col[q.watermark]] > before]
        if not rows:
            return False
        marks = [row[col[q.watermark]] for row in rows]
        known = [m for m in marks if m is not None]
        try:
            ordered = all(a <= b for a, b in itertools.pairwise(known))
        except TypeError:
            ordered = False
        if not ordered:
            raise ConnectorError(f"query {q.name}: rows aren't in {q.watermark} order; add ORDER BY {q.watermark}")
        if full and known:
            # The last watermark value may continue past this batch: leave its rows for the next poll,
            # which asks for rows after the value before it.
            last = known[-1]
            keep = len(rows)
            while keep and marks[keep - 1] in (last, None):
                keep -= 1
            if keep == 0:
                raise ConnectorError(
                    f"query {q.name}: more than max_rows ({self.config.max_rows}) rows have {q.watermark} = {last}; "
                    "raise max_rows"
                )
            rows, marks = rows[:keep], marks[:keep]

        samples, unreadable, unmapped, problem = self._samples(q, col, rows)
        after = next((m for m in reversed(marks) if m is not None), before)
        state = json.dumps({"start": encode(q.start), "watermark": encode(after)})
        try:
            self.sink.put_many(samples, state=(self._key(q), state))
        except BufferError as e:
            raise ConnectorError(f"can't store the readings, so {q.name} stays at {before}: {e}") from None
        with self._lock:
            self.rows += len(rows)
            self.samples += len(samples)
            self.unmapped += unmapped
            self.unreadable += unreadable
            if problem:
                self.last_problem = problem
        return full

    def _samples(
        self, q: SqlQuery, col: dict[str, int], rows: list[Sequence[Any]]
    ) -> tuple[list[Sample], int, int, str]:
        samples: list[Sample] = []
        unreadable = unmapped = 0
        problem = ""
        for row in rows:
            if row[col[q.watermark]] is None:
                unreadable += 1
                problem = f"{q.name}: a row without {q.watermark}"
                continue
            try:
                at = moment(row[col[q.time]], self.config.timezone)
            except ValueError as e:
                unreadable += 1
                problem = f"{q.name}: {e}"
                continue
            if q.signal_column and q.value_column:
                pairs = [(q.signals.get(str(row[col[q.signal_column]])), row[col[q.value_column]])]
                if pairs[0][0] is None:
                    unmapped += 1
                    continue
            else:
                pairs = [(signal, row[col[column]]) for column, signal in q.columns.items()]
            for signal, raw in pairs:
                try:
                    value = reading(raw)
                except ValueError as e:
                    unreadable += 1
                    problem = f"{q.name} {signal}: {e}"
                    continue
                if value is not None and signal is not None:
                    samples.append(Sample(signal, at, value, "good"))
        return samples, unreadable, unmapped, problem

    def _run(self) -> None:
        conn: Any = None
        failures = 0
        while not self._stop.is_set():
            if conn is None:
                try:
                    conn = connect(self.config)
                except Exception as e:
                    failures += 1
                    self._set("down", f"can't connect to {self.config.source}: {explain(e)}")
                    delay = min(2.0 ** min(failures - 1, 10), self.max_retry_seconds)
                    self._stop.wait(delay)
                    continue
                failures = 0
            more = False
            problems: dict[str, str] = {}
            for q in self.config.queries:
                if self._stop.is_set():
                    break
                try:
                    more = self.poll(conn, q) or more
                except Exception as e:
                    problems[q.name] = explain(e)
                    if not isinstance(e, ConnectorError) and not _alive(conn):
                        _close(conn)
                        conn = None
                        break
            if not problems:
                self._set("ok", f"polling {self.config.source} every {self.config.poll_seconds} s")
            else:
                some = len(problems) < len(self.config.queries) and conn is not None
                state: Status = "degraded" if some else "down"
                self._set(state, "; ".join(f"{name}: {why}" for name, why in problems.items()))
            if not (more and not problems):
                self._stop.wait(self.config.poll_seconds if conn else 1)
        if conn is not None:
            _close(conn)

    def try_once(self) -> tuple[Status, str]:
        """For `tiles-edge check`: connects, runs each query once and checks its columns."""
        try:
            conn = connect(self.config)
        except Exception as e:
            return "down", f"can't connect to {self.config.source}: {explain(e)}"
        try:
            self.check(conn)
        except Exception as e:
            return "down", explain(e)
        finally:
            _close(conn)
        return "ok", f"connected to {self.config.source}; {len(self.config.queries)} queries checked"


def _alive(conn: Any) -> bool:
    try:
        conn.rollback()
    except Exception:
        return False
    return True


def _close(conn: Any) -> None:
    try:
        conn.close()
    except Exception as e:  # already gone
        log.debug("closing the connection failed", extra={"error": str(e)})
