"""The graphene plant's working time: three eight-hour shifts (early 06:00-14:00, late 14:00-22:00,
night 22:00-06:00) from Monday morning to Saturday morning, three crews rotating each week, and no
shifts on England's bank holidays or in the Christmas and summer shutdowns. A night shift belongs to
the day it starts. Times are the plant's (Europe/London).
"""

import itertools
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from tiles_api.sample_plant.graphene.plant import END, START, ZONE

SHIFTS = (("E", 6), ("L", 14), ("N", 22))
CREWS = ("A", "B", "C")

# Bank holidays (England) and the shutdowns, as local dates: none of their shifts runs.
HOLIDAYS = {
    date(2025, 12, 25): "Christmas Day",
    date(2025, 12, 26): "Boxing Day",
    date(2026, 1, 1): "New Year's Day",
    date(2026, 4, 3): "Good Friday",
    date(2026, 4, 6): "Easter Monday",
    date(2026, 5, 4): "Early May bank holiday",
    date(2026, 5, 25): "Spring bank holiday",
    date(2026, 8, 31): "Summer bank holiday",
}
SHUTDOWNS = (
    (date(2025, 12, 19), date(2026, 1, 4), "Christmas shutdown"),  # the first and last days with no shift
    (date(2026, 8, 3), date(2026, 8, 9), "Summer shutdown"),
)


@dataclass(frozen=True)
class Shift:
    day: date  # the day it starts
    name: str  # E, L or N
    crew: str
    start: datetime
    end: datetime


def off_reason(day: date) -> str | None:
    """Why no shift runs on a day, or None."""
    for first, last, why in SHUTDOWNS:
        if first <= day <= last:
            return why
    if day in HOLIDAYS:
        return HOLIDAYS[day]
    if day.weekday() >= 5:
        return "Weekend: no shift planned"
    return None


def _local(day: date, hour: int) -> datetime:
    return datetime(day.year, day.month, day.day, hour, tzinfo=ZONE)


def shifts() -> list[Shift]:
    """Every shift worked in the year, in order."""
    out = []
    day = START.date()
    while _local(day, 0) < END:
        week = (day - date(2025, 9, 29)).days // 7  # crews rotate each week
        if off_reason(day) is None:
            for i, (name, hour) in enumerate(SHIFTS):
                start = _local(day, hour)
                nxt = day + timedelta(days=1)
                end = _local(nxt, 6) if name == "N" else _local(day, hour + 8)
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
    """The time between working stretches, with why: a weekend, a bank holiday or a shutdown."""
    out = []
    edges = [(START.timestamp(), START.timestamp()), *intervals, (END.timestamp(), END.timestamp())]
    for (_, a), (b, _) in itertools.pairwise(edges):
        if b - a < 60:
            continue
        reasons: list[str] = []  # in the order they come
        t = a
        while t < b:
            d = datetime.fromtimestamp(t, ZONE)
            why = off_reason((d - timedelta(hours=6)).date()) or "No shift planned"  # days run 06:00 to 06:00
            if why not in reasons:
                reasons.append(why)
            t += 3600 * 6
        named = [r for r in reasons if not r.startswith(("Weekend", "No shift"))]
        weekend = "Weekend: no shift planned"
        out.append((a, b, named[0] if named else weekend if weekend in reasons else "No shift planned"))
    return out
