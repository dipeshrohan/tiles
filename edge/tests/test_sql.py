"""The SQL connector (T2.05) against SQLite, and real PostgreSQL and SQL Server databases over TLS."""

import itertools
import json
import os
import sqlite3
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
import sql_servers
from conftest import write_config

from tiles_edge.buffer import DiskBuffer
from tiles_edge.config import SqlConfig, load
from tiles_edge.samples import MemoryBuffer
from tiles_edge.sql import ConnectorError, SqlConnector, connect

TIMESTAMP = {"sqlite": "TEXT", "postgresql": "TIMESTAMP", "sqlserver": "DATETIME2"}
_tables = itertools.count()


@dataclass
class Db:
    engine: str
    run: Callable[[str], None]  # SQL as the admin
    connection: str  # the [[sql]] settings that reach it as the read-only user
    table: str  # a fresh table name for this test

    @property
    def ts(self) -> str:
        return TIMESTAMP[self.engine]


@pytest.fixture(scope="module")
def postgresql(tmp_path_factory: pytest.TempPathFactory) -> Iterator[sql_servers.Server]:
    sql_servers.need_docker()
    with sql_servers.postgres(tmp_path_factory.mktemp("postgres")) as server:
        yield server


@pytest.fixture(scope="module")
def sqlserver(tmp_path_factory: pytest.TempPathFactory) -> Iterator[sql_servers.Server]:
    sql_servers.need_docker()
    folder = tmp_path_factory.mktemp("sqlserver")
    with pytest.MonkeyPatch.context() as env:
        # The ODBC driver trusts the system's CAs; for the test, that is the test CA.
        env.setenv("SSL_CERT_FILE", str(folder / "ca.pem"))
        with sql_servers.sqlserver(folder) as server:
            yield server


def _network(server: sql_servers.Server, folder: Path, ca: bool) -> str:
    password = folder / "password"
    password.write_text(sql_servers.READER_PASSWORD + "\n")
    lines = [
        f'engine = "{server.engine}"',
        f'host = "{server.host}"',
        f"port = {server.port}",
        'database = "mes"',
        'username = "tiles_reader"',
        f'password_file = "{password}"',
    ]
    if ca:
        lines.append(f'ca_file = "{server.ca}"')
    return "\n".join(lines)


@pytest.fixture(params=["sqlite", "postgresql", "sqlserver"])
def db(request: pytest.FixtureRequest, tmp_path: Path) -> Db:
    if request.param == "sqlite":
        db = sqlite_db(tmp_path)
        db.run("SELECT 1")  # creates the file
        return db
    server: sql_servers.Server = request.getfixturevalue(request.param)
    return Db(
        server.engine, server.run, _network(server, tmp_path, ca=server.engine == "postgresql"), f"t{next(_tables)}"
    )


def sql_config(db: Db, tmp_path: Path, queries: str, extra: str = "") -> SqlConfig:
    section = f'[[sql]]\nname = "mes"\ntimezone = "Europe/Berlin"\n{db.connection}\n{extra}\n{queries}'
    return load(write_config(tmp_path, "https://tiles.example.com", section), env={}).sql[0]


def quality_table(db: Db, rows: list[tuple[int, str, float, str]]) -> None:
    db.run(
        f"CREATE TABLE {db.table} (id INTEGER PRIMARY KEY, measured_at {db.ts}, temperature FLOAT, line VARCHAR(20))"
    )
    insert(db, rows)


def insert(db: Db, rows: list[tuple[int, str, float, str]]) -> None:
    if not rows:
        return
    values = ", ".join(f"({i}, '{at}', {t}, '{line}')" for i, at, t, line in rows)
    db.run(f"INSERT INTO {db.table} (id, measured_at, temperature, line) VALUES {values}")


def wide(db: Db, watermark: str = "id", order: str = "id", where: str = "") -> str:
    return f"""
[[sql.queries]]
name = "quality"
query = '''
SELECT id, measured_at, temperature, line FROM {db.table}
WHERE {watermark} > :watermark {where} ORDER BY {order}'''
watermark = "{watermark}"
start = {"0" if watermark == "id" else "2026-01-01T00:00:00"}
time = "measured_at"
columns = {{ temperature = "line1.temperature", line = "line1.name" }}
"""


def poll_all(connector: SqlConnector) -> None:
    conn = connect(connector.config)
    try:
        for _ in range(100):
            if not any([connector.poll(conn, q) for q in connector.config.queries]):
                return
        raise AssertionError("polling never caught up")
    finally:
        conn.close()


def at(hour: int, minute: int = 0) -> str:
    return f"2026-10-07 {hour:02}:{minute:02}:00"


def test_new_rows_become_samples_and_the_position_survives_a_restart(db: Db, tmp_path: Path) -> None:
    quality_table(db, [(1, at(10), 20.5, "L1"), (2, at(10, 1), 21.0, "L1")])
    config = sql_config(db, tmp_path, wide(db))
    buffer = DiskBuffer(tmp_path / "buffer.sqlite")
    try:
        poll_all(SqlConnector(config, buffer))
        got = [(q.sample.signal, q.sample.at, q.sample.value) for q in buffer.oldest(100)]
        # Stored without a time zone, so in the connector's (Berlin: UTC+2 in October)
        berlin = datetime(2026, 10, 7, 8, 0, tzinfo=UTC)
        assert got == [
            ("line1.temperature", berlin, 20.5),
            ("line1.name", berlin, "L1"),
            ("line1.temperature", berlin + timedelta(minutes=1), 21.0),
            ("line1.name", berlin + timedelta(minutes=1), "L1"),
        ]
    finally:
        buffer.close()

    insert(db, [(3, at(10, 2), 22.0, "L1")])
    buffer = DiskBuffer(tmp_path / "buffer.sqlite")  # the agent restarted
    try:
        connector = SqlConnector(config, buffer)
        poll_all(connector)
        assert len(buffer) == 6  # only the new row was read
        assert connector.rows == 1
        poll_all(connector)
        assert len(buffer) == 6
    finally:
        buffer.close()


def test_rows_of_readings_map_by_signal(db: Db, tmp_path: Path) -> None:
    db.run(f"CREATE TABLE {db.table} (seq INTEGER PRIMARY KEY, at {db.ts}, tag VARCHAR(20), val FLOAT)")
    db.run(
        f"INSERT INTO {db.table} VALUES (1, '{at(9)}', 'TT-101', 20.5), (2, '{at(9)}', 'PT-7', 3.5),"
        f" (3, '{at(9)}', 'XX-999', 1), (4, '{at(9, 1)}', 'TT-101', NULL)"
    )
    queries = f"""
[[sql.queries]]
name = "historian"
query = "SELECT seq, at, tag, val FROM {db.table} WHERE seq > :watermark ORDER BY seq"
watermark = "SEQ"  # column names match whatever their case
start = 0
time = "at"
signal_column = "tag"
value_column = "val"
signals = {{ "TT-101" = "press1.temperature", "PT-7" = "press1.pressure" }}
"""
    buffer = MemoryBuffer()
    connector = SqlConnector(sql_config(db, tmp_path, queries), buffer)
    poll_all(connector)
    assert [(s.signal, s.value) for s in buffer.take()] == [("press1.temperature", 20.5), ("press1.pressure", 3.5)]
    assert (connector.rows, connector.unmapped) == (4, 1)  # XX-999 isn't mapped; the NULL is no reading
    assert "1 rows of unmapped signals" in connector.status()["detail"]


def test_big_backlogs_go_in_batches_without_losing_rows_that_share_a_time(db: Db, tmp_path: Path) -> None:
    # 25 rows; rows 8 to 12 share one time, across the first batch's end (max_rows = 10)
    times = [at(10, i) for i in range(8)] + [at(10, 8)] * 5 + [at(10, i) for i in range(13, 25)]
    quality_table(db, [(i, t, float(i), "L1") for i, t in enumerate(times)])
    config = sql_config(db, tmp_path, wide(db, watermark="measured_at", order="measured_at, id"), "max_rows = 10")
    buffer = MemoryBuffer()
    connector = SqlConnector(config, buffer)
    poll_all(connector)
    temperatures = [s.value for s in buffer.take() if s.signal == "line1.temperature"]
    assert temperatures == [float(i) for i in range(25)]  # each row once, in order


def test_a_time_more_precise_than_python_is_read_once(sqlserver: sql_servers.Server, tmp_path: Path) -> None:
    # DATETIME2 keeps 100 ns; Python's datetime keeps 1 µs.
    db = Db("sqlserver", sqlserver.run, _network(sqlserver, tmp_path, ca=False), f"t{next(_tables)}")
    quality_table(db, [(1, "2026-10-07 10:00:00.1234567", 20.5, "L1")])
    buffer = MemoryBuffer()
    connector = SqlConnector(sql_config(db, tmp_path, wide(db, watermark="measured_at", order="measured_at")), buffer)
    poll_all(connector)
    poll_all(connector)
    assert (connector.rows, len(buffer)) == (1, 2)


def test_more_rows_with_one_time_than_a_batch_holds_is_explained(tmp_path: Path) -> None:
    db = sqlite_db(tmp_path)
    quality_table(db, [(i, at(10), float(i), "L1") for i in range(12)])
    config = sql_config(db, tmp_path, wide(db, watermark="measured_at", order="measured_at"), "max_rows = 10")
    with pytest.raises(ConnectorError, match=r"more than max_rows \(10\) rows have measured_at = .*raise max_rows"):
        poll_all(SqlConnector(config, MemoryBuffer()))


def test_rows_out_of_watermark_order_are_refused(tmp_path: Path) -> None:
    db = sqlite_db(tmp_path)
    quality_table(db, [(1, at(10), 1.0, "L1"), (2, at(11), 2.0, "L1")])
    buffer = MemoryBuffer()
    connector = SqlConnector(sql_config(db, tmp_path, wide(db, order="id DESC")), buffer)
    with pytest.raises(ConnectorError, match="rows aren't in id order; add ORDER BY id"):
        poll_all(connector)
    assert len(buffer) == 0 and connector.position(connector.config.queries[0]) == 0


def test_changing_start_reads_again_from_there(tmp_path: Path) -> None:
    db = sqlite_db(tmp_path)
    quality_table(db, [(1, at(10), 1.0, "L1"), (2, at(11), 2.0, "L1")])
    buffer = DiskBuffer(tmp_path / "buffer.sqlite")
    try:
        poll_all(SqlConnector(sql_config(db, tmp_path, wide(db)), buffer))
        assert len(buffer) == 4
        again = SqlConnector(sql_config(db, tmp_path, wide(db).replace("start = 0", "start = 1")), buffer)
        poll_all(again)
        assert again.rows == 1  # row 2 again; Tiles keeps one copy per signal and time
    finally:
        buffer.close()


def test_a_reading_that_cant_be_stored_keeps_the_position(tmp_path: Path) -> None:
    db = sqlite_db(tmp_path)
    quality_table(db, [(i, f"2026-10-07 10:00:{i / 100:09.6f}", float(i), "L1") for i in range(1, 3001)])
    buffer = DiskBuffer(tmp_path / "buffer.sqlite")
    try:
        pages = buffer._db.execute("PRAGMA page_count").fetchone()[0]
        buffer._db.execute(f"PRAGMA max_page_count = {pages}")  # the disk is full
        connector = SqlConnector(sql_config(db, tmp_path, wide(db)), buffer)
        with pytest.raises(ConnectorError, match="can't store the readings, so quality stays at 0"):
            poll_all(connector)
        buffer._db.execute("PRAGMA max_page_count = 1000000")
        poll_all(connector)  # nothing was skipped
        assert len(buffer) == 6000
    finally:
        buffer.close()


def test_values_that_arent_readings_are_counted(tmp_path: Path) -> None:
    db = sqlite_db(tmp_path)
    quality_table(db, [(1, at(10), 1.0, "L1")])
    db.run(f"INSERT INTO {db.table} VALUES (2, 'not a time', 2.0, 'L1'), (3, '{at(11)}', 3.0, X'00ff')")
    buffer = MemoryBuffer()
    connector = SqlConnector(sql_config(db, tmp_path, wide(db)), buffer)
    poll_all(connector)
    assert [s.value for s in buffer.take()] == [1.0, "L1", 3.0]
    assert connector.unreadable == 2
    assert "quality line1.name: a bytes value can't be a reading" in connector.status()["detail"]


def test_the_agent_cannot_write(db: Db, tmp_path: Path) -> None:
    quality_table(db, [(1, at(10), 1.0, "L1")])
    conn = connect(sql_config(db, tmp_path, wide(db)))
    try:
        with pytest.raises(Exception, match=r"(?i)read.?only|permission|denied"):
            conn.cursor().execute(f"DELETE FROM {db.table}")
    finally:
        conn.rollback()
        conn.close()


def sqlite_db(tmp_path: Path) -> Db:
    path = tmp_path / "plant.sqlite"

    def run(sql: str) -> None:
        with sqlite3.connect(path) as conn:
            conn.executescript(sql)
        conn.close()

    return Db("sqlite", run, f'engine = "sqlite"\npath = "{path}"', f"t{next(_tables)}")


def test_postgresql_checks_the_servers_certificate(postgresql: sql_servers.Server, tmp_path: Path) -> None:
    other_ca, _ = sql_servers.make_ca(tmp_path, "other")
    good = _network(postgresql, tmp_path, ca=True)
    db = Db("postgresql", postgresql.run, good, "x")
    for connection, message in (
        (good.replace(str(postgresql.ca), str(other_ca)), "certificate verify failed"),
        (good.replace('host = "localhost"', 'host = "127.0.0.1"'), "does not match host name"),
    ):
        db.connection = connection
        status, detail = SqlConnector(sql_config(db, tmp_path, wide(db)), MemoryBuffer()).try_once()
        assert status == "down" and message in detail, detail


def test_sqlserver_checks_the_servers_certificate(sqlserver: sql_servers.Server, tmp_path: Path) -> None:
    db = Db("sqlserver", sqlserver.run, _network(sqlserver, tmp_path, ca=False), "x")
    path = write_config(tmp_path, "https://tiles.example.com", f'[[sql]]\nname = "mes"\n{db.connection}\n{wide(db)}')
    other_ca, _ = sql_servers.make_ca(tmp_path, "other")
    # The driver's OpenSSL reads its trusted CAs once per process, so this runs in a fresh one.
    script = (
        "import sys; from pathlib import Path; from tiles_edge.config import load;"
        "from tiles_edge.samples import MemoryBuffer;"
        "from tiles_edge.sql import SqlConnector;"
        "print(SqlConnector(load(Path(sys.argv[1]), env={}).sql[0], MemoryBuffer()).try_once())"
    )
    env = {**os.environ, "SSL_CERT_FILE": str(other_ca)}
    result = subprocess.run(  # noqa: S603 - the test's own script
        [sys.executable, "-c", script, str(path)], env=env, capture_output=True, text=True, check=True, timeout=60
    )
    assert "('down'," in result.stdout and "certificate verify failed" in result.stdout, result.stdout


def test_check_reports_a_missing_column(tmp_path: Path) -> None:
    db = sqlite_db(tmp_path)
    quality_table(db, [])
    good = SqlConnector(sql_config(db, tmp_path, wide(db)), MemoryBuffer())
    assert good.try_once() == ("ok", f"connected to {tmp_path / 'plant.sqlite'}; 1 queries checked")
    bad = SqlConnector(
        sql_config(db, tmp_path, wide(db).replace('time = "measured_at"', 'time = "ts"')), MemoryBuffer()
    )
    assert bad.try_once() == (
        "down",
        "query quality: the result has no column ts (it has id, measured_at, temperature, line)",
    )
    nowhere = Db("sqlite", db.run, f'engine = "sqlite"\npath = "{tmp_path / "nope.sqlite"}"', db.table)
    missing = SqlConnector(sql_config(nowhere, tmp_path, wide(db)), MemoryBuffer())
    assert missing.try_once() == (
        "down",
        f"can't connect to {tmp_path / 'nope.sqlite'}: there is no database file at {tmp_path / 'nope.sqlite'}",
    )


def test_the_running_connector_reports_each_query(tmp_path: Path) -> None:
    db = sqlite_db(tmp_path)
    quality_table(db, [(1, at(10), 1.0, "L1")])
    broken = wide(db).replace('name = "quality"', 'name = "broken"').replace('time = "measured_at"', 'time = "ts"')
    broken = broken.replace('"line1.temperature", line = "line1.name"', '"line2.temperature"')
    buffer = MemoryBuffer()
    connector = SqlConnector(sql_config(db, tmp_path, wide(db) + broken, "poll_seconds = 1"), buffer)
    connector.start()
    try:
        wait(lambda: connector.status()["status"] == "degraded")
        status = connector.status()
        assert "broken: query broken: the result has no column ts" in status["detail"]
        assert "1 rows, 2 samples" in status["detail"]
        insert(db, [(2, at(11), 2.0, "L1")])
        wait(lambda: len(buffer) == 4)
    finally:
        connector.stop()
    assert connector._thread is not None and not connector._thread.is_alive()


def wait(condition: Callable[[], Any], seconds: float = 10) -> None:
    deadline = datetime.now(UTC) + timedelta(seconds=seconds)
    while not condition():
        assert datetime.now(UTC) < deadline, "timed out"
        threading.Event().wait(0.05)


def test_the_saved_position_keeps_its_type(tmp_path: Path) -> None:
    db = sqlite_db(tmp_path)
    quality_table(db, [(1, at(10), 1.0, "L1")])
    buffer = DiskBuffer(tmp_path / "buffer.sqlite")
    try:
        poll_all(SqlConnector(sql_config(db, tmp_path, wide(db, watermark="measured_at", order="measured_at")), buffer))
        saved = buffer.state("sql/mes/quality")
        assert saved is not None
        assert json.loads(saved) == {"start": {"datetime": "2026-01-01T00:00:00"}, "watermark": {"text": at(10)}}
    finally:
        buffer.close()


def test_a_slow_query_times_out(postgresql: sql_servers.Server, tmp_path: Path) -> None:
    db = Db("postgresql", postgresql.run, _network(postgresql, tmp_path, ca=True), f"t{next(_tables)}")
    quality_table(db, [(1, at(10), 1.0, "L1")])
    slow = wide(db).replace(f"FROM {db.table}", f"FROM {db.table}, pg_sleep(3)")
    connector = SqlConnector(sql_config(db, tmp_path, slow, "timeout_seconds = 1"), MemoryBuffer())
    status, detail = connector.try_once()
    assert status == "down" and "statement timeout" in detail, detail
