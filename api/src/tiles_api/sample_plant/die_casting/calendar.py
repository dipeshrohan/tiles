"""The plant's working time: three shifts from Sunday night to Saturday morning, a Saturday early
shift in busy months, and no shifts on public holidays or in the two shutdowns. Times are the
plant's (Europe/Berlin): a shift starting at 22:00 on the night the clocks change is an hour longer
or shorter, as it is on the line.
"""

import itertools
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from tiles_api.sample_plant.die_casting.plant import END, START, ZONE

SHIFTS = (("N", 22), ("E", 6), ("L", 14))  # night (from the evening before), early, late
CREWS = ("A", "B", "C")

# Public holidays (Germany, those of every state) and the plant's shutdowns, as local dates: none of
# their production day's shifts runs (its night shift starts the evening before; the night shift
# starting on the holiday's evening belongs to the next day, and runs).
HOLIDAYS = {
    date(2025, 10, 3): "German Unity Day",
    date(2026, 4, 3): "Good Friday",
    date(2026, 4, 6): "Easter Monday",
    date(2026, 5, 1): "Labour Day",
    date(2026, 5, 14): "Ascension Day",
    date(2026, 5, 25): "Whit Monday",
}
SHUTDOWNS = (
    (date(2025, 12, 23), date(2026, 1, 4), "Christmas shutdown"),  # the last day with no shift
    (date(2026, 8, 3), date(2026, 8, 16), "Summer shutdown"),
)
QUIET_MONTHS = (7, 8, 12)  # no Saturday shift


@dataclass(frozen=True)
class Shift:
    day: date  # the production day it belongs to (a night shift: the next morning's)
    name: str  # N, E or L
    crew: str
    start: datetime
    end: datetime


def off_reason(day: date) -> str | None:
    """Why no shift runs on a production day, or None."""
    if day in HOLIDAYS:
        return HOLIDAYS[day]
    for first, last, why in SHUTDOWNS:
        if first <= day <= last:
            return why
    return None


def _local(day: date, hour: int) -> datetime:
    return datetime(day.year, day.month, day.day, hour, tzinfo=ZONE)


def _worked(day: date, name: str) -> bool:
    if off_reason(day):
        return False
    weekday = day.weekday()  # Monday 0
    if weekday < 5:
        return True
    if weekday == 5:  # Saturday: Friday's night shift, and the early shift in busy months
        return name == "N" or (name == "E" and day.month not in QUIET_MONTHS)
    return False


def shifts() -> list[Shift]:
    """Every shift worked in the year, in order."""
    out = []
    day = START.date()
    while _local(day, 0) < END:
        week = (day - date(2025, 9, 29)).days // 7  # crews rotate each week
        for i, (name, hour) in enumerate(SHIFTS):
            if not _worked(day, name):
                continue
            start = _local(day - timedelta(days=1), hour) if name == "N" else _local(day, hour)
            end = _local(day, 6) if name == "N" else _local(day, hour + 8)
            if start < START or end > END:
                continue
            out.append(Shift(day, name, CREWS[(week + i) % 3], start, end))
        day += timedelta(days=1)
    return out


def working_intervals(all_shifts: list[Shift]) -> list[tuple[float, float]]:
    """The shifts joined into unbroken stretches of working time, in epoch seconds."""
    out: list[tuple[float, float]] = []
    for s in all_shifts:
        a, b = s.start.timestamp(), s.end.timestamp()
        if out and abs(out[-1][1] - a) < 1:
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


def gaps(intervals: list[tuple[float, float]]) -> list[tuple[float, float, str]]:
    """The time between working stretches, with why: a weekend, a holiday or a shutdown."""
    out = []
    edges = [(START.timestamp(), START.timestamp()), *intervals, (END.timestamp(), END.timestamp())]
    for (_, a), (b, _) in itertools.pairwise(edges):
        if b - a < 60:
            continue
        reasons = set()
        t = a
        while t < b:
            d = datetime.fromtimestamp(t, ZONE)
            prod_day = (d + timedelta(hours=2)).date()  # the production day it falls in
            r = off_reason(prod_day)
            reasons.add(r or "Weekend: no shift planned")
            t += 3600 * 6
        named = sorted(r for r in reasons if not r.startswith("Weekend"))
        weekend = any(datetime.fromtimestamp(x, ZONE).weekday() >= 5 for x in (a, (a + b) / 2, b))
        out.append((a, b, named[0] if named else "Weekend: no shift planned" if weekend else "No shift planned"))
    return out
