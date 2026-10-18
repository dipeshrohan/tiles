"""The battery plant's working time: around the clock, four crews on twelve-hour shifts (day
06:00-18:00, night 18:00-06:00) on a 2-2-3 rotation, stopping only for Christmas, New Year and a
week's summer maintenance. Times are the plant's (Europe/Stockholm): the night shifts the clocks
change in are an hour longer or shorter.
"""

import itertools
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from tiles_api.sample_plant.battery.plant import END, START, ZONE

# Which crews work a day's shifts: day A or C, night B or D, by a 14-day 2-2-3 pattern.
PATTERN = (1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0)
REFERENCE = date(2025, 9, 29)  # a Monday the rotation starts on

SHUTDOWNS = (
    (datetime(2025, 12, 24, 6, tzinfo=ZONE), datetime(2025, 12, 27, 6, tzinfo=ZONE), "Christmas"),
    (datetime(2025, 12, 31, 18, tzinfo=ZONE), datetime(2026, 1, 2, 6, tzinfo=ZONE), "New Year"),
    (datetime(2026, 7, 27, 6, tzinfo=ZONE), datetime(2026, 8, 3, 6, tzinfo=ZONE), "Summer maintenance shutdown"),
)


@dataclass(frozen=True)
class Shift:
    day: date
    name: str  # D (day) or N (night)
    crew: str
    start: datetime
    end: datetime


def shifts() -> list[Shift]:
    """Every shift worked in the year, in order (a shutdown's shifts aren't)."""
    out = []
    day = START.date()
    while datetime(day.year, day.month, day.day, tzinfo=ZONE) < END:
        on = PATTERN[(day - REFERENCE).days % 14]
        for name, hour, crew in (("D", 6, "A" if on else "C"), ("N", 18, "B" if on else "D")):
            start = datetime(day.year, day.month, day.day, hour, tzinfo=ZONE)
            nxt = day + timedelta(days=1) if name == "N" else day
            end = datetime(nxt.year, nxt.month, nxt.day, 6 if name == "N" else 18, tzinfo=ZONE)
            if start < START or end > END:
                continue
            if any(a <= start < b for a, b, _ in SHUTDOWNS):
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
    """The time without shifts, with why (a shutdown, or the year's first and last hours)."""
    out = []
    edges = [(START.timestamp(), START.timestamp()), *intervals, (END.timestamp(), END.timestamp())]
    for (_, a), (b, _) in itertools.pairwise(edges):
        if b - a < 60:
            continue
        why = next((w for s, e, w in SHUTDOWNS if s.timestamp() <= a < e.timestamp()), "No shift planned")
        out.append((a, b, why))
    return out
