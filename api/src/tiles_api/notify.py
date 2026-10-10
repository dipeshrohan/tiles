"""Notifications (T3.09): queueing messages about warnings, and `tiles-notify`, which sends them.

Two things are announced:

- a warning raised: by email to the site's engineers and admins who asked for every new warning,
  and to the site's Teams channel if an admin set one up. Only warnings the detector found
  within RECENT of when it could have (its lateness allowance holds readings back that long):
  one catching up on months of history raises old news, not alarms;
- a warning assigned to someone by someone else: by email to them, unless they turned it off.

Messages wait in the `notifications` outbox (migration 0012), queued in the same transaction as
what they announce. `tiles-notify` (e.g. every minute from cron) sends the due ones, each in its
own transaction with its row locked, so two runs never send one twice; a failure is retried with
a growing wait, and given up after MAX_ATTEMPTS (at once if it can't succeed: the channel was
removed). Delivery is at least once: a message sent just before the run dies is sent again. A
message reads the warning as it is when sent.
"""

import argparse
import http.client
import json
import smtplib
import ssl
import sys
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from typing import Any, Protocol
from urllib.parse import urlsplit

from tiles_api import sealed, telemetry
from tiles_api.settings import Settings, get_settings
from tiles_api.store import Conn, connect_job, one

RECENT = timedelta(hours=1)
MAX_ATTEMPTS = 6
# Teams webhooks live on these hosts: the old incoming webhooks, and Workflows (Power Automate).
TEAMS_HOSTS = (".webhook.office.com", ".logic.azure.com", ".api.powerplatform.com")


def teams_url_problem(url: str) -> str | None:
    """Why `url` can't be a Teams webhook, or None. Only https to Microsoft's webhook hosts, so a
    site admin can't point Tiles at anything else on the network."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "Not a URL"
    host = (parts.hostname or "").lower()
    if parts.scheme != "https":
        return "A Teams webhook URL starts with https://"
    if parts.username or parts.password:
        return "A Teams webhook URL has no user name or password in it"
    if not any(host.endswith(suffix) for suffix in TEAMS_HOSTS):
        return "Not a Microsoft Teams webhook: its host must end with " + ", ".join(TEAMS_HOSTS)
    return None


def queue_raised(
    conn: Conn, warning_id: uuid.UUID, started_at: datetime, found_at: datetime, lateness: timedelta
) -> int:
    """Queues the messages for a warning just raised; how many. None for an old one: found more
    than RECENT after its detector could first have seen it (`lateness` after the reading)."""
    if found_at - started_at > lateness + RECENT:
        return 0
    rows = conn.execute(
        """
        INSERT INTO notifications (site_id, warning_id, kind, channel, recipient_id)
        SELECT w.site_id, w.id, 'warning_raised', 'email', p.user_id
        FROM warnings w
        JOIN notification_prefs p ON p.site_id = w.site_id AND p.on_raised
        JOIN users u ON u.id = p.user_id
        LEFT JOIN site_members m ON m.site_id = w.site_id AND m.user_id = p.user_id
        -- Still an engineer or admin of the site: choices outlive a demotion or leaving.
        WHERE w.id = %(w)s AND (u.org_admin OR m.role IN ('engineer', 'admin'))
        UNION ALL
        SELECT w.site_id, w.id, 'warning_raised', 'teams', NULL
        FROM warnings w JOIN site_notifications s ON s.site_id = w.site_id
        WHERE w.id = %(w)s AND s.teams_webhook_url IS NOT NULL AND s.teams_on_raised
        ON CONFLICT DO NOTHING
        RETURNING id
        """,
        {"w": warning_id},
    ).fetchall()
    return len(rows)


def queue_assigned(
    conn: Conn, warning_id: uuid.UUID, assignee_id: uuid.UUID, actor_id: uuid.UUID, activity_id: int
) -> int:
    """Queues the email telling someone a warning is theirs, unless they assigned it themselves
    or turned these off (they are on until then)."""
    if assignee_id == actor_id:
        return 0
    rows = conn.execute(
        """
        INSERT INTO notifications (site_id, warning_id, kind, channel, recipient_id, activity_id)
        SELECT w.site_id, w.id, 'warning_assigned', 'email', %(who)s, %(step)s
        FROM warnings w
        LEFT JOIN notification_prefs p ON p.site_id = w.site_id AND p.user_id = %(who)s
        WHERE w.id = %(w)s AND coalesce(p.on_assigned, true)
        ON CONFLICT DO NOTHING
        RETURNING id
        """,
        {"w": warning_id, "who": assignee_id, "step": activity_id},
    ).fetchall()
    return len(rows)


@dataclass(frozen=True)
class Message:
    subject: str
    lines: list[str]
    link: str


def _utc(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")


def number_text(x: float) -> str:
    """A reading as people read it: four significant digits, or whole above 1,000."""
    return f"{x:,.4g}" if abs(x) < 1000 else f"{x:,.0f}"


def render(n: dict[str, Any], app_url: str) -> Message:
    """The message for a queued notification (a row of DUE), from the warning as it is now."""
    tag = n["signal_tag"]
    limit = f"the threshold of {number_text(n['threshold'])} (baseline {number_text(n['baseline'])})"
    out = f"peak {number_text(n['peak'])}, {n['side']} {limit}"
    started = _utc(n["started_at"])
    state = "still out" if n["ended_at"] is None else "back in since " + _utc(n["ended_at"])
    link = f"{app_url.rstrip('/')}/#/warnings"
    if n["kind"] == "warning_assigned":
        subject = f"[Tiles] {n['assigner'] or 'Someone'} assigned you a warning on {tag}"
        first = f"{n['assigner'] or 'Someone'} assigned you the warning on {tag} at {n['site_name']}."
    else:
        subject = f"[Tiles] Warning on {tag} at {n['site_name']}"
        first = f"{n['detector']} raised a warning on {tag} at {n['site_name']}."
    lines = [first, f"Started {started}: {out}. The signal is {state}."]
    if n["kind"] == "warning_assigned" and n["note"]:
        lines.append(f"Their note: {n['note']}")
    return Message(subject, lines, link)


def teams_card(m: Message) -> dict[str, Any]:
    """A Teams message: an Adaptive Card, which both kinds of Teams webhook accept."""
    body = [{"type": "TextBlock", "text": m.subject.removeprefix("[Tiles] "), "weight": "Bolder", "wrap": True}]
    body += [{"type": "TextBlock", "text": line, "wrap": True} for line in m.lines]
    card = {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": body,
        "actions": [{"type": "Action.OpenUrl", "title": "Open in Tiles", "url": m.link}],
    }
    return {
        "type": "message",
        "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "content": card}],
    }


class GiveUp(Exception):
    """A message that can't succeed, however often it is tried."""


class Sender(Protocol):
    def email(self, to: str, message: Message) -> None: ...
    def teams(self, url: str, payload: dict[str, Any]) -> None: ...


class LiveSender:
    """Sends by SMTP (STARTTLS unless turned off) and by https to Teams."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def email(self, to: str, message: Message) -> None:
        s = self.settings
        if not s.smtp_host:
            raise RuntimeError("Email is not set up: TILES_SMTP_HOST is unset")
        mail = EmailMessage()
        mail["From"] = s.smtp_from
        mail["To"] = to
        mail["Subject"] = message.subject
        mail.set_content("\n\n".join([*message.lines, f"Open it in Tiles: {message.link}"]))
        smtp = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20)
        try:
            if s.smtp_starttls:
                smtp.starttls(context=ssl.create_default_context())
            if s.smtp_user:
                smtp.login(s.smtp_user, s.smtp_password.get_secret_value() if s.smtp_password else "")
            smtp.send_message(mail)
        finally:
            # Sent is sent: a server that hangs up on QUIT must not make it count as failed (and resent).
            try:
                smtp.quit()
            except (smtplib.SMTPException, OSError):
                smtp.close()

    def teams(self, url: str, payload: dict[str, Any]) -> None:
        problem = teams_url_problem(url)  # checked when set; again here, as it is about to be called
        if problem:
            raise RuntimeError(problem)
        req = urllib.request.Request(  # noqa: S310 - https to a Teams host, checked above
            url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST"
        )
        # Redirects are not followed: they could lead anywhere, past the host check.
        with _no_redirects.open(req, timeout=20) as res:
            if res.status >= 300:
                raise RuntimeError(f"Teams answered {res.status}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: http.client.HTTPMessage,
        newurl: str,
    ) -> None:
        raise urllib.error.HTTPError(req.full_url, code, f"Teams redirected to another address ({code})", headers, fp)


_no_redirects = urllib.request.build_opener(_NoRedirect)


DUE = """
SELECT n.id, n.site_id, n.kind, n.channel, n.attempts, u.email, s.teams_webhook_url, s.teams_on_raised,
       st.name AS site_name,
       w.started_at, w.ended_at, w.peak, w.baseline, w.threshold, w.side, g.tag AS signal_tag,
       d.name AS detector, actor.name AS assigner, a.note
FROM notifications n
JOIN warnings w ON w.id = n.warning_id
JOIN detectors d ON d.id = w.detector_id
JOIN signals g ON g.id = w.signal_id
JOIN sites st ON st.id = n.site_id
LEFT JOIN users u ON u.id = n.recipient_id
LEFT JOIN site_notifications s ON s.site_id = n.site_id
LEFT JOIN warning_activity a ON a.id = n.activity_id
LEFT JOIN users actor ON actor.id = a.actor_id
WHERE n.id = %s
"""


def retry_wait(attempts: int) -> timedelta:
    """How long to wait after the `attempts`-th failure: 1, 2, 4, 8, 16 minutes."""
    return timedelta(minutes=2 ** (attempts - 1))


@dataclass
class Sent:
    sent: int = 0
    failed: int = 0  # will be retried
    given_up: int = 0


def send_due(conn: Conn, sender: Sender, app_url: str, limit: int = 200, keys: sealed.DataKeys | None = None) -> Sent:
    """Sends the due notifications, oldest first, each in its own transaction (`conn` in
    autocommit mode), so one failing keeps the others sent."""
    result = Sent()
    for _ in range(limit):
        with conn.transaction():
            row = conn.execute(
                """
                SELECT id FROM notifications
                WHERE sent_at IS NULL AND failed_at IS NULL AND next_at <= now()
                ORDER BY next_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
                """
            ).fetchone()
            if row is None:
                break
            n = one(conn.execute(DUE, [row["id"]]).fetchone())  # locked; its warning and site cascade to it
            try:
                message = render(n, app_url)
                if n["channel"] == "email":
                    sender.email(n["email"], message)
                elif not n["teams_webhook_url"]:
                    raise GiveUp("The site's Teams channel was removed")
                elif not n["teams_on_raised"]:
                    raise GiveUp("Posting new warnings to the site's Teams channel was turned off")
                else:
                    url = sealed.unseal(keys, n["teams_webhook_url"], sealed.teams_context(n["site_id"]))
                    sender.teams(url, teams_card(message))
            except sealed.SealError as e:  # a data key missing here: held, not counted, until it is set
                conn.execute(
                    "UPDATE notifications SET last_error = %s, next_at = now() + interval '5 minutes' WHERE id = %s",
                    [str(e)[:500], n["id"]],
                )
                result.failed += 1
                continue
            except Exception as e:  # anything the server or network says: kept, and retried
                attempts = n["attempts"] + 1
                give_up = attempts >= MAX_ATTEMPTS or isinstance(e, GiveUp)
                conn.execute(
                    """
                    UPDATE notifications SET attempts = %s, last_error = %s, next_at = now() + %s,
                           failed_at = CASE WHEN %s THEN now() END
                    WHERE id = %s
                    """,
                    [attempts, str(e)[:500], retry_wait(attempts), give_up, n["id"]],
                )
                if give_up:
                    result.given_up += 1
                else:
                    result.failed += 1
                continue
            conn.execute(
                "UPDATE notifications SET sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = %s",
                [n["id"]],
            )
            result.sent += 1
    return result


@telemetry.job_main("tiles-notify")
def main(argv: list[str] | None = None, sender: Callable[[Settings], Sender] = LiveSender) -> None:
    """`tiles-notify`: sends the notifications that are due, e.g. every minute from cron."""
    parser = argparse.ArgumentParser(prog="tiles-notify", description=main.__doc__)
    parser.parse_args(argv)
    settings = get_settings()
    with connect_job(settings, autocommit=True) as conn:
        r = send_due(conn, sender(settings), settings.app_url, keys=sealed.keys_of(settings))
    print(f"{r.sent} sent, {r.failed} to retry, {r.given_up} given up")
    if r.failed or r.given_up:
        print("See GET /sites/{id}/notifications for why.", file=sys.stderr)
        raise SystemExit(1)
