"""The biologics site's working time: around the clock, four crews on twelve-hour shifts (day
07:00-19:00, night 19:00-07:00) on a 2-2-3 rotation, stopping only for a fortnight's annual
shutdown in the summer. Cell culture can't stop, so the plant never closes for public holidays.
Times are the site's (Europe/Dublin): the night shifts the clocks change in are an hour longer or
shorter.
"""

import itertools
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from tiles_api.sample_plant.biologics.plant import END, START, ZONE

# Which crews work a day's shifts: day A or C, night B or D, by a 14-day 2-2-3 pattern.
PATTERN = (1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0)
REFERENCE = date(2025, 9, 29)  # a Monday the rotation starts on

SHUTDOWN = (
    datetime(2026, 7, 27, 7, tzinfo=ZONE),
    datetime(2026, 8, 10, 7, tzinfo=ZONE),
    "Annual shutdown: maintenance, requalification and the media fill",
)
SHUTDOWNS = (SHUTDOWN,)


@dataclass(frozen=True)
class Shift:
    day: date
    name: str  # D (day) or N (night)
    crew: str
    start: datetime
    end: datetime


def shifts() -> list[Shift]:
    """Every shift worked in the year, in order (the shutdown's shifts aren't)."""
    out = []
    day = START.date() - timedelta(days=1)  # its night shift is the year's first hours
    while datetime(day.year, day.month, day.day, tzinfo=ZONE) < END:
        on = PATTERN[(day - REFERENCE).days % 14]
        for name, hour, crew in (("D", 7, "A" if on else "C"), ("N", 19, "B" if on else "D")):
            start = datetime(day.year, day.month, day.day, hour, tzinfo=ZONE)
            nxt = day + timedelta(days=1) if name == "N" else day
            end = datetime(nxt.year, nxt.month, nxt.day, 7 if name == "N" else 19, tzinfo=ZONE)
            if start < START:
                # The year starts at midnight, in the night shift of the day before.
                start = START
            if end > END:
                end = END
            if start >= end or any(a <= start < b for a, b, _ in SHUTDOWNS):
                continue
            out.append(Shift(day, name, crew, start, end))
        day += timedelta(days=1)
    return out


def working_intervals(all_shifts: list[Shift]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for s in all_shifts:
        a, b = s.start.timestamp(), s.end.timestamp()
        if out and abs(out[-1][1] - a) < 1:
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


def gaps(intervals: list[tuple[float, float]]) -> list[tuple[float, float, str]]:
    """The time without shifts, with why (the shutdown)."""
    out = []
    edges = [(START.timestamp(), START.timestamp()), *intervals, (END.timestamp(), END.timestamp())]
    for (_, a), (b, _) in itertools.pairwise(edges):
        if b - a < 60:
            continue
        why = next((w for s, e, w in SHUTDOWNS if s.timestamp() <= a < e.timestamp()), "No shift planned")
        out.append((a, b, why))
    return out
