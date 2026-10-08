"""Notifications (T3.09): preferences, the site's Teams channel, the outbox, and sending it."""

import http.server
import smtplib
import threading
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_detectors import FIXTURE, create, import_friction
from test_warnings import ENG2, user_id

from tiles_api import notify
from tiles_api.notify import LiveSender, Message, send_due, teams_url_problem
from tiles_api.settings import Settings

TEAMS = "https://acme.webhook.office.com/webhookb2/abc@def/IncomingWebhook/123/456"


def test_only_teams_webhook_hosts_are_accepted() -> None:
    for good in (
        TEAMS,
        "https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x",
        "https://default123.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc",
    ):
        assert teams_url_problem(good) is None, good
    for bad, why in (
        ("http://acme.webhook.office.com/x", "starts with https://"),
        ("https://user:pw@acme.webhook.office.com/x", "no user name or password"),
        ("https://intranet.example.com/hook", "Not a Microsoft Teams webhook"),
        ("https://acme.webhook.office.com.example.com/x", "Not a Microsoft Teams webhook"),
        ("https://example.com/acme.webhook.office.com", "Not a Microsoft Teams webhook"),
        ("https://[::1/x", "Not a URL"),
    ):
        assert why in (teams_url_problem(bad) or ""), bad


def test_people_choose_their_emails(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    path = f"/sites/{site}/notifications/preferences"
    assert api.get(path, headers=ENG).json() == {"on_raised": False, "on_assigned": True, "email": "eng@example.com"}
    assert api.put(path, json={"on_raised": True, "on_assigned": True}, headers=VIEWER).status_code == 403
    res = api.put(path, json={"on_raised": True, "on_assigned": False}, headers=ENG)
    assert res.json() == {"on_raised": True, "on_assigned": False, "email": "eng@example.com"}
    assert api.get(path, headers=ENG).json()["on_raised"] is True
    assert api.get(path, headers=ENG2).json()["on_raised"] is False  # each their own
    assert api.put(path, json={"on_raised": True}, headers=ENG).status_code == 422
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        row = conn.execute(
            "SELECT before, after FROM audit_log WHERE action = 'notification.preferences' ORDER BY id DESC LIMIT 1"
        ).fetchone()
    assert row == {
        "before": {"on_raised": False, "on_assigned": True},
        "after": {"on_raised": True, "on_assigned": False},
    }


def test_admins_point_the_site_at_a_teams_channel_whose_url_stays_secret(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    path = f"/sites/{site}/notifications/teams"
    assert api.get(path, headers=ENG).status_code == 403
    assert api.get(path, headers=ADMIN).json() == {"configured": False, "host": None, "on_raised": True}
    bad = api.put(path, json={"webhook_url": "https://intranet.example.com/x"}, headers=ADMIN)
    assert (bad.status_code, bad.json()["detail"].split(":")[0]) == (422, "Not a Microsoft Teams webhook")
    res = api.put(path, json={"webhook_url": f"  {TEAMS} "}, headers=ADMIN)
    assert res.json() == {"configured": True, "host": "acme.webhook.office.com", "on_raised": True}
    assert "webhookb2" not in res.text
    # Left out, the URL stays: only whether it hears of new warnings changes.
    paused = api.put(path, json={"on_raised": False}, headers=ADMIN).json()
    assert paused == {"configured": True, "host": "acme.webhook.office.com", "on_raised": False}
    removed = api.put(path, json={"webhook_url": None}, headers=ADMIN).json()
    assert removed == {"configured": False, "host": None, "on_raised": True}
    assert api.put(path, json={"on_raised": False}, headers=ADMIN).json()["configured"] is False
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        audited = conn.execute("SELECT before, after FROM audit_log WHERE action = 'notification.teams'").fetchall()
    assert "webhookb2" not in str(audited)
    assert audited[0]["after"]["host"] == "acme.webhook.office.com"


def recent_warning(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    tag: str = "dc9.friction",
    ago: timedelta = timedelta(minutes=15),
    lateness: float = 300,
) -> str:
    """A detector that raises one warning, about `ago` ago; the signal's id."""
    now = datetime.now(UTC)
    values = [100.0 + (i % 3) for i in range(250)] + [500.0] * 30
    every = timedelta(seconds=10)
    first = now - ago - len(values) * every
    imp = api.post(f"/sites/{site}/imports", json={"name": "recent.csv"}, headers=ENG).json()
    samples = [{"signal": tag, "at": (first + i * every).isoformat(), "value": v} for i, v in enumerate(values)]
    assert api.post(f"/sites/{site}/imports/{imp['id']}/samples", json={"samples": samples}, headers=ENG).is_success
    signal = api.get(f"/sites/{site}/signals", params={"q": tag}, headers=VIEWER).json()["signals"][0]["id"]
    detector = create(api, site, signal, name=tag.replace(".", "-"), lateness_seconds=lateness).json()
    assert api.post(f"/sites/{site}/detectors/{detector['id']}/run", headers=ENG).json()["opened"] == 1
    return str(signal)


def outbox(database_url: str) -> list[tuple[Any, ...]]:
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        rows = conn.execute(
            """
            SELECT n.kind, n.channel, u.email FROM notifications n LEFT JOIN users u ON u.id = n.recipient_id
            ORDER BY n.id
            """
        ).fetchall()
    return [(r["kind"], r["channel"], r["email"]) for r in rows]


def test_a_new_warning_is_queued_for_who_asked_and_the_teams_channel(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    with psycopg.connect(database_url) as conn:
        conn.execute("TRUNCATE notifications")
    api.put(f"/sites/{site}/notifications/preferences", json={"on_raised": True, "on_assigned": True}, headers=ENG2)
    api.put(f"/sites/{site}/notifications/teams", json={"webhook_url": TEAMS}, headers=ADMIN)
    # Months-old history raises warnings, but they are old news: nothing is queued.
    signal = import_friction(api, site, FIXTURE["values"])
    detector = create(api, site, signal).json()
    assert api.post(f"/sites/{site}/detectors/{detector['id']}/run", headers=ENG).json()["opened"] == 3
    assert outbox(database_url) == []
    # One raised ten minutes ago reaches eng2 (who asked) and the channel; not eng (who didn't).
    recent_warning(api, site)
    assert outbox(database_url) == [
        ("warning_raised", "email", "eng2@example.com"),
        ("warning_raised", "teams", None),
    ]
    # A detector that holds readings back two hours finds its warnings later: still news.
    recent_warning(api, site, "dc8.friction", ago=timedelta(hours=2, minutes=30), lateness=7200)
    assert len(outbox(database_url)) == 4
    # Someone demoted to viewer gets no more, whatever they chose before.
    eng2 = user_id(api, site, ENG2)
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE site_members SET role = 'viewer' WHERE site_id = %s AND user_id = %s", [site, eng2])
    recent_warning(api, site, "dc7.friction")
    assert outbox(database_url)[-1:] == [("warning_raised", "teams", None)]
    assert len(outbox(database_url)) == 5


def test_an_assignment_is_queued_for_the_assignee_unless_they_did_it_or_opted_out(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    recent_warning(api, site)
    (warning,) = api.get(f"/sites/{site}/warnings", headers=VIEWER).json()
    path = f"/sites/{site}/warnings/{warning['id']}/assignee"
    eng, eng2 = user_id(api, site, ENG), user_id(api, site, ENG2)
    api.put(path, json={"user_id": eng}, headers=ENG)  # yourself: no email
    api.put(path, json={"user_id": eng2, "note": "Yours"}, headers=ENG)
    assert outbox(database_url) == [("warning_assigned", "email", "eng2@example.com")]
    api.put(path, json={"user_id": None}, headers=ENG)
    api.put(path, json={"user_id": eng2}, headers=ENG)  # a new assignment: a new email
    api.put(f"/sites/{site}/notifications/preferences", json={"on_raised": False, "on_assigned": False}, headers=ENG)
    api.put(path, json={"user_id": eng}, headers=ENG2)  # eng turned these off
    assert outbox(database_url) == [("warning_assigned", "email", "eng2@example.com")] * 2


class FakeSender:
    def __init__(self, fail: Exception | None = None) -> None:
        self.emails: list[tuple[str, Message]] = []
        self.posts: list[tuple[str, dict[str, Any]]] = []
        self.fail = fail

    def email(self, to: str, message: Message) -> None:
        if self.fail:
            raise self.fail
        self.emails.append((to, message))

    def teams(self, url: str, payload: dict[str, Any]) -> None:
        if self.fail:
            raise self.fail
        self.posts.append((url, payload))


def test_due_messages_are_sent_once_and_failures_retried_then_given_up(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    api.put(f"/sites/{site}/notifications/preferences", json={"on_raised": True, "on_assigned": True}, headers=ENG2)
    api.put(f"/sites/{site}/notifications/teams", json={"webhook_url": TEAMS}, headers=ADMIN)
    recent_warning(api, site)
    (warning,) = api.get(f"/sites/{site}/warnings", headers=VIEWER).json()
    api.put(
        f"/sites/{site}/warnings/{warning['id']}/assignee",
        json={"user_id": user_id(api, site, ENG2), "note": "Check the tip"},
        headers=ENG,
    )
    with psycopg.connect(database_url, row_factory=dict_row, autocommit=True) as conn:
        conn.execute("SET TIME ZONE 'Asia/Kolkata'")  # times are written in UTC whatever the session's zone
        # Down: each is kept and retried later, with why.
        down = send_due(conn, FakeSender(OSError("Connection refused")), "https://tiles.example.com/")
        assert (down.sent, down.failed, down.given_up) == (0, 3, 0)
        rows = conn.execute("SELECT attempts, last_error, next_at > now() AS later FROM notifications").fetchall()
        assert rows == [{"attempts": 1, "last_error": "Connection refused", "later": True}] * 3
        assert send_due(conn, FakeSender(), "https://tiles.example.com/").sent == 0  # not due yet
        waiting = api.get(f"/sites/{site}/notifications", params={"state": "pending"}, headers=ADMIN).json()
        assert len(waiting) == 3 and all(d["last_error"] == "Connection refused" for d in waiting)
        assert api.get(f"/sites/{site}/notifications", params={"state": "failed"}, headers=ADMIN).json() == []
        conn.execute("UPDATE notifications SET next_at = now()")
        sender = FakeSender()
        assert send_due(conn, sender, "https://tiles.example.com/").sent == 3
        assert send_due(conn, sender, "https://tiles.example.com/").sent == 0  # once only
        assert conn.execute("SELECT count(*) AS n FROM notifications WHERE sent_at IS NULL").fetchone() == {"n": 0}

        raised = next(m for to, m in sender.emails if m.subject.startswith("[Tiles] Warning"))
        assert raised.subject == "[Tiles] Warning on dc9.friction at Plant 1"
        assert raised.lines[0] == "dc9-friction raised a warning on dc9.friction at Plant 1."
        assert "above the threshold of" in raised.lines[1] and raised.lines[1].endswith("The signal is still out.")
        started = datetime.fromisoformat(warning["started_at"]).astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")
        assert raised.lines[1].startswith(f"Started {started}: peak")
        assert raised.link == "https://tiles.example.com/#/warnings"
        assigned = next(m for to, m in sender.emails if "assigned" in m.subject)
        assert assigned.subject == "[Tiles] eng assigned you a warning on dc9.friction"
        assert assigned.lines[-1] == "Their note: Check the tip"
        ((url, card),) = sender.posts
        assert url == TEAMS
        content = card["attachments"][0]["content"]
        assert content["type"] == "AdaptiveCard"
        assert content["body"][0]["text"] == "Warning on dc9.friction at Plant 1"
        assert content["actions"][0]["url"] == "https://tiles.example.com/#/warnings"

        # A message that keeps failing is given up after MAX_ATTEMPTS.
        conn.execute("UPDATE notifications SET sent_at = NULL, attempts = 0, next_at = now()")
        monkeypatch.setattr(notify, "MAX_ATTEMPTS", 2)
        send_due(conn, FakeSender(RuntimeError("550 no such user")), "https://tiles.example.com")
        conn.execute("UPDATE notifications SET next_at = now()")
        gave_up = send_due(conn, FakeSender(RuntimeError("550 no such user")), "https://tiles.example.com")
        assert (gave_up.failed, gave_up.given_up) == (0, 3)
        assert send_due(conn, FakeSender(), "https://tiles.example.com").sent == 0

    listed = api.get(f"/sites/{site}/notifications", params={"state": "failed"}, headers=ADMIN).json()
    assert {(d["channel"], d["recipient"], d["last_error"]) for d in listed} == {
        ("email", "eng2@example.com", "550 no such user"),
        ("teams", "Teams channel", "550 no such user"),
    }
    assert all(d["failed_at"] and d["attempts"] == 2 for d in listed)
    assert api.get(f"/sites/{site}/notifications", headers=ENG).status_code == 403


def test_a_message_for_a_removed_teams_channel_fails_rather_than_going_elsewhere(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    api.put(f"/sites/{site}/notifications/teams", json={"webhook_url": TEAMS}, headers=ADMIN)
    recent_warning(api, site)
    api.put(f"/sites/{site}/notifications/teams", json={"webhook_url": None}, headers=ADMIN)
    sender = FakeSender()
    with psycopg.connect(database_url, row_factory=dict_row, autocommit=True) as conn:
        r = send_due(conn, sender, "https://tiles.example.com")
        assert (r.sent, r.given_up, sender.posts) == (0, 1, [])  # at once: retrying can't help
        error = conn.execute("SELECT last_error, failed_at IS NOT NULL AS gave_up FROM notifications").fetchone()
    assert error == {"last_error": "The site's Teams channel was removed", "gave_up": True}
    # Turned off while messages waited: those are given up too, not posted.
    api.put(f"/sites/{site}/notifications/teams", json={"webhook_url": TEAMS}, headers=ADMIN)
    recent_warning(api, site, "dc6.friction")
    api.put(f"/sites/{site}/notifications/teams", json={"on_raised": False}, headers=ADMIN)
    with psycopg.connect(database_url, row_factory=dict_row, autocommit=True) as conn:
        assert send_due(conn, sender, "https://tiles.example.com").given_up == 1
    assert sender.posts == []


def test_the_command_sends_what_is_due(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    api.put(f"/sites/{site}/notifications/teams", json={"webhook_url": TEAMS}, headers=ADMIN)
    recent_warning(api, site)
    monkeypatch.setenv("TILES_DATABASE_URL", database_url)
    from tiles_api.settings import get_settings

    get_settings.cache_clear()
    failing = FakeSender(OSError("timed out"))
    try:
        with pytest.raises(SystemExit):
            notify.main([], sender=lambda settings: failing)
        assert "0 sent, 1 to retry, 0 given up" in capsys.readouterr().out
        with psycopg.connect(database_url) as conn:
            conn.execute("UPDATE notifications SET next_at = now()")
        notify.main([], sender=lambda settings: FakeSender())
        assert "1 sent, 0 to retry, 0 given up" in capsys.readouterr().out
    finally:
        get_settings.cache_clear()


def test_email_goes_out_by_smtp_with_starttls_and_login(monkeypatch: pytest.MonkeyPatch) -> None:
    message = Message("[Tiles] Warning on x", ["First line.", "Second line."], "https://tiles.example.com/#/warnings")
    with pytest.raises(RuntimeError, match="Email is not set up"):
        LiveSender(Settings(smtp_host=None)).email("eng@example.com", message)
    seen: dict[str, Any] = {}

    class FakeSMTP:
        def __init__(self, host: str, port: int, timeout: float) -> None:
            seen["server"] = (host, port)

        def quit(self) -> None:
            seen["closed"] = "quit"
            if seen.get("hang_up"):
                raise smtplib.SMTPServerDisconnected("Connection unexpectedly closed")

        def close(self) -> None:
            seen["closed"] = "close"

        def starttls(self, context: Any) -> None:
            seen["tls"] = True

        def login(self, user: str, password: str) -> None:
            seen["login"] = (user, password)

        def send_message(self, mail: Any) -> None:
            seen["mail"] = mail

    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    settings = Settings(smtp_host="smtp.example.com", smtp_user="tiles", smtp_password="pw")  # noqa: S106 - a test
    LiveSender(settings).email("eng@example.com", message)
    mail = seen["mail"]
    assert (seen["server"], seen["tls"], seen["login"]) == (("smtp.example.com", 587), True, ("tiles", "pw"))
    assert (mail["To"], mail["Subject"], mail["From"]) == (
        "eng@example.com",
        "[Tiles] Warning on x",
        "Tiles <tiles@example.com>",
    )
    assert mail.get_content() == (
        "First line.\n\nSecond line.\n\nOpen it in Tiles: https://tiles.example.com/#/warnings\n"
    )
    assert seen["closed"] == "quit"
    # A server that hangs up on QUIT after taking the message: it was sent, so no error (nor resend).
    seen["hang_up"] = True
    LiveSender(settings).email("eng@example.com", message)
    assert seen["closed"] == "close"
    with pytest.raises(RuntimeError, match="Not a Microsoft Teams webhook"):
        LiveSender(settings).teams("https://intranet.example.com/x", {})


def test_a_teams_webhook_that_redirects_is_not_followed() -> None:
    followed: list[str] = []

    class Redirecting(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # the webhook answers with a redirect elsewhere
            self.send_response(302)
            self.send_header("Location", "/internal")
            self.end_headers()

        def do_GET(self) -> None:  # where a redirect would have led
            followed.append(self.path)
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args: object) -> None:
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Redirecting)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/hook"
        req = urllib.request.Request(url, data=b"{}", method="POST")
        with pytest.raises(urllib.error.HTTPError, match="redirected") as refused:
            notify._no_redirects.open(req, timeout=5)
        refused.value.close()
    finally:
        server.shutdown()
        server.server_close()
    assert followed == []
