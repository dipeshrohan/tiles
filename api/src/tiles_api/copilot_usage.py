"""Copilot cost and latency controls (T4.07): rate limits and the daily token budget, checked
before a question is taken, and the usage dashboard.

Every question is a `copilot_usage` row (migration 0019), written when it is taken and updated
with each message it stores, so questions still being answered count too. An organisation may ask
`copilot_org_questions_per_minute` questions a minute, each user `copilot_user_questions_per_minute`,
and the organisation's questions may use `copilot_org_daily_tokens` billed tokens a UTC day
(`assistant.billed`); one question stops at `copilot_question_tokens`. A question over a limit is
refused with 429 and Retry-After. The daily budget is checked between a question's model calls
too, so questions running at once overshoot it by at most a call each. Questions of one
organisation are admitted one at a time (an advisory lock), so two at once can't both take the
last place.
"""

import math
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException, status

from tiles_api.settings import Settings
from tiles_api.store import Conn, all_sites, one

# The ages (seconds) of the questions in the last minute, oldest first: the organisation's and the user's.
COUNTS = """
SELECT
  coalesce(array_agg(extract(epoch FROM now() - asked_at)::float ORDER BY asked_at)
           FILTER (WHERE asked_at > now() - interval '1 minute'), '{}') AS org_ages,
  coalesce(array_agg(extract(epoch FROM now() - asked_at)::float ORDER BY asked_at)
           FILTER (WHERE asked_at > now() - interval '1 minute' AND user_id = %(u)s), '{}') AS user_ages,
  coalesce(sum(billed_tokens) FILTER (WHERE asked_at >= date_trunc('day', now(), 'UTC')), 0) AS today,
  extract(epoch FROM date_trunc('day', now(), 'UTC') + interval '1 day' - now()) AS until_tomorrow
FROM copilot_usage
WHERE org_id = %(o)s AND asked_at >= least(now() - interval '1 minute', date_trunc('day', now(), 'UTC'))
"""


def _refuse(detail: str, seconds: float) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS, detail, headers={"Retry-After": str(max(1, math.ceil(seconds)))}
    )


def _wait(ages: list[float], limit: int) -> float:
    """Seconds until fewer than `limit` of the questions asked `ages` ago are in the last minute:
    when the one that leaves room ages out (more than one, if the limit was lowered meanwhile)."""
    return 60 - ages[len(ages) - limit]


def admit(
    conn: Conn,
    settings: Settings,
    org_id: uuid.UUID,
    site_id: uuid.UUID,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID,
) -> int:
    """Takes a question, or raises 429 when a limit is reached; returns its usage row's id. Run in
    the request's transaction: the lock is held until the question is stored."""
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [f"copilot-usage:{org_id}"])
    with all_sites(conn):  # the organisation's questions on every site (row security, T5.04)
        c = one(conn.execute(COUNTS, {"o": org_id, "u": user_id}).fetchone())
    per_user = settings.copilot_user_questions_per_minute
    if per_user and len(c["user_ages"]) >= per_user:
        raise _refuse(
            f"You have asked {per_user} questions in the last minute: wait a moment", _wait(c["user_ages"], per_user)
        )
    per_org = settings.copilot_org_questions_per_minute
    if per_org and len(c["org_ages"]) >= per_org:
        raise _refuse(
            f"Your organisation has asked {per_org} questions in the last minute: wait a moment",
            _wait(c["org_ages"], per_org),
        )
    daily = settings.copilot_org_daily_tokens
    if daily and c["today"] >= daily:
        raise _refuse(
            f"Your organisation has used its copilot budget of {daily:,} tokens for today (UTC)",
            float(c["until_tomorrow"]),
        )
    row = conn.execute(
        "INSERT INTO copilot_usage (org_id, site_id, user_id, conversation_id) VALUES (%s, %s, %s, %s) RETURNING id",
        [org_id, site_id, user_id, conversation_id],
    ).fetchone()
    return int(one(row)["id"])


@dataclass
class Tally:
    """A question's usage so far, kept while it is answered and saved with each message it stores
    (on the same connection), and when it ends."""

    usage_id: int
    org_id: uuid.UUID
    tokens: dict[str, int] = field(default_factory=dict)  # summed over its model calls
    billed: int = 0
    model_calls: int = 0
    first_text_ms: int | None = None
    grounded: bool | None = None
    outcome: str = "running"

    def add_call(self, usage: dict[str, int], billed: int) -> None:
        self.model_calls += 1
        self.billed += billed
        for k, v in usage.items():
            self.tokens[k] = self.tokens.get(k, 0) + v


def save(conn: Conn, t: Tally, total_ms: int | None = None) -> None:
    """Writes the tally; with `total_ms`, the question has ended."""
    conn.execute(
        """
        UPDATE copilot_usage SET model_calls = %s, input_tokens = %s, output_tokens = %s,
               cache_write_tokens = %s, cache_read_tokens = %s, billed_tokens = %s,
               first_text_ms = %s, grounded = %s, outcome = %s,
               total_ms = %s, finished_at = CASE WHEN %s::integer IS NULL THEN NULL ELSE now() END
        WHERE id = %s
        """,
        [
            t.model_calls,
            t.tokens.get("input_tokens", 0),
            t.tokens.get("output_tokens", 0),
            t.tokens.get("cache_creation_input_tokens", 0),
            t.tokens.get("cache_read_input_tokens", 0),
            t.billed,
            t.first_text_ms,
            t.grounded,
            t.outcome,
            total_ms,
            total_ms,
            t.usage_id,
        ],
    )


def over_daily(conn: Conn, settings: Settings, org_id: uuid.UUID) -> str | None:
    """Why the organisation may not use more tokens today, if it may not: checked between the model
    calls of a question too, so questions running at once can't each spend a whole budget."""
    daily = settings.copilot_org_daily_tokens
    if not daily:
        return None
    with all_sites(conn):
        today = one(
            conn.execute(
                "SELECT coalesce(sum(billed_tokens), 0) AS n FROM copilot_usage"
                " WHERE org_id = %s AND asked_at >= date_trunc('day', now(), 'UTC')",
                [org_id],
            ).fetchone()
        )["n"]
    return (
        f"Your organisation has used its copilot budget of {daily:,} tokens for today (UTC)" if today >= daily else None
    )


DAYS = """
SELECT (asked_at AT TIME ZONE 'UTC')::date AS day,
       count(*) AS questions,
       count(*) FILTER (WHERE outcome = 'answered') AS answered,
       count(*) FILTER (WHERE outcome = 'failed') AS failed,
       count(*) FILTER (WHERE outcome = 'over_budget') AS over_budget,
       count(*) FILTER (WHERE grounded = false) AS ungrounded,
       sum(model_calls) AS model_calls,
       sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
       sum(cache_write_tokens) AS cache_write_tokens, sum(cache_read_tokens) AS cache_read_tokens,
       sum(billed_tokens) AS billed_tokens,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY first_text_ms) AS first_text_p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY first_text_ms) AS first_text_p95_ms,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS total_p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) AS total_p95_ms
FROM copilot_usage
WHERE site_id = %(s)s AND asked_at >= date_trunc('day', now(), 'UTC') - (%(days)s - 1) * interval '1 day'
GROUP BY 1 ORDER BY 1 DESC
"""

USERS = """
SELECT coalesce(u.name, 'Removed user') AS user, coalesce(u.email, '') AS email,
       count(*) AS questions, sum(c.billed_tokens) AS billed_tokens
FROM copilot_usage c LEFT JOIN users u ON u.id = c.user_id
WHERE c.site_id = %(s)s AND c.asked_at >= date_trunc('day', now(), 'UTC') - (%(days)s - 1) * interval '1 day'
GROUP BY u.id, u.name, u.email ORDER BY billed_tokens DESC, 1 LIMIT 50
"""

TODAY = """
SELECT coalesce(sum(billed_tokens), 0) AS org,
       coalesce(sum(billed_tokens) FILTER (WHERE site_id = %(s)s), 0) AS site
FROM copilot_usage WHERE org_id = %(o)s AND asked_at >= date_trunc('day', now(), 'UTC')
"""


def dashboard(conn: Conn, settings: Settings, org_id: uuid.UUID, site_id: uuid.UUID, days: int) -> dict[str, Any]:
    """A site's copilot usage over the last `days` UTC days (today included), by day and by user,
    with the limits and how much of today's organisation budget is used."""
    args = {"s": site_id, "o": org_id, "days": days}
    with all_sites(conn):  # the organisation's total today, from every site
        today = one(conn.execute(TODAY, args).fetchone())
    return {
        "days": conn.execute(DAYS, args).fetchall(),
        "users": conn.execute(USERS, args).fetchall(),
        "today": {"org_billed_tokens": today["org"], "site_billed_tokens": today["site"]},
        "limits": {
            "question_tokens": settings.copilot_question_tokens,
            "org_daily_tokens": settings.copilot_org_daily_tokens,
            "org_questions_per_minute": settings.copilot_org_questions_per_minute,
            "user_questions_per_minute": settings.copilot_user_questions_per_minute,
            "max_tokens_per_call": settings.copilot_max_tokens,
            "max_rounds": settings.copilot_max_rounds,
        },
    }
