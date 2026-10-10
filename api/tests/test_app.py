import json
import logging
from collections.abc import Iterator

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

from tiles_api import sealed
from tiles_api.logging import JsonFormatter, new_request_id, request_id_var
from tiles_api.main import VERSION, create_app
from tiles_api.settings import Settings

PRODUCTION_KEYS = sealed.new_key("test")  # production needs data keys (T5.06)


def test_health_reports_status_version_and_env(client: TestClient) -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "version": VERSION, "env": "test"}


def test_every_response_carries_a_request_id(client: TestClient) -> None:
    res = client.get("/health")
    assert len(res.headers["x-request-id"]) == 32


def test_safe_incoming_request_id_is_echoed(client: TestClient) -> None:
    res = client.get("/health", headers={"X-Request-ID": "trace-abc_123"})
    assert res.headers["x-request-id"] == "trace-abc_123"


@pytest.mark.parametrize("bad", ["has space", "x" * 65, "line\nbreak", '"quoted"', ""])
def test_unsafe_request_ids_are_replaced(bad: str) -> None:
    assert new_request_id(bad) != bad
    assert len(new_request_id(bad)) == 32


def test_unknown_route_is_404_with_request_id(client: TestClient) -> None:
    res = client.get("/nope")
    assert res.status_code == 404
    assert res.headers["x-request-id"]


def test_requests_are_logged_as_json(client: TestClient, capsys: pytest.CaptureFixture[str]) -> None:
    client.get("/health", headers={"X-Request-ID": "log-check"})
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]
    entry = next(e for e in lines if e.get("message") == "request")
    assert entry["request_id"] == "log-check"
    assert entry["method"] == "GET"
    assert entry["path"] == "/health"
    assert entry["status"] == 200
    assert entry["level"] == "INFO"
    assert isinstance(entry["duration_ms"], float)


def test_json_formatter_includes_extra_fields_and_context_request_id() -> None:
    record = logging.LogRecord("tiles_api", logging.WARNING, __file__, 1, "hello %s", ("world",), None)
    record.machine = "DC-02"
    token = request_id_var.set("ctx-1")
    try:
        entry = json.loads(JsonFormatter().format(record))
    finally:
        request_id_var.reset(token)
    assert entry["message"] == "hello world"
    assert entry["level"] == "WARNING"
    assert entry["machine"] == "DC-02"
    assert entry["request_id"] == "ctx-1"


def test_json_formatter_drops_terminal_colour_copies() -> None:
    record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, "Started", (), None)
    record.color_message = "\x1b[36mStarted\x1b[0m"
    entry = json.loads(JsonFormatter().format(record))
    assert "color_message" not in entry


def test_settings_read_tiles_environment_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TILES_ENV", "production")
    monkeypatch.setenv("TILES_DATA_KEYS", PRODUCTION_KEYS)
    monkeypatch.setenv("TILES_PORT", "9001")
    monkeypatch.setenv("TILES_CORS_ORIGINS", '["https://tiles.example.com"]')
    s = Settings(_env_file=None)
    assert s.env == "production"
    assert s.port == 9001
    assert s.cors_origins == ["https://tiles.example.com"]


def test_settings_reject_unknown_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TILES_ENV", "staging")
    with pytest.raises(ValueError, match="env"):
        Settings(_env_file=None)


def test_cors_allows_configured_origin_only(client: TestClient) -> None:
    ok = client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert ok.headers["access-control-allow-origin"] == "http://localhost:5173"
    other = client.get("/health", headers={"Origin": "https://evil.example.com"})
    assert "access-control-allow-origin" not in other.headers


def test_unhandled_error_is_500_with_request_id_cors_and_log(
    settings: Settings, capsys: pytest.CaptureFixture[str]
) -> None:
    app = create_app(settings)

    @app.get("/boom")
    def boom() -> None:
        raise RuntimeError("kaput")

    res = TestClient(app).get("/boom", headers={"X-Request-ID": "err-1", "Origin": "http://localhost:5173"})
    assert res.status_code == 500
    assert res.json() == {"detail": "Internal Server Error"}
    assert res.headers["x-request-id"] == "err-1"
    assert res.headers["access-control-allow-origin"] == "http://localhost:5173"
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]
    failed = next(e for e in lines if e.get("message") == "request failed")
    assert failed["request_id"] == "err-1"
    assert "RuntimeError: kaput" in failed["exception"]
    done = next(e for e in lines if e.get("message") == "request")
    assert done["status"] == 500
    assert done["request_id"] == "err-1"


def test_responses_carry_security_headers(client: TestClient) -> None:
    res = client.get("/health")
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["referrer-policy"] == "no-referrer"
    assert res.headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"
    # The interactive docs load their own scripts: no policy of ours on them.
    assert "content-security-policy" not in client.get("/docs").headers


def test_request_bodies_are_capped() -> None:
    app = create_app(Settings(_env_file=None, env="test", max_body_bytes=1024 * 1024))

    @app.post("/echo")
    async def echo(request: Request) -> dict[str, int]:
        return {"bytes": len(await request.body())}

    with TestClient(app) as c:
        assert c.post("/echo", content=b"x" * 1000).json() == {"bytes": 1000}
        big = c.post("/echo", content=b"x" * (1024 * 1024 + 1))
        assert (big.status_code, big.json()["detail"]) == (413, "The request is larger than 1 MB")

        def chunks() -> Iterator[bytes]:  # sent without a Content-Length
            for _ in range(5):
                yield b"x" * (300 * 1024)

        streamed = c.post("/echo", content=chunks())
        assert (streamed.status_code, streamed.json()["detail"]) == (413, "The request is larger than 1 MB")
        bad = c.post("/echo", content=b"x", headers={"Content-Length": "lots"})
        assert bad.status_code == 400


def test_without_a_token_is_the_dev_user_only_where_nothing_else_signs_in() -> None:
    issuer = "https://idp.example.com/realms/tiles"
    assert Settings(_env_file=None, env="development").dev_identity_on
    assert not Settings(_env_file=None, env="development", oidc_issuer=issuer).dev_identity_on  # fail closed
    assert Settings(_env_file=None, env="development", oidc_issuer=issuer, dev_identity=True).dev_identity_on
    assert not Settings(_env_file=None, env="test", dev_identity=False).dev_identity_on
    production = Settings(_env_file=None, env="production", data_keys=PRODUCTION_KEYS, oidc_issuer=issuer)
    assert not production.dev_identity_on
    with pytest.raises(ValueError, match="TILES_DEV_IDENTITY can't be set in production"):
        Settings(_env_file=None, env="production", data_keys=PRODUCTION_KEYS, dev_identity=True)
    with TestClient(create_app(Settings(_env_file=None, env="development", oidc_issuer=issuer))) as c:
        res = c.get("/me", headers={"X-Tiles-User": "eng@example.com"})
        assert (res.status_code, res.json()["detail"]) == (401, "Sign in to use Tiles")
