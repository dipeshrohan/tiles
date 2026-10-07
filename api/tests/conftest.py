import os
import uuid
from collections.abc import Iterator
from urllib.parse import urlsplit

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql

from tiles_api.db import upgrade
from tiles_api.main import create_app
from tiles_api.settings import Settings


@pytest.fixture
def settings() -> Settings:
    return Settings(env="test", log_level="INFO", cors_origins=["http://localhost:5173"])


@pytest.fixture
def client(settings: Settings) -> TestClient:
    return TestClient(create_app(settings))


@pytest.fixture(scope="module")
def database_url() -> Iterator[str]:
    """A fresh, fully migrated database, dropped after the module's tests.

    Needs TILES_TEST_DATABASE_URL pointing at a Postgres + TimescaleDB server
    whose user may create databases (e.g. the Docker Compose `db` service).
    Without it these tests are skipped locally but fail in CI.
    """
    admin_url = os.environ.get("TILES_TEST_DATABASE_URL")
    if not admin_url:
        if os.environ.get("CI"):
            pytest.fail("TILES_TEST_DATABASE_URL must be set in CI")
        pytest.skip("set TILES_TEST_DATABASE_URL to run database tests")
    name = f"tiles_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = urlsplit(admin_url)._replace(path=f"/{name}").geturl()
    try:
        upgrade(Settings(database_url=url))
        yield url
    finally:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
