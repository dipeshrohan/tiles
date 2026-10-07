import psycopg
import pytest
from fastapi.testclient import TestClient

from tiles_api import readiness
from tiles_api.settings import Settings


def _ok(_settings: Settings) -> None:
    return None


def _down(_settings: Settings) -> None:
    raise ConnectionRefusedError("postgresql://tiles:secret@db:5432 refused")


def test_ready_is_ok_when_all_checks_pass(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(readiness, "CHECKS", {"database": _ok, "redis": _ok})
    res = client.get("/ready")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "checks": {"database": "ok", "redis": "ok"}}


def test_ready_is_503_when_a_dependency_is_down(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(readiness, "CHECKS", {"database": _down, "redis": _ok})
    res = client.get("/ready")
    assert res.status_code == 503
    assert res.json() == {"status": "unavailable", "checks": {"database": "unavailable", "redis": "ok"}}


def test_ready_never_leaks_connection_details(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(readiness, "CHECKS", {"database": _down})
    assert "secret" not in client.get("/ready").text


def test_real_checks_report_unavailable_for_unreachable_services() -> None:
    # Nothing listens on port 1; both checks must fail fast and cleanly.
    s = Settings(
        _env_file=None,
        database_url="postgresql://tiles:x@127.0.0.1:1/tiles",
        redis_url="redis://127.0.0.1:1/0",
        ready_timeout=1,
    )
    assert readiness.run_checks(s) == {"database": "unavailable", "redis": "unavailable"}


def test_health_does_not_depend_on_services(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(readiness, "CHECKS", {"database": _down, "redis": _down})
    assert client.get("/health").status_code == 200


def test_database_check_bounds_both_connect_and_query(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    class FakeConn:
        def __enter__(self) -> "FakeConn":
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def execute(self, query: str) -> None:
            seen["query"] = query

    def fake_connect(url: str, **kwargs: object) -> FakeConn:
        seen.update(kwargs)
        return FakeConn()

    monkeypatch.setattr(psycopg, "connect", fake_connect)
    readiness.check_database(Settings(_env_file=None, ready_timeout=1.5))
    assert seen == {"connect_timeout": 2, "options": "-c statement_timeout=1500", "query": "SELECT 1"}
