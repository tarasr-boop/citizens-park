"""Decide what to say about each day, and how sure we are.

For every day there are four possible grounds, best first:

* ``council``: the day is on the council's page. Trusted.
* ``usual``:   the page does not cover the day, so the usual weekly pattern
               stands in. Clearly marked as not confirmed.
* ``rough``:   the usual pattern itself is only a guess (see schedule.toml).
* ``none``:    nothing to go on.

A closure notice on the council's page (turf works, for example) overrides
all of them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from .pattern import Season, usual_for
from .store import CouncilStore
from .timeparse import MINUTES_PER_DAY, Slot, clock, merge

# After this many days without a successful read, council data is called out as old.
_FRESH_DAYS = 1


@dataclass(frozen=True)
class DayPlan:
    day: date
    slots: tuple[Slot, ...]  # booked periods, sorted, not overlapping
    basis: str  # "council", "usual", "rough" or "none"
    closed: bool = False  # closed all day by a council notice
    label: str = ""  # "Maintenance", or the words of the closure notice
    note: str = ""  # one sentence for people: where this comes from

    @property
    def confirmed(self) -> bool:
        return self.basis == "council"

    @property
    def known(self) -> bool:
        return self.basis != "none"


def short_date(day: date) -> str:
    """``Fri 20 Nov``"""
    return f"{day:%a} {day.day} {day:%b}"


def long_date(day: date) -> str:
    """``31 October``"""
    return f"{day.day} {day:%B}"


def _closure_for(day: date, store: CouncilStore, day_start: int, lights_off: int) -> tuple[bool, tuple[Slot, ...], str]:
    """How council closure notices affect ``day``: (closed all day, closed periods, notice text)."""
    midnight = datetime(day.year, day.month, day.day)
    closed_slots: list[Slot] = []
    text = ""
    for closure in store.closures:
        start = max(closure.start, midnight)
        end = min(closure.end, midnight + timedelta(days=1))
        if end <= start:
            continue
        first = int((start - midnight).total_seconds() // 60)
        last = int((end - midnight).total_seconds() // 60)
        if last <= day_start or first >= lights_off:
            continue  # only touches the small hours
        closed_slots.append(Slot(first, min(last, MINUTES_PER_DAY)))
        text = text or closure.text
    merged = merge(closed_slots)
    all_day = any(slot.start <= day_start and slot.end >= lights_off for slot in merged)
    return all_day, merged, text


def _why_not_confirmed(day: date, store: CouncilStore) -> str:
    latest = store.latest_day
    if latest is None:
        return "The council's page could not be read."
    if day > latest:
        return f"The council's page only goes up to {long_date(latest)}."
    return "The council's page does not list this day."


def plan_day(
    day: date,
    store: CouncilStore,
    seasons: list[Season],
    today: date,
    day_start: int = 6 * 60,
    lights_off: int = 22 * 60,
) -> DayPlan:
    """Work out one day."""
    closed, closed_slots, closure_text = _closure_for(day, store, day_start, lights_off)
    if closed:
        return DayPlan(day, (Slot(0, MINUTES_PER_DAY),), "council", True, closure_text, "From a notice on the council's page.")

    entry = store.days.get(day)
    if entry is not None:
        note = "From the council's schedule."
        if store.last_read and (today - store.last_read).days > _FRESH_DAYS:
            note = f"From the council's schedule, last read on {short_date(store.last_read)}."
        label = entry.label or (closure_text if closed_slots else "")
        return DayPlan(day, merge(list(entry.slots) + list(closed_slots)), "council", False, label, note)

    usual = usual_for(day, store.days, seasons)
    if usual is not None:
        why = _why_not_confirmed(day, store)
        if usual.rough:
            return DayPlan(
                day,
                merge(list(usual.slots) + list(closed_slots)),
                "rough",
                False,
                closure_text if closed_slots else "",
                f"Rough guide only, based on {usual.source}. {why}",
            )
        return DayPlan(
            day,
            merge(list(usual.slots) + list(closed_slots)),
            "usual",
            False,
            closure_text if closed_slots else "",
            f"Usual pattern only, not confirmed. {why}",
        )

    if closed_slots:
        return DayPlan(day, closed_slots, "council", False, closure_text, "From a notice on the council's page.")
    return DayPlan(day, (), "none", False, "", f"No booking information for this day. {_why_not_confirmed(day, store)}")


def plan_days(
    first: date,
    count: int,
    store: CouncilStore,
    seasons: list[Season],
    day_start: int = 6 * 60,
    lights_off: int = 22 * 60,
) -> list[DayPlan]:
    return [plan_day(first + timedelta(days=offset), store, seasons, first, day_start, lights_off) for offset in range(count)]


# --------------------------------------------------------------------------
# Sentences shared by the Telegram post and the page
# --------------------------------------------------------------------------


def free_windows(slots: tuple[Slot, ...], from_minute: int, until_minute: int) -> list[tuple[int, int]]:
    """The gaps between bookings from ``from_minute`` to ``until_minute``, as (start, end) pairs."""
    windows: list[tuple[int, int]] = []
    cursor = from_minute
    for slot in slots:
        if slot.end <= cursor:
            continue
        if slot.start > cursor:
            windows.append((cursor, min(slot.start, until_minute)))
        cursor = max(cursor, slot.end)
        if cursor >= until_minute:
            break
    if cursor < until_minute:
        windows.append((cursor, until_minute))
    return [(start, end) for start, end in windows if end - start >= 15]


def free_text(slots: tuple[Slot, ...], now_minute: int, lights_off: int) -> str:
    """Free periods for the rest of the day in words: ``until 4:15 PM, then from 7:30 PM``."""
    windows = free_windows(slots, now_minute, lights_off)
    parts: list[str] = []
    for start, end in windows:
        if start <= now_minute and end >= lights_off:
            return "for the rest of today"
        if start <= now_minute:
            parts.append(f"until {clock(end)}")
        elif end >= lights_off:
            parts.append(f"from {clock(start)}")
        else:
            parts.append(f"{clock(start)} to {clock(end)}")
    if not parts:
        return ""
    return ", then ".join(parts)
