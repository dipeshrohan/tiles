"""Credentials sealed in the database (T5.06): data keys, sealing bound to what a value is,
rotation, the Teams webhook URL stored sealed, and secrets read from files."""

import base64
import os
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from pydantic import ValidationError
from test_agents import ADMIN, api, site  # noqa: F401 - api and site are fixtures
from test_notifications import FakeSender, recent_warning

from tiles_api import sealed
from tiles_api.notify import send_due
from tiles_api.settings import Settings, get_settings
from tiles_api.store import UNSCOPED

K1 = sealed.new_key("k1")
K2 = sealed.new_key("k2")
URL = "https://example.webhook.office.com/webhookb2/abc"


def test_a_value_opens_only_where_it_was_sealed() -> None:
    keys = sealed.DataKeys.parse(K1)
    assert keys is not None
    value = keys.seal("secret", "teams:a")
    assert value.startswith("tiles:v1:k1:") and "secret" not in value
    assert value != keys.seal("secret", "teams:a")  # a fresh nonce each time
    assert keys.unseal(value, "teams:a") == "secret"
    with pytest.raises(sealed.SealError, match="doesn't open here"):
        keys.unseal(value, "teams:b")  # copied to another row
    tampered = value[:-4] + ("AAAA" if not value.endswith("AAAA") else "BBBB")
    with pytest.raises(sealed.SealError):
        keys.unseal(tampered, "teams:a")
    assert keys.unseal("https://plain", "teams:a") == "https://plain"  # stored before keys were set
    # Without keys, sealed values can't be read, and nothing is sealed.
    with pytest.raises(sealed.SealError, match="TILES_DATA_KEYS isn't set"):
        sealed.unseal(None, value, "teams:a")
    assert sealed.seal(None, "x", "c") == "x"


def test_keys_rotate() -> None:
    old = sealed.DataKeys.parse(K1)
    both = sealed.DataKeys.parse(f"{K2},{K1}")  # the new one first: it seals
    assert old is not None and both is not None
    value = old.seal("secret", "c")
    assert both.unseal(value, "c") == "secret"
    assert both.needs_resealing(value) and both.needs_resealing("https://plain")
    resealed = both.seal(both.unseal(value, "c"), "c")
    assert resealed.startswith("tiles:v1:k2:") and not both.needs_resealing(resealed)
    only_new = sealed.DataKeys.parse(K2)
    assert only_new is not None
    with pytest.raises(sealed.SealError, match="key k1, which isn't set"):
        only_new.unseal(value, "c")


@pytest.mark.parametrize(
    ("spec", "reason"),
    [
        ("bad id!:" + base64.b64encode(os.urandom(32)).decode(), "id"),
        ("k1:not base64!", "base64"),
        ("k1:" + base64.b64encode(os.urandom(16)).decode(), "32 bytes"),
        (f"{K1},{K1}", "twice"),
    ],
)
def test_malformed_keys_are_refused(spec: str, reason: str) -> None:
    with pytest.raises(sealed.SealError, match=reason):
        sealed.DataKeys.parse(spec)
    with pytest.raises(ValidationError):  # and the settings won't load with them
        Settings(_env_file=None, data_keys=spec)


def test_production_needs_data_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValidationError, match="Set TILES_DATA_KEYS in production"):
        Settings(_env_file=None, env="production")
    assert Settings(_env_file=None, env="production", data_keys=K1).data_keys is not None


def test_secrets_are_read_from_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "tiles_data_keys").write_text(K1 + "\n")
    (tmp_path / "TILES_SMTP_PASSWORD").write_text("hunter2")
    monkeypatch.setenv("TILES_SECRETS_DIR", str(tmp_path))
    get_settings.cache_clear()
    try:
        s = get_settings()
        assert s.data_keys is not None and s.data_keys.get_secret_value() == K1
        assert s.smtp_password is not None and s.smtp_password.get_secret_value() == "hunter2"
        assert "hunter2" not in repr(s)
    finally:
        get_settings.cache_clear()


def test_the_teams_webhook_is_stored_sealed_and_still_sent(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = api.app.state.settings  # type: ignore[attr-defined]
    monkeypatch.setattr(settings, "data_keys", Settings(_env_file=None, data_keys=K1).data_keys)
    res = api.put(f"/sites/{site}/notifications/teams", json={"webhook_url": URL}, headers=ADMIN)
    assert res.status_code == 200, res.text
    assert res.json()["host"] == "example.webhook.office.com"
    with psycopg.connect(database_url) as conn:
        [(stored,)] = conn.execute("SELECT teams_webhook_url FROM site_notifications WHERE site_id = %s", [site])
    assert stored.startswith("tiles:v1:k1:") and "office.com" not in stored
    assert api.get(f"/sites/{site}/notifications/teams", headers=ADMIN).json()["host"] == "example.webhook.office.com"
    # Changing only whether new warnings are posted keeps the URL as it is stored.
    api.put(f"/sites/{site}/notifications/teams", json={"on_raised": False}, headers=ADMIN)
    with psycopg.connect(database_url) as conn:
        [(kept,)] = conn.execute("SELECT teams_webhook_url FROM site_notifications WHERE site_id = %s", [site])
    assert kept == stored

    # Rotation: a new key first, everything resealed, then the old key can go.
    keys = sealed.DataKeys.parse(f"{K2},{K1}")
    assert keys is not None
    with psycopg.connect(database_url, row_factory=psycopg.rows.dict_row) as conn:
        assert sealed.reseal(conn, keys) == 1
        assert sealed.reseal(conn, keys) == 0  # nothing left to do
        [rotated] = conn.execute("SELECT teams_webhook_url AS v FROM site_notifications WHERE site_id = %s", [site])
    assert rotated["v"].startswith("tiles:v1:k2:")
    monkeypatch.setattr(settings, "data_keys", Settings(_env_file=None, data_keys=K2).data_keys)
    assert api.get(f"/sites/{site}/notifications/teams", headers=ADMIN).json()["host"] == "example.webhook.office.com"


def test_a_sealed_webhook_is_opened_to_send(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = api.app.state.settings  # type: ignore[attr-defined]
    monkeypatch.setattr(settings, "data_keys", Settings(_env_file=None, data_keys=K1).data_keys)
    api.put(f"/sites/{site}/notifications/teams", json={"webhook_url": URL}, headers=ADMIN)
    recent_warning(api, site)  # queues a message for the Teams channel
    with psycopg.connect(database_url, row_factory=dict_row, autocommit=True, options=UNSCOPED) as conn:
        # Without the key, it can't be opened: kept and retried, saying why (never sent elsewhere).
        lost = FakeSender()
        assert send_due(conn, lost, "https://tiles.example.com", keys=None).failed == 1
        [why] = conn.execute("SELECT last_error FROM notifications WHERE channel = 'teams'").fetchall()
        assert "TILES_DATA_KEYS isn't set" in why["last_error"]
        conn.execute("UPDATE notifications SET next_at = now()")
        sender = FakeSender()
        assert send_due(conn, sender, "https://tiles.example.com", keys=sealed.DataKeys.parse(K1)).sent == 1
    assert [url for url, _ in sender.posts] == [URL] and lost.posts == []
