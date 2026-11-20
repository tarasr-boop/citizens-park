"""The usual weekly pattern, for days the council's page does not cover.

Two sources, best first:

1. Learned: the newest month the council has published, as long as it is in
   the same season as the day in question. If Fridays in October were booked
   4 to 8 PM, a Friday in November is probably the same.
2. ``schedule.toml``: a hand-written pattern for each season.
"""

from __future__ import annotations

import calendar
import tomllib
from collections import Counter
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from .council import DayEntry
from .timeparse import Slot, merge

_WEEKDAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

# How far back a published month may be and still teach us the pattern.
_MAX_MONTHS_BACK = 6
# A weekday needs at least this many plain days in a month before we trust it.
_MIN_SAMPLES = 2


class ScheduleError(Exception):
    """``schedule.toml`` could not be read."""


@dataclass(frozen=True)
class Season:
    name: str
    months: frozenset[int]
    week: tuple[tuple[Slot, ...], ...]  # seven entries, Monday first
    source: str
    rough: bool


@dataclass(frozen=True)
class Usual:
    """The usual bookings for one day, and where that belief comes from."""

    slots: tuple[Slot, ...]
    learned: bool  # True when worked out from a month the council published
    rough: bool  # True when the times are only a guess
    source: str  # words for people, such as "the council's October 2026 schedule"


def load_seasons(path: str | Path = "schedule.toml") -> list[Season]:
    try:
        with open(path, "rb") as handle:
            raw = tomllib.load(handle)
    except FileNotFoundError:
        return []
    except tomllib.TOMLDecodeError as error:
        raise ScheduleError(f"{path} is not valid TOML: {error}") from error

    seasons: list[Season] = []
    try:
        for entry in raw.get("season", []):
            week_raw = entry.get("week", {})
            unknown = set(week_raw) - set(_WEEKDAY_KEYS)
            if unknown:
                raise ScheduleError(f"{path}: unknown weekday {sorted(unknown)[0]!r} (use mon, tue, wed, thu, fri, sat, sun)")
            week = tuple(merge([Slot.from_text(text) for text in week_raw.get(key, [])]) for key in _WEEKDAY_KEYS)
            months = frozenset(int(month) for month in entry["months"])
            if not months or not months <= set(range(1, 13)):
                raise ScheduleError(f"{path}: months must be numbers from 1 to 12")
            seasons.append(
                Season(
                    name=str(entry.get("name", "season")),
                    months=months,
                    week=week,
                    source=str(entry.get("source", "the usual weekly pattern")),
                    rough=bool(entry.get("rough", False)),
                )
            )
    except (KeyError, TypeError, ValueError) as error:
        raise ScheduleError(f"{path}: {error}") from error
    return seasons


def season_for(month: int, seasons: list[Season]) -> Season | None:
    for season in seasons:
        if month in season.months:
            return season
    return None


def _learn(day: date, council_days: dict[date, DayEntry], season: Season | None) -> Usual | None:
    """Work out the usual slots for ``day``'s weekday from the newest published month."""
    by_month: dict[tuple[int, int], list[date]] = {}
    for known in council_days:
        by_month.setdefault((known.year, known.month), []).append(known)

    target = day.year * 12 + day.month
    for year, month in sorted(by_month, reverse=True):
        age = target - (year * 12 + month)
        if age < 0:
            continue  # a later month says nothing about an earlier one
        if age > _MAX_MONTHS_BACK:
            break
        if season is not None and month not in season.months:
            break  # the newest month is from the other season: nothing to learn
        if season is None and age > 1:
            break
        if len(by_month[(year, month)]) < 14:
            continue  # a scrap of a month is not a pattern

        # Days with a label ("Maintenance") are one-offs, so they teach nothing.
        samples = [
            (known, council_days[known].slots)
            for known in sorted(by_month[(year, month)])
            if known.weekday() == day.weekday() and not council_days[known].label
        ]
        if len(samples) < _MIN_SAMPLES:
            continue
        counts = Counter(slots for _known, slots in samples)
        top = max(counts.values())
        # On a tie, the most recent week wins.
        slots = next(slots for _known, slots in reversed(samples) if counts[slots] == top)
        return Usual(merge(slots), True, False, f"the council's {calendar.month_name[month]} {year} schedule")
    return None


def usual_for(day: date, council_days: dict[date, DayEntry], seasons: list[Season]) -> Usual | None:
    """The usual bookings for ``day``, or None when there is nothing to go on."""
    season = season_for(day.month, seasons)
    learned = _learn(day, council_days, season)
    if learned is not None:
        return learned
    if season is not None:
        return Usual(season.week[day.weekday()], False, season.rough, season.source)
    return None
