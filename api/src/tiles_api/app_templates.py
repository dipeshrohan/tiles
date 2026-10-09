"""App Studio templates (T6.10): a use case written once, configured many times without code.

A template has typed, bounded parameters, which the browser turns into a form (`GET
/app-templates`), and a `run` that answers for one configured app: a status, a sentence, and a
chart (the signal's points, reference levels and shaded stretches) with its numbers. An app (a
row of `apps`, api_apps.py) is a template's version and its configuration on a site's signal.
Adding a use case is configuring an app; adding a kind of use case is registering a template here.

v0 has two: the wear check (wear.py, T3.13) and an SPC chart (spc.py).
"""

import math
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal

from pydantic import ValidationError

from tiles_api import api_series, spc
from tiles_api.api_ontology import SiteContext
from tiles_api.api_wear import WearIn, run_check
from tiles_api.notify import number_text

Kind = Literal["signal", "number", "integer", "choice", "choices"]
Status = Literal["ok", "alert", "no_data"]


@dataclass(frozen=True)
class Param:
    """One setting of a template, as the form shows it."""

    name: str
    label: str
    kind: Kind
    default: Any = None
    minimum: float | None = None
    maximum: float | None = None
    choices: tuple[tuple[str, str], ...] = ()  # (value, label)
    optional: bool = False  # may be left empty (null)
    help: str = ""


@dataclass(frozen=True)
class Template:
    id: str
    version: int
    title: str
    summary: str
    params: tuple[Param, ...]
    run: Callable[[SiteContext, dict[str, Any]], dict[str, Any]] = field(repr=False)
    # Checks across settings (the parameters' own bounds are checked first): raises ConfigError.
    check: Callable[[dict[str, Any]], None] | None = field(default=None, repr=False)

    def describe(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "version": self.version,
            "title": self.title,
            "summary": self.summary,
            "params": [{**asdict(p), "choices": [list(c) for c in p.choices]} for p in self.params],
        }


TEMPLATES: dict[str, Template] = {}


def register(template: Template) -> Template:
    if template.id in TEMPLATES:
        raise ValueError(f"template {template.id} is registered twice")
    TEMPLATES[template.id] = template
    return template


class ConfigError(ValueError):
    """A configuration the template can't take: `problems` say what to fix, one per setting."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


def check_config(template: Template, config: dict[str, Any]) -> dict[str, Any]:
    """The configuration with defaults filled in, every value of the kind and in the bounds its
    parameter says; ConfigError otherwise. Unknown settings are refused, not dropped."""
    problems: list[str] = []
    known = {p.name for p in template.params}
    problems += [f"{name}: {template.title} has no such setting" for name in sorted(set(config) - known)]
    clean: dict[str, Any] = {}
    for p in template.params:
        value = config.get(p.name, p.default)
        if value is None:
            if not p.optional:
                problems.append(f"{p.name}: {p.label} is needed")
            clean[p.name] = None
            continue
        try:
            clean[p.name] = _value(p, value)
        except ValueError as e:
            problems.append(f"{p.name}: {e}")
    if problems:
        raise ConfigError(problems)
    if template.check:
        template.check(clean)
    return clean


def _value(p: Param, value: Any) -> Any:
    if p.kind == "signal":
        try:
            return str(uuid.UUID(str(value)))
        except ValueError:
            raise ValueError("choose a signal") from None
    if p.kind in ("number", "integer"):
        if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
            raise ValueError(f"{p.label} must be a number")
        if p.kind == "integer" and value != int(value):
            raise ValueError(f"{p.label} must be a whole number")
        if (p.minimum is not None and value < p.minimum) or (p.maximum is not None and value > p.maximum):
            raise ValueError(f"{p.label} must be from {number_text(p.minimum or 0)} to {number_text(p.maximum or 0)}")
        return int(value) if p.kind == "integer" else float(value)
    allowed = [c[0] for c in p.choices]
    if p.kind == "choice":
        if value not in allowed:
            raise ValueError(f"{p.label} must be one of {', '.join(allowed)}")
        return value
    if not isinstance(value, list) or not value or any(v not in allowed for v in value):
        raise ValueError(f"{p.label}: choose at least one of {', '.join(allowed)}")
    return [c for c in allowed if c in value]  # in the template's order, once each


def result(
    *,
    status: Status,
    headline: str,
    text: str,
    signal: dict[str, Any],
    start: datetime,
    end: datetime,
    points: list[dict[str, Any]],
    gap_seconds: float,
    levels: list[dict[str, Any]] | None = None,
    spans: list[dict[str, Any]] | None = None,
    facts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """What every template answers: the status and words, and the chart with its facts."""
    return {
        "status": status,
        "headline": headline,
        "text": text,
        "signal_id": signal["id"],
        "tag": signal["tag"],
        "unit": signal["unit"],
        "start": start,
        "end": end,
        "gap_seconds": gap_seconds,
        "points": points,
        "levels": levels or [],
        "spans": spans or [],
        "facts": facts or [],
    }


def _signal(ctx: SiteContext, config: dict[str, Any]) -> dict[str, Any]:
    return api_series.site_signal(ctx, uuid.UUID(config["signal"]))


# ---- wear check -------------------------------------------------------------------------------


def wear_in(config: dict[str, Any]) -> WearIn:
    """The wear check's own settings, which also check the windows against the buckets."""
    try:
        return WearIn(
            recent_hours=config["recent_hours"],
            baseline_hours=config["baseline_hours"],
            bucket_minutes=config["bucket_minutes"],
            direction=config["direction"],
            threshold=config["threshold_percent"] / 100,
            limit=config["limit"],
        )
    except ValidationError as e:
        raise ConfigError([str(err["msg"]).removeprefix("Value error, ") for err in e.errors()]) from None


def check_wear(config: dict[str, Any]) -> None:
    wear_in(config)


def run_wear(ctx: SiteContext, config: dict[str, Any]) -> dict[str, Any]:
    signal = _signal(ctx, config)
    out = run_check(ctx, signal["id"], wear_in(config), signal)
    statuses: dict[str, Status] = {"wearing": "alert", "stable": "ok", "not_enough_data": "no_data"}
    status = statuses[out["verdict"]]
    headline = {"alert": "Wearing", "ok": "Stable", "no_data": "Not enough readings"}[status]
    levels = [{"label": "baseline", "value": out["baseline"]}] if out["baseline"] is not None else []
    if config["limit"] is not None:
        levels.append({"label": "limit", "value": config["limit"]})
    facts = [
        {"label": "Change from the baseline", "value": out["change"], "format": "percent"},
        {"label": "Slope a day", "value": out["slope_per_day"], "format": "number"},
        {"label": "Hours to the limit", "value": out["hours_to_limit"], "format": "number"},
    ]
    return result(
        status=status,
        headline=headline,
        text=out["text"],
        signal=signal,
        start=out["start"],
        end=out["end"],
        points=[{"at": b["at"], "value": b["value"]} for b in out["buckets"]],
        gap_seconds=config["bucket_minutes"] * 60 * 1.5,
        levels=levels,
        spans=[{"from": out["recent_from"], "to": out["end"], "label": "recent window"}],
        facts=[f for f in facts if f["value"] is not None],
    )


WEAR = register(
    Template(
        id="wear-check",
        version=1,
        title="Wear check",
        summary=(
            "Has a signal's level moved from its baseline, as a wearing tool's does, and when will it reach a limit?"
        ),
        params=(
            Param("signal", "Signal", "signal", help="A tool's power, current or force"),
            Param("recent_hours", "Recent window (hours)", "number", 24, 1, 24 * 30),
            Param("baseline_hours", "Baseline before it (hours)", "number", 72, 1, 24 * 90),
            Param("bucket_minutes", "Bucket (minutes)", "number", 60, 1, 24 * 60, help="Each bucket is a median"),
            Param(
                "direction",
                "Wear moves it",
                "choice",
                "either",
                choices=(("up", "up"), ("down", "down"), ("either", "either way")),
            ),
            Param("threshold_percent", "Change that counts (%)", "number", 5, 0.1, 1000),
            Param("limit", "Worn-out level", "number", None, optional=True, help="Leave empty for none"),
        ),
        run=run_wear,
        check=check_wear,
    )
)


# ---- SPC chart -------------------------------------------------------------------------------

SPC_POINTS = """
SELECT time_bucket(%(width)s * interval '1 second', at, %(start)s::timestamptz) AS at,
       avg(coalesce(value, value_bool::int)) AS value
FROM site_samples
WHERE signal_id = %(id)s AND at >= %(start)s AND at < %(end)s AND coalesce(value, value_bool::int) IS NOT NULL
GROUP BY 1 ORDER BY 1
"""
MAX_SPC_POINTS = 5_000


def check_spc(config: dict[str, Any]) -> None:
    if (config["baseline_hours"] + config["recent_hours"]) * 60 / config["bucket_minutes"] > MAX_SPC_POINTS:
        raise ConfigError([f"At most {MAX_SPC_POINTS} points: choose longer buckets or shorter windows"])


def run_spc(ctx: SiteContext, config: dict[str, Any]) -> dict[str, Any]:
    signal = _signal(ctx, config)
    width = config["bucket_minutes"] * 60
    end = api_series.latest_end(ctx, signal["id"])
    recent_from = end - timedelta(hours=config["recent_hours"])
    start = recent_from - timedelta(hours=config["baseline_hours"])
    rows = ctx.conn.execute(SPC_POINTS, {"width": width, "start": start, "end": end, "id": signal["id"]}).fetchall()
    baseline = [float(r["value"]) for r in rows if r["at"] < recent_from]
    recent = [r for r in rows if r["at"] >= recent_from]
    lim = spc.limits(baseline, config["sigmas"])
    points = [{"at": r["at"], "value": float(r["value"])} for r in rows]
    base = {
        "signal": signal,
        "start": start,
        "end": end,
        "points": points,
        "gap_seconds": width * 1.5,
        "spans": [],
    }
    if lim is None or not recent:
        return result(
            status="no_data",
            headline="Not enough readings",
            text=(
                f"Not enough readings: {len(baseline)} baseline bucket(s) (at least {spc.MIN_BASELINE}, "
                f"not all the same) and {len(recent)} recent one(s) (at least 1)."
            ),
            **base,
        )
    found = spc.violations([float(r["value"]) for r in recent], lim, config["rules"])
    unit = f" {signal['unit']}" if signal["unit"] else ""
    level = [
        {"label": "centre", "value": lim.centre},
        {"label": "upper limit", "value": lim.upper},
        {"label": "lower limit", "value": lim.lower},
    ]
    spans = [
        {
            "from": recent[v.index]["at"],
            "to": recent[v.index]["at"] + timedelta(seconds=width),
            "label": spc.RULE_TEXT[v.rule],
        }
        for v in found
    ]
    limits_text = (
        f"the centre is {number_text(lim.centre)}{unit} and the limits {number_text(lim.lower)} to "
        f"{number_text(lim.upper)}{unit} ({number_text(config['sigmas'])} sigma), from {len(baseline)} baseline buckets"
    )
    if found:
        kinds = sorted({v.rule for v in found}, key=spc.RULES.index)
        text = (
            f"Out of control: {len(found)} signal(s) in the recent {len(recent)} buckets "
            f"({'; '.join(spc.RULE_TEXT[k] for k in kinds)}); {limits_text}."
        )
    else:
        text = f"In control: no rule broken in the recent {len(recent)} buckets; {limits_text}."
    return result(
        status="alert" if found else "ok",
        headline="Out of control" if found else "In control",
        text=text,
        levels=level,
        facts=[
            {"label": "Signals", "value": len(found), "format": "number"},
            {"label": "Sigma", "value": lim.sigma, "format": "number"},
        ],
        **{**base, "spans": spans},
    )


SPC = register(
    Template(
        id="spc-limits",
        version=1,
        title="SPC limits",
        summary=(
            "Is the process in control? A control chart of a signal, with limits from a baseline and the "
            "Western Electric rules."
        ),
        params=(
            Param("signal", "Signal", "signal", help="A process value: a temperature, a pressure, a dimension"),
            Param("bucket_minutes", "Point every (minutes)", "number", 60, 1, 24 * 60, help="Each point is a mean"),
            Param("baseline_hours", "Baseline (hours)", "number", 7 * 24, 1, 24 * 90, help="When it was in control"),
            Param("recent_hours", "Recent window (hours)", "number", 24, 1, 24 * 30),
            Param("sigmas", "Limits at (sigma)", "number", 3, 1, 6),
            Param(
                "rules",
                "Rules",
                "choices",
                list(spc.RULES),
                choices=tuple((r, spc.RULE_TEXT[r]) for r in spc.RULES),
            ),
        ),
        run=run_spc,
        check=check_spc,
    )
)
