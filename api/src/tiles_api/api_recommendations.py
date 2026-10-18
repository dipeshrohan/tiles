"""Setpoint recommendations (T11.02) and their guard rails (T11.04): a sweep of a design model (the
process model for recommendations, T11.01, or any other) over the line's live state suggests a change
within the limits engineers set per parameter; someone other than its proposer approves or rejects
it; the line applies it by hand and says so. Tiles never writes to a PLC. Every step is audited.

The state is each parameter's value from, in turn: the model's default, the value given, and the
median of a signal's readings over the hour before `at` (the live state; a signal with no reading in
that hour is refused, not guessed). The settable parameters each need a limit. A recommendation is
refused when a value would lie outside its limit, when it is made (recommend.breaches, after the
sweep) and when it is approved (against the limits as they are then): no recommendation outside a
limit is ever kept or approved.

Lifecycle: proposed → approved → applied; proposed → rejected.
"""

import statistics
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request, status
from psycopg.types.json import Jsonb
from pydantic import AwareDatetime, BaseModel, Field, StrictFloat, StrictInt

from tiles_api import api_models, recommend
from tiles_api.api_ontology import Ctx, Editor, SiteContext
from tiles_api.errors import Problem
from tiles_api.models import store
from tiles_api.models.registry import Model, ModelError
from tiles_api.models.remote import RemoteError
from tiles_api.store import one

router = APIRouter(tags=["recommendations"])

Status = Literal["proposed", "approved", "rejected", "applied"]
Name = Annotated[str, Field(min_length=1, max_length=63)]
Number = StrictFloat | StrictInt
MAX_LIST = 500
LIVE_WINDOW = timedelta(hours=1)  # a signal's readings the live state takes the median of


class LimitIn(BaseModel):
    min: Number
    max: Number


class LimitOut(BaseModel):
    model: str
    param: str
    unit: str
    min: float
    max: float
    set_by: str
    set_at: datetime


class RecommendIn(BaseModel):
    model: Name
    version: Annotated[str, Field(max_length=40)] | None = None
    objective: Name  # the output to lower (the process model's scrap_chance)
    settable: Annotated[list[Name], Field(min_length=1, max_length=recommend.MAX_SETTABLE)]
    state: Annotated[dict[Name, Number], Field(max_length=50)] = {}
    signals: Annotated[dict[Name, uuid.UUID], Field(max_length=50)] = {}  # {param: signal}: the live state
    at: AwareDatetime | None = None  # the live state's time (now)
    steps: Annotated[int, Field(ge=2, le=41)] = 11
    asset: Annotated[str, Field(min_length=1, max_length=100)] | None = None  # the machine, as the MES names it
    # What measures the outcome once it is applied (T11.03), and how many days after to judge it.
    outcome_signal: uuid.UUID | None = None
    outcome_days: Annotated[int, Field(ge=1, le=90)] = 7


class OutcomeIn(BaseModel):
    signal_id: uuid.UUID | None = None  # None: judged on the machine's events alone
    days: Annotated[int, Field(ge=1, le=90)] = 7


class Measured(BaseModel):
    mean: float | None  # None: no readings
    readings: int


class EventRates(BaseModel):
    scrap: float  # events a day
    downtime: float  # unplanned stops a day
    days: float  # the window's length


class Outcome(BaseModel):
    number: int
    status: Status
    applied_at: datetime | None
    days: int
    state: Literal["not_applied", "collecting", "complete"]
    objective: str
    expected_now: float | None
    expected_proposed: float | None
    expected_change: float | None  # relative: (proposed - now) / now
    signal_tag: str | None
    before: Measured | None
    after: Measured | None
    measured_change: float | None  # relative, like expected_change
    asset: str | None
    events_before: EventRates | None
    events_after: EventRates | None


class DecisionIn(BaseModel):
    note: Annotated[str, Field(max_length=2000)] = ""


class AppliedIn(BaseModel):
    at: AwareDatetime | None = None  # when the line applied it (now)
    note: Annotated[str, Field(max_length=2000)] = ""


class Source(BaseModel):
    signal_id: uuid.UUID
    tag: str
    at: datetime  # the latest reading taken
    readings: int


class Recommendation(BaseModel):
    number: int
    model: str
    version: str
    objective: str
    asset: str | None
    state: dict[str, float]
    sources: dict[str, Source]
    proposal: dict[str, float]
    limits: dict[str, dict[str, float]]
    expected: dict[str, dict[str, float | None]]  # {"now": outputs, "proposed": outputs}
    status: Status
    proposed_by: str
    proposed_at: datetime
    decided_by: str | None
    decided_at: datetime | None
    decision_note: str
    applied_by: str | None
    applied_at: datetime | None
    applied_note: str
    outcome_signal_id: uuid.UUID | None
    outcome_signal_tag: str | None
    outcome_days: int
    mine: bool  # proposed by the person asking: someone else decides it


def _model(ctx: SiteContext, request: Request, key: str, version: str | None = None) -> Model:
    try:
        model = store.find(ctx.conn, ctx.org_id, request.app.state.settings, key, version)
    except KeyError as e:
        raise api_models.no_model(key, version) from e
    if model.spec.kind != "design" or model.spec.inputs:
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "recommendation.not_design",
            f"{key} takes input series: only a design model's parameters can be recommended",
            model=key,
        )
    return model


# ---- limits (T11.04) -------------------------------------------------------------------------


def limits_of(ctx: SiteContext, model: str) -> dict[str, recommend.Limit]:
    rows = ctx.conn.execute(
        "SELECT param, min, max FROM recommendation_limits WHERE site_id = %s AND model = %s", [ctx.site_id, model]
    ).fetchall()
    return {r["param"]: recommend.Limit(r["min"], r["max"]) for r in rows}


@router.get("/sites/{site_id}/recommendation-limits", response_model=list[LimitOut])
def list_limits(ctx: Ctx, request: Request, model: str | None = None) -> list[dict[str, Any]]:
    """The limits engineers set per model parameter: no recommendation goes outside them."""
    rows = ctx.conn.execute(
        "SELECT model, param, min, max, set_by, set_at FROM recommendation_limits"
        " WHERE site_id = %s AND (%s::text IS NULL OR model = %s) ORDER BY model, param",
        [ctx.site_id, model, model],
    ).fetchall()
    units: dict[str, dict[str, str]] = {}
    out = []
    for r in rows:
        if r["model"] not in units:
            try:
                spec = store.find(ctx.conn, ctx.org_id, request.app.state.settings, r["model"]).spec
                units[r["model"]] = {p.name: p.unit for p in spec.params}
            except KeyError:
                units[r["model"]] = {}
        out.append({**r, "unit": units[r["model"]].get(r["param"], "")})
    return out


@router.put("/sites/{site_id}/recommendation-limits/{model}/{param}", response_model=LimitOut)
def set_limit(ctx: Editor, model: str, param: str, body: LimitIn, request: Request) -> dict[str, Any]:
    """Sets a parameter's limit for recommendations (engineers): within the model's own bounds, its
    min at most its max. Audited."""
    spec = _model(ctx, request, model).spec
    found = next((p for p in spec.params if p.name == param), None)
    if found is None:
        raise Problem(
            status.HTTP_404_NOT_FOUND, "recommendation.no_param", f"{model} has no parameter {param}", param=param
        )
    low = -float("inf") if found.min is None else found.min
    high = float("inf") if found.max is None else found.max
    if not (low <= body.min <= body.max <= high):
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "recommendation.bad_limit",
            f"A limit of {param} must be within {found.min} to {found.max}, its min at most its max",
            param=param,
            low="none" if found.min is None else found.min,
            high="none" if found.max is None else found.max,
        )
    before = ctx.conn.execute(
        "SELECT min, max FROM recommendation_limits WHERE site_id = %s AND model = %s AND param = %s FOR UPDATE",
        [ctx.site_id, model, param],
    ).fetchone()
    ctx.conn.execute(
        """
        INSERT INTO recommendation_limits (site_id, model, param, min, max, set_by_id, set_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (site_id, model, param) DO UPDATE
            SET min = EXCLUDED.min, max = EXCLUDED.max, set_by_id = EXCLUDED.set_by_id,
                set_by = EXCLUDED.set_by, set_at = now()
        """,
        [ctx.site_id, model, param, body.min, body.max, ctx.user.id, ctx.user.name],
    )
    ctx.audit(
        "recommendation.limit",
        "recommendation_limit",
        f"{model}/{param}",
        before=dict(before) if before else None,
        after={"min": body.min, "max": body.max},
    )
    row = one(
        ctx.conn.execute(
            "SELECT model, param, min, max, set_by, set_at FROM recommendation_limits"
            " WHERE site_id = %s AND model = %s AND param = %s",
            [ctx.site_id, model, param],
        ).fetchone()
    )
    return {**row, "unit": found.unit}


@router.delete("/sites/{site_id}/recommendation-limits/{model}/{param}", status_code=status.HTTP_204_NO_CONTENT)
def remove_limit(ctx: Editor, model: str, param: str) -> None:
    """Removes a parameter's limit (engineers): it can't be recommended until it has one again. Audited."""
    before = ctx.conn.execute(
        "DELETE FROM recommendation_limits WHERE site_id = %s AND model = %s AND param = %s RETURNING min, max",
        [ctx.site_id, model, param],
    ).fetchone()
    if before is None:
        raise Problem(status.HTTP_404_NOT_FOUND, "recommendation.no_limit", f"{param} has no limit", param=param)
    ctx.audit("recommendation.limit_remove", "recommendation_limit", f"{model}/{param}", before=dict(before))


# ---- recommendations (T11.02) ----------------------------------------------------------------


def _signal_of_site(ctx: SiteContext, signal_id: uuid.UUID) -> str:
    """The signal's tag; 422 when it isn't one of this site's."""
    row = ctx.conn.execute(
        "SELECT tag FROM signals WHERE site_id = %s AND id = %s", [ctx.site_id, signal_id]
    ).fetchone()
    if row is None:
        raise Problem(status.HTTP_422_UNPROCESSABLE_CONTENT, "signal.not_on_site", "Not a signal of this site")
    tag: str = row["tag"]
    return tag


def _live(ctx: SiteContext, signals: dict[str, uuid.UUID], at: datetime) -> dict[str, dict[str, Any]]:
    """Each parameter's signal: the median of its readings over the hour before `at`."""
    out: dict[str, dict[str, Any]] = {}
    for param, signal_id in signals.items():
        signal = ctx.conn.execute(
            "SELECT tag FROM signals WHERE site_id = %s AND id = %s", [ctx.site_id, signal_id]
        ).fetchone()
        if signal is None:
            raise Problem(status.HTTP_422_UNPROCESSABLE_CONTENT, "signal.not_on_site", "Not a signal of this site")
        rows = ctx.conn.execute(
            "SELECT at, value FROM site_samples WHERE signal_id = %s AND value IS NOT NULL"
            " AND at > %s AND at <= %s ORDER BY at",
            [signal_id, at - LIVE_WINDOW, at],
        ).fetchall()
        if not rows:
            raise Problem(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "recommendation.no_live_reading",
                f"{signal['tag']} has no reading in the hour before {at.isoformat()}: the line's state isn't known",
                tag=signal["tag"],
            )
        out[param] = {
            "value": statistics.median(r["value"] for r in rows),
            "signal_id": str(signal_id),
            "tag": signal["tag"],
            "at": rows[-1]["at"].isoformat(),
            "readings": len(rows),
        }
    return out


def _refuse_breaches(found: list[str], limits: dict[str, recommend.Limit]) -> None:
    """The guard rail's refusal: a parameter without a limit, or a value outside its limit."""
    missing = [p for p in found if p not in limits]
    if missing:
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "recommendation.no_limit",
            f"{', '.join(missing)} has no limit: set one first",
            param=", ".join(missing),
        )
    if found:
        raise Problem(
            status.HTTP_409_CONFLICT,
            "recommendation.outside_limit",
            f"Outside its limit: {', '.join(found)}",
            param=", ".join(found),
        )


SELECT = (
    "SELECT r.*, (SELECT tag FROM signals g WHERE g.id = r.outcome_signal_id) AS outcome_signal_tag"
    " FROM recommendations r WHERE r.site_id = %(site)s"
)


def _out(ctx: SiteContext, row: dict[str, Any]) -> dict[str, Any]:
    return {**row, "mine": row["proposed_by_id"] == ctx.user.id}


def get(ctx: SiteContext, number: int, lock: bool = False) -> dict[str, Any]:
    row: dict[str, Any] | None = ctx.conn.execute(
        SELECT + " AND r.number = %(n)s" + (" FOR UPDATE OF r" if lock else ""), {"site": ctx.site_id, "n": number}
    ).fetchone()
    if row is None:
        raise Problem(
            status.HTTP_404_NOT_FOUND,
            "recommendation.not_found",
            f"No recommendation {number} on this site",
            number=number,
        )
    return row


def _expect(row: dict[str, Any], *allowed: Status) -> None:
    if row["status"] not in allowed:
        raise Problem(
            status.HTTP_409_CONFLICT,
            "recommendation.wrong_status",
            f"Recommendation {row['number']} is {row['status']}",
            number=row["number"],
            status=row["status"],
        )


def _audited(row: dict[str, Any]) -> dict[str, Any]:
    keys = ("number", "status", "model", "version", "objective", "asset", "state", "proposal", "limits", "expected")
    out = {k: row[k] for k in keys}
    signal = row.get("outcome_signal_id")
    return out | {"outcome_signal_id": str(signal) if signal else None, "outcome_days": row.get("outcome_days")}


@router.get("/sites/{site_id}/recommendations", response_model=list[Recommendation])
def list_recommendations(
    ctx: Ctx,
    show: Annotated[Literal["open", "all", "proposed", "approved", "rejected", "applied"], Query()] = "open",
    asset: Annotated[str | None, Query(max_length=100)] = None,
) -> list[dict[str, Any]]:
    """The site's recommendations, newest first: those still open (proposed or approved, not yet
    applied) by default, all, or those with one status; of one machine with `asset`."""
    statuses = ["proposed", "approved"] if show == "open" else None if show == "all" else [show]
    rows = ctx.conn.execute(
        SELECT + " AND (%(statuses)s::text[] IS NULL OR r.status = ANY(%(statuses)s))"
        " AND (%(asset)s::text IS NULL OR r.asset = %(asset)s) ORDER BY r.number DESC LIMIT %(limit)s",
        {"site": ctx.site_id, "statuses": statuses, "asset": asset, "limit": MAX_LIST},
    ).fetchall()
    return [_out(ctx, r) for r in rows]


@router.get("/sites/{site_id}/recommendations/{number}", response_model=Recommendation)
def get_recommendation(ctx: Ctx, number: int) -> dict[str, Any]:
    """One recommendation, with the state it was swept on, its limits and what the model expected."""
    return _out(ctx, get(ctx, number))


@router.post("/sites/{site_id}/recommendations", response_model=Recommendation, status_code=status.HTTP_201_CREATED)
def propose(ctx: Editor, body: RecommendIn, request: Request) -> dict[str, Any]:
    """Sweeps the model's settable parameters within their limits over the line's state (given, or
    read from signals over the hour before `at`) and proposes the setting that lowers `objective`
    the most (engineers). Refused when a settable parameter has no limit or when nothing inside the
    limits beats the current setting. Someone else approves it. Audited."""
    model = _model(ctx, request, body.model, body.version)
    spec = model.spec
    names = {p.name for p in spec.params}
    unknown = sorted((set(body.state) | set(body.signals) | set(body.settable)) - names)
    if unknown:
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "recommendation.no_param",
            f"{spec.key} has no parameter {', '.join(unknown)}",
            param=", ".join(unknown),
        )
    if body.outcome_signal is not None:
        _signal_of_site(ctx, body.outcome_signal)
    limits = limits_of(ctx, spec.key)
    settable = {p: limits[p] for p in body.settable if p in limits}
    _refuse_breaches([p for p in body.settable if p not in limits], limits)
    at = body.at or datetime.now(UTC)
    live = _live(ctx, body.signals, at)
    state = {p.name: float(p.default) for p in spec.params}
    state |= {k: float(v) for k, v in body.state.items()}
    state |= {k: float(v["value"]) for k, v in live.items()}
    try:
        swept = recommend.sweep(model, state, settable, body.objective, body.steps)
    except recommend.NoBetter as e:
        raise Problem(
            status.HTTP_409_CONFLICT,
            "recommendation.no_better",
            f"No setting inside the limits lowers {body.objective} from {e.now:g}",
            objective=body.objective,
            now=e.now,
        ) from e
    except RemoteError as e:
        raise Problem(status.HTTP_502_BAD_GATEWAY, "model.remote_failed", str(e), reason=str(e)) from e
    except ModelError as e:
        raise Problem(status.HTTP_422_UNPROCESSABLE_CONTENT, "model.invalid", str(e), reason=str(e)) from e
    _refuse_breaches(recommend.breaches(swept.proposal, limits), limits)  # the guard rail, once more
    number = int(
        one(
            ctx.conn.execute(
                "INSERT INTO recommendation_numbers (site_id, last) VALUES (%s, 1)"
                " ON CONFLICT (site_id) DO UPDATE SET last = recommendation_numbers.last + 1 RETURNING last",
                [ctx.site_id],
            ).fetchone()
        )["last"]
    )
    sources = {p: {k: v for k, v in s.items() if k != "value"} for p, s in live.items()}
    ctx.conn.execute(
        """
        INSERT INTO recommendations (site_id, number, model, version, objective, asset, state, sources, proposal,
                                     limits, expected, proposed_by_id, proposed_by, outcome_signal_id, outcome_days)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        [
            ctx.site_id,
            number,
            spec.key,
            spec.version,
            body.objective,
            body.asset,
            Jsonb(state),
            Jsonb(sources),
            Jsonb(swept.proposal),
            Jsonb({p: {"min": lim.min, "max": lim.max} for p, lim in settable.items()}),
            Jsonb({"now": swept.now, "proposed": swept.proposed}),
            ctx.user.id,
            ctx.user.name,
            body.outcome_signal,
            body.outcome_days,
        ],
    )
    row = get(ctx, number)
    ctx.audit("recommendation.propose", "recommendation", str(number), after=_audited(row) | {"points": swept.points})
    return _out(ctx, row)


@router.post("/sites/{site_id}/recommendations/{number}/approve", response_model=Recommendation)
def approve(ctx: Editor, number: int, body: DecisionIn) -> dict[str, Any]:
    """Approves a proposed recommendation for the line to apply (engineers; not its proposer). Refused
    when a value now lies outside its parameter's limit, as the limits are now. Audited."""
    row = get(ctx, number, lock=True)
    _expect(row, "proposed")
    if row["proposed_by_id"] == ctx.user.id:
        raise Problem(
            status.HTTP_403_FORBIDDEN,
            "recommendation.own",
            "Someone other than its proposer approves a recommendation",
        )
    # Limits may have changed since the sweep: lock them, then check the proposal against them.
    ctx.conn.execute(
        "SELECT 1 FROM recommendation_limits WHERE site_id = %s AND model = %s FOR SHARE", [ctx.site_id, row["model"]]
    )
    limits = limits_of(ctx, row["model"])
    _refuse_breaches(recommend.breaches(row["proposal"], limits), limits)
    return _decide(ctx, row, "approved", body.note)


@router.post("/sites/{site_id}/recommendations/{number}/reject", response_model=Recommendation)
def reject(ctx: Editor, number: int, body: DecisionIn) -> dict[str, Any]:
    """Rejects a proposed recommendation (engineers, its proposer too: withdrawing it). Audited."""
    row = get(ctx, number, lock=True)
    _expect(row, "proposed")
    return _decide(ctx, row, "rejected", body.note)


def _decide(ctx: SiteContext, row: dict[str, Any], to: Status, note: str) -> dict[str, Any]:
    ctx.conn.execute(
        "UPDATE recommendations SET status = %s, decided_by_id = %s, decided_by = %s, decided_at = now(),"
        " decision_note = %s WHERE id = %s",
        [to, ctx.user.id, ctx.user.name, note, row["id"]],
    )
    ctx.audit(
        f"recommendation.{'approve' if to == 'approved' else 'reject'}",
        "recommendation",
        str(row["number"]),
        before={"status": row["status"]},
        after={"status": to, "note": note},
    )
    return _out(ctx, get(ctx, row["number"]))


@router.post("/sites/{site_id}/recommendations/{number}/applied", response_model=Recommendation)
def applied(ctx: Editor, number: int, body: AppliedIn) -> dict[str, Any]:
    """Records that the line applied an approved recommendation, by hand (engineers). Audited."""
    row = get(ctx, number, lock=True)
    _expect(row, "approved")
    at = body.at or datetime.now(UTC)
    if at < row["decided_at"]:
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "recommendation.applied_before_approval",
            "It can't have been applied before it was approved",
        )
    ctx.conn.execute(
        "UPDATE recommendations SET status = 'applied', applied_by = %s, applied_at = %s, applied_note = %s"
        " WHERE id = %s",
        [ctx.user.name, at, body.note, row["id"]],
    )
    ctx.audit(
        "recommendation.applied",
        "recommendation",
        str(number),
        before={"status": row["status"]},
        after={"status": "applied", "applied_at": at.isoformat(), "note": body.note},
    )
    return _out(ctx, get(ctx, number))


# ---- outcomes (T11.03) -----------------------------------------------------------------------


def relative(before: float | None, after: float | None) -> float | None:
    """How much `after` differs from `before`, as a share of `before`; None without both, or from 0."""
    if before is None or after is None or before == 0:
        return None
    return (after - before) / abs(before)


def _measured(ctx: SiteContext, signal_id: uuid.UUID, start: datetime, end: datetime) -> dict[str, Any]:
    row = one(
        ctx.conn.execute(
            "SELECT avg(value) AS mean, count(*) AS readings FROM site_samples"
            " WHERE signal_id = %s AND value IS NOT NULL AND at >= %s AND at < %s",
            [signal_id, start, end],
        ).fetchone()
    )
    return {"mean": None if row["mean"] is None else float(row["mean"]), "readings": int(row["readings"])}


def _rates(ctx: SiteContext, asset: str, start: datetime, end: datetime) -> dict[str, float]:
    """The asset's scrap events and unplanned stops a day (planned downtime left out, T7.03)."""
    rows = ctx.conn.execute(
        """
        SELECT g.event_kind AS kind, count(*) AS n
        FROM site_samples s JOIN signals g ON g.id = s.signal_id
        WHERE g.site_id = %(site)s AND g.asset = %(asset)s AND g.event_kind IN ('scrap', 'downtime')
          AND s.at >= %(start)s AND s.at < %(end)s
          AND coalesce(s.value <> 0, s.value_bool, s.value_text <> '')
          AND NOT (g.event_kind = 'downtime'
                   AND tiles_planned(g.site_id, g.asset, s.at,
                                     coalesce(s.value_text, s.value::text, s.value_bool::text)))
        GROUP BY g.event_kind
        """,
        {"site": ctx.site_id, "asset": asset, "start": start, "end": end},
    ).fetchall()
    days = max((end - start).total_seconds() / 86400, 1e-9)
    counts = {r["kind"]: int(r["n"]) for r in rows}
    return {"scrap": counts.get("scrap", 0) / days, "downtime": counts.get("downtime", 0) / days, "days": days}


@router.get("/sites/{site_id}/recommendations/{number}/outcome", response_model=Outcome)
def outcome(ctx: Ctx, number: int) -> dict[str, Any]:
    """What followed an applied recommendation against what the model expected: its outcome
    signal's mean, and the machine's scrap events and unplanned stops a day, over the days before it
    was applied and the days after (up to now: `collecting` until they have all passed)."""
    row = get(ctx, number)
    expected = row["expected"]
    now_value = expected["now"].get(row["objective"])
    proposed_value = expected["proposed"].get(row["objective"])
    out: dict[str, Any] = {
        "number": row["number"],
        "status": row["status"],
        "applied_at": row["applied_at"],
        "days": row["outcome_days"],
        "state": "not_applied",
        "objective": row["objective"],
        "expected_now": now_value,
        "expected_proposed": proposed_value,
        "expected_change": relative(now_value, proposed_value),
        "signal_tag": row["outcome_signal_tag"],
        "before": None,
        "after": None,
        "measured_change": None,
        "asset": row["asset"],
        "events_before": None,
        "events_after": None,
    }
    applied_at = row["applied_at"]
    if row["status"] != "applied" or applied_at is None:
        return out
    span = timedelta(days=row["outcome_days"])
    now = datetime.now(UTC)
    end = min(applied_at + span, now)
    out["state"] = "complete" if now >= applied_at + span else "collecting"
    if row["outcome_signal_id"] is not None:
        before = _measured(ctx, row["outcome_signal_id"], applied_at - span, applied_at)
        after = _measured(ctx, row["outcome_signal_id"], applied_at, end)
        out |= {"before": before, "after": after, "measured_change": relative(before["mean"], after["mean"])}
    if row["asset"] and end > applied_at:
        out["events_before"] = _rates(ctx, row["asset"], applied_at - span, applied_at)
        out["events_after"] = _rates(ctx, row["asset"], applied_at, end)
    return out


@router.put("/sites/{site_id}/recommendations/{number}/outcome", response_model=Recommendation)
def set_outcome(ctx: Editor, number: int, body: OutcomeIn) -> dict[str, Any]:
    """Sets the signal that measures a recommendation's outcome, and the days to judge it over
    (engineers), at any step. Audited."""
    row = get(ctx, number, lock=True)
    if body.signal_id is not None:
        _signal_of_site(ctx, body.signal_id)
    ctx.conn.execute(
        "UPDATE recommendations SET outcome_signal_id = %s, outcome_days = %s WHERE id = %s",
        [body.signal_id, body.days, row["id"]],
    )
    before = {"signal_id": str(row["outcome_signal_id"]) if row["outcome_signal_id"] else None}
    ctx.audit(
        "recommendation.outcome",
        "recommendation",
        str(number),
        before=before | {"days": row["outcome_days"]},
        after={"signal_id": str(body.signal_id) if body.signal_id else None, "days": body.days},
    )
    return _out(ctx, get(ctx, number))
