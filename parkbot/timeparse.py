"""Booked periods, and the many ways people write them.

The council writes times such as ``5:15pm-7:30pm``, ``4pm-8pm`` or
``10:00am - 6:00pm``. This module turns that text into :class:`Slot` objects
(minutes after midnight) and turns slots back into text for people.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

MINUTES_PER_DAY = 24 * 60


@dataclass(frozen=True, order=True)
class Slot:
    """One booked period on one day, in minutes after midnight."""

    start: int
    end: int

    def __post_init__(self) -> None:
        if not (0 <= self.start < self.end <= MINUTES_PER_DAY):
            raise ValueError(f"not a valid period: {self.start} to {self.end}")

    def to_text(self) -> str:
        """Machine form, such as ``16:15-19:30``."""
        return f"{hhmm(self.start)}-{hhmm(self.end)}"

    @classmethod
    def from_text(cls, text: str) -> "Slot":
        """Read the machine form written by :meth:`to_text`."""
        match = re.fullmatch(r"\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*", text)
        if not match:
            raise ValueError(f"expected HH:MM-HH:MM, got {text!r}")
        h1, m1, h2, m2 = (int(part) for part in match.groups())
        if m1 > 59 or m2 > 59:
            raise ValueError(f"expected HH:MM-HH:MM, got {text!r}")
        return cls(h1 * 60 + m1, h2 * 60 + m2)


def hhmm(minutes: int) -> str:
    """Minutes after midnight as ``HH:MM``."""
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def parse_hhmm(text: str) -> int:
    """``HH:MM`` as minutes after midnight."""
    match = re.fullmatch(r"\s*(\d{1,2}):(\d{2})\s*", text)
    if not match:
        raise ValueError(f"expected HH:MM, got {text!r}")
    hours, minutes = int(match.group(1)), int(match.group(2))
    if hours > 24 or minutes > 59 or hours * 60 + minutes > MINUTES_PER_DAY:
        raise ValueError(f"expected HH:MM, got {text!r}")
    return hours * 60 + minutes


# --------------------------------------------------------------------------
# Reading times written by people
# --------------------------------------------------------------------------

_TIME = r"""
    (?:
        (?P<word{n}>noon|midday|midnight)
      |
        (?P<h{n}>\d{{1,2}})
        (?:[:.](?P<m{n}>\d{{2}}))?
        \s*
        (?P<ap{n}>a\.?m\.?|p\.?m\.?)?
        (?![a-z0-9])
    )
"""

_RANGE = re.compile(
    r"(?<![\d:.])" + _TIME.format(n=1) + r"\s*(?:-|–|—|−|\bto\b|\buntil\b|\btill\b)\s*" + _TIME.format(n=2),
    re.IGNORECASE | re.VERBOSE,
)

_JOINERS = re.compile(r"^(?:and|&|\+|,|;|/|\||-|–|—)+$", re.IGNORECASE)


def _minutes(hour: int, minute: int, half: str | None) -> int:
    """Hour and minute as minutes after midnight. ``half`` is 'a', 'p' or None (24-hour)."""
    if half == "a":
        hour = 0 if hour == 12 else hour
    elif half == "p":
        hour = hour if hour == 12 else hour + 12
    return hour * 60 + minute


def _resolve(match: re.Match[str]) -> tuple[int, int] | None:
    """Work out one matched range. Returns None when the text is not a sensible period."""
    parts = []
    for n in ("1", "2"):
        word = match.group("word" + n)
        if word:
            word = word.lower()
            # "midnight" opens a range at 0:00 and closes one at 24:00.
            parts.append((0 if n == "1" else 24, 0, None, True) if word == "midnight" else (12, 0, None, True))
            continue
        hour = int(match.group("h" + n))
        minute = int(match.group("m" + n) or 0)
        half = match.group("ap" + n)
        parts.append((hour, minute, half[0].lower() if half else None, False))

    (h1, m1, a1, fixed1), (h2, m2, a2, fixed2) = parts
    if h1 > 24 or h2 > 24 or m1 > 59 or m2 > 59:
        return None
    for hour, half in ((h1, a1), (h2, a2)):
        if half and not 1 <= hour <= 12:  # "13pm" is not a time
            return None

    if fixed1 or fixed2 or (a1 and a2):
        start = _minutes(h1, m1, a1)
        end = _minutes(h2, m2, a2)
        # A word such as "noon" settles one end; the other end may still lack am or pm.
        if fixed1 and not fixed2 and not a2 and h2 <= 12 and end <= start:
            end = _minutes(h2, m2, "p")
        if fixed2 and not fixed1 and not a1 and h1 <= 12 and start >= end:
            start = _minutes(h1, m1, "a")
    elif a2:
        # "4-8pm": the start shares the end's half of the day, unless that puts it after the end.
        end = _minutes(h2, m2, a2)
        start = _minutes(h1, m1, a2)
        if start >= end and 1 <= h1 <= 12:
            start = _minutes(h1, m1, "a" if a2 == "p" else "p")
    elif a1:
        # "10am-1": same idea from the other side.
        start = _minutes(h1, m1, a1)
        end = _minutes(h2, m2, a1)
        if end <= start and 1 <= h2 <= 12:
            end = _minutes(h2, m2, "p" if a1 == "a" else "a")
    else:
        # No am or pm anywhere. A 24-hour clock ("16:00-20:00") reads as written.
        start, end = h1 * 60 + m1, h2 * 60 + m2
        if h1 <= 12 and h2 <= 12:
            # A bare "4-8" is a 12-hour clock. Sport does not start before 7 in the
            # morning, so small hours mean the afternoon.
            if h1 < 7:
                start += 12 * 60
            if end <= start:
                end += 12 * 60

    if not (0 <= start < end <= MINUTES_PER_DAY):
        return None
    return start, end


def find_slots(text: str) -> tuple[list[Slot], str]:
    """Pull every time range out of ``text``.

    Returns the slots, sorted, and whatever words are left over (for example
    ``Maintenance``). Text that looks like a range but makes no sense is left
    in the leftover words, so nothing is dropped silently.
    """
    slots: list[Slot] = []
    leftover: list[str] = []
    position = 0
    for match in _RANGE.finditer(text):
        resolved = _resolve(match)
        if resolved is None:
            continue
        leftover.append(text[position : match.start()])
        position = match.end()
        slots.append(Slot(*resolved))
    leftover.append(text[position:])

    words = [word for word in " ".join(leftover).split() if not _JOINERS.match(word)]
    label = " ".join(words).strip(" ,;:-–—")
    return sorted(set(slots)), label


def merge(slots: list[Slot] | tuple[Slot, ...]) -> tuple[Slot, ...]:
    """Sort slots and join the ones that touch or overlap."""
    merged: list[Slot] = []
    for slot in sorted(slots):
        if merged and slot.start <= merged[-1].end:
            if slot.end > merged[-1].end:
                merged[-1] = Slot(merged[-1].start, slot.end)
        else:
            merged.append(slot)
    return tuple(merged)


# --------------------------------------------------------------------------
# Writing times for people
# --------------------------------------------------------------------------


def clock(minutes: int, with_half: bool = True) -> str:
    """Minutes after midnight as people say it: ``4 PM``, ``4:15 PM``, ``midnight``."""
    if minutes in (0, MINUTES_PER_DAY):
        return "midnight"
    hour, minute = divmod(minutes, 60)
    half = "AM" if hour < 12 else "PM"
    hour12 = hour % 12 or 12
    text = f"{hour12}:{minute:02d}" if minute else f"{hour12}"
    return f"{text} {half}" if with_half else text


def span(slot: Slot) -> str:
    """A period as people say it: ``4:15 to 7:30 PM`` or ``10 AM to 6 PM``."""
    same_half = (slot.start < 720) == (slot.end < 720) and slot.end != MINUTES_PER_DAY and slot.start != 0
    return f"{clock(slot.start, with_half=not same_half)} to {clock(slot.end)}"


def spans(slots: list[Slot] | tuple[Slot, ...]) -> str:
    """Several periods joined for a sentence: ``10 AM to 1 PM and 4 to 6 PM``."""
    parts = [span(slot) for slot in slots]
    if len(parts) <= 1:
        return "".join(parts)
    return ", ".join(parts[:-1]) + " and " + parts[-1]
