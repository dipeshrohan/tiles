"""Real PostgreSQL and SQL Server databases for the SQL connector tests, in Docker, with TLS.

Each server gets a certificate for `localhost` from a test CA. The tests are
skipped when Docker isn't available, except in CI (TILES_EDGE_TEST_DOCKER=1),
where they must run.
"""

import os
import shutil
import socket
import subprocess
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

POSTGRES_IMAGE = "postgres:17"
SQLSERVER_IMAGE = "mcr.microsoft.com/mssql/server:2022-latest"
ADMIN_PASSWORD = "Tiles-test-1"
READER_PASSWORD = "Reader-test-1"


def _openssl(*args: str) -> None:
    subprocess.run(["openssl", *args], check=True, capture_output=True)  # noqa: S603, S607 - fixed arguments


def make_ca(folder: Path, name: str = "ca") -> tuple[Path, Path]:
    cert, key = folder / f"{name}.pem", folder / f"{name}.key"
    _openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", f"/CN=Tiles test {name}",
             "-keyout", str(key), "-out", str(cert))  # fmt: skip
    return cert, key


def make_server_cert(folder: Path, ca: tuple[Path, Path]) -> tuple[Path, Path]:
    """For DNS:localhost only, so connecting to 127.0.0.1 fails the host name check."""
    cert, key, csr, ext = folder / "server.pem", folder / "server.key", folder / "server.csr", folder / "server.ext"
    _openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", str(key), "-out", str(csr))
    ext.write_text(
        "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n"
    )
    _openssl("x509", "-req", "-in", str(csr), "-CA", str(ca[0]), "-CAkey", str(ca[1]), "-CAcreateserial",
             "-days", "2", "-out", str(cert), "-extfile", str(ext))  # fmt: skip
    for f in (cert, key):
        f.chmod(0o644)  # read inside the container by its own user
    return cert, key


def docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "info"], capture_output=True, check=False).returncode == 0  # noqa: S607


def need_docker() -> None:
    if docker_available():
        return
    if os.environ.get("TILES_EDGE_TEST_DOCKER"):
        pytest.fail("TILES_EDGE_TEST_DOCKER is set, but Docker isn't usable")
    pytest.skip("Docker isn't available (set TILES_EDGE_TEST_DOCKER=1 to require these tests)")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
        return port


@dataclass
class Server:
    engine: str
    port: int
    ca: Path
    run: Callable[[str], None]  # runs SQL as the admin, in the test database


@contextmanager
def container(name: str, args: list[str]) -> Iterator[None]:
    subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)  # noqa: S603, S607
    subprocess.run(["docker", "run", "-d", "--name", name, *args], check=True, capture_output=True)  # noqa: S603, S607
    try:
        yield
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)  # noqa: S603, S607


def wait_for(connect: Callable[[], Any], what: str, seconds: float = 120) -> Any:
    deadline = time.monotonic() + seconds
    while True:
        try:
            return connect()
        except Exception as e:
            if time.monotonic() > deadline:
                raise AssertionError(f"{what} didn't come up: {e}") from None
            time.sleep(1)


@contextmanager
def postgres(folder: Path) -> Iterator[Server]:
    import psycopg

    ca = make_ca(folder)
    make_server_cert(folder, ca)
    port = free_port()
    # The key must belong to the server's user, so it is copied in before the server starts.
    start = (
        "cp /certs/server.pem /certs/server.key /tmp/ && chown postgres /tmp/server.key && chmod 600 /tmp/server.key"
        " && exec docker-entrypoint.sh postgres -c ssl=on"
        " -c ssl_cert_file=/tmp/server.pem -c ssl_key_file=/tmp/server.key"
    )
    with container(
        "tiles-edge-test-postgres",
        ["-e", f"POSTGRES_PASSWORD={ADMIN_PASSWORD}", "-e", "POSTGRES_DB=mes", "-p", f"127.0.0.1:{port}:5432",
         "-v", f"{folder}:/certs:ro", "--entrypoint", "bash", POSTGRES_IMAGE, "-c", start],
    ):  # fmt: skip

        def admin() -> Any:
            return psycopg.connect(
                host="localhost", port=port, dbname="mes", user="postgres", password=ADMIN_PASSWORD,
                sslmode="verify-full", sslrootcert=str(ca[0]), autocommit=True, connect_timeout=5,
            )  # fmt: skip

        wait_for(lambda: admin().close(), "PostgreSQL")

        def run(sql: str) -> None:
            with admin() as conn:
                conn.execute(sql)

        run(f"CREATE USER tiles_reader PASSWORD '{READER_PASSWORD}'")
        run("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO tiles_reader")
        yield Server("postgresql", port, ca[0], run)


@contextmanager
def sqlserver(folder: Path) -> Iterator[Server]:
    """The ODBC driver trusts the system's CAs: the caller points SSL_CERT_FILE at `Server.ca`."""
    import mssql_python

    ca = make_ca(folder)
    make_server_cert(folder, ca)
    (folder / "mssql.conf").write_text(
        "[network]\ntlscert = /certs/server.pem\ntlskey = /certs/server.key\ntlsprotocols = 1.2\nforceencryption = 1\n"
    )
    (folder / "mssql.conf").chmod(0o644)
    folder.chmod(0o755)  # SQL Server runs as its own user, which must read the mounted files
    port = free_port()
    with container(
        "tiles-edge-test-sqlserver",
        ["-e", "ACCEPT_EULA=Y", "-e", f"MSSQL_SA_PASSWORD={ADMIN_PASSWORD}", "-p", f"127.0.0.1:{port}:1433",
         "-v", f"{folder}:/certs:ro", "-v", f"{folder}/mssql.conf:/var/opt/mssql/mssql.conf:ro", SQLSERVER_IMAGE],
    ):  # fmt: skip

        def admin(database: str = "mes") -> Any:
            return mssql_python.connect(
                f"Server=tcp:localhost,{port};Database={database};UID=sa;PWD={ADMIN_PASSWORD};"
                "Encrypt=yes;TrustServerCertificate=no",
                autocommit=True,
            )

        wait_for(lambda: admin("master").close(), "SQL Server")

        def run_in(database: str, sql: str) -> None:
            conn = admin(database)
            try:
                conn.cursor().execute(sql)
            finally:
                conn.close()

        run_in("master", "CREATE DATABASE mes")
        run_in("master", f"CREATE LOGIN tiles_reader WITH PASSWORD = '{READER_PASSWORD}'")
        run_in("mes", "CREATE USER tiles_reader FOR LOGIN tiles_reader")
        run_in("mes", "ALTER ROLE db_datareader ADD MEMBER tiles_reader")
        yield Server("sqlserver", port, ca[0], lambda sql: run_in("mes", sql))
