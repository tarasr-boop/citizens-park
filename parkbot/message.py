"""The words of the Telegram posts.

Telegram's HTML mode is used for the bold heading and the link, so anything
that comes from outside (such as a label from the council's page) is escaped.
"""

from __future__ import annotations

from datetime import datetime
from html import escape

from .config import Config
from .status import DayPlan, free_text, short_date
from .timeparse import clock, span
from .weather import LIKELY, Forecast, HourRain, outlook, total_mm

_RAIN_ICONS = {"dry": "🌤", "slight": "🌦", "likely": "🌧", "unknown": "❔"}

# Rain so far today, or rain due during a booking, above which training may be called off.
_SOAKED_MM = 10.0
_WET_BOOKING_MM = 5.0
# The council says rain-delayed weekend matches may run this late.
_MATCH_OVERRUN = 19 * 60 + 30


def _text(value: str) -> str:
    return escape(value, quote=False)


def _booking_lines(plan: DayPlan, now_minute: int, lights_off: int) -> list[str]:
    """What is booked and what is free for the rest of ``plan``'s day."""
    if plan.closed:
        lines = ["⛔ The oval is closed today."]
        if plan.label:
            lines.append(f"Council notice: {_text(plan.label)}")
        return lines
    if not plan.known:
        return ["❔ No booking information for today. Check the signs at the park."]

    sure = plan.confirmed
    if not plan.slots:
        if plan.label:
            return [f"⚠️ Listed for today: {_text(plan.label)}. The oval may be closed."]
        if sure:
            return ["🟢 No bookings today. The oval is free all day."]
        return [f"🟢 Usually no bookings on {plan.day:%A}s."]

    remaining = [slot for slot in plan.slots if slot.end > now_minute]
    if not remaining:
        if sure:
            return ["🟢 Today's bookings have finished. The oval is free for the rest of the day."]
        return ["🟢 The usual booking time has passed, so the oval should be free."]

    periods = [f"until {clock(slot.end)}" if slot.start <= now_minute else span(slot) for slot in remaining]
    booked = ", then ".join(periods)
    if plan.label:
        booked += f" ({_text(plan.label)})"
    lines = [f"🔴 Booked {booked}" if sure else f"🟠 Usually booked {booked}"]
    free = free_text(plan.slots, now_minute, lights_off)
    if free:
        lines.append(f"🟢 Free {free}" if sure else f"🟢 Usually free {free}")
    return lines


def _rain_lines(plan: DayPlan, hours: list[HourRain] | None, now_minute: int) -> list[str]:
    look = outlook(hours, now_minute)
    lines = [f"{_RAIN_ICONS[look.level]} {look.text}"]
    if not hours or plan.closed:
        return lines

    remaining = [slot for slot in plan.slots if slot.end > now_minute]
    if not remaining:
        return lines
    so_far = total_mm(hours, 0, now_minute // 60 - 1)
    during = sum(
        hour.mm or 0.0
        for hour in hours
        if any(slot.start < (hour.hour + 1) * 60 and slot.end > hour.hour * 60 for slot in remaining)
        and hour.hour >= now_minute // 60
    )
    if so_far >= _SOAKED_MM or during >= _WET_BOOKING_MM:
        lines.append("Heavy rain can cancel training, so the oval may free up early.")
    elif plan.day.weekday() >= 5 and remaining[-1].end < _MATCH_OVERRUN and (look.level == "likely" or so_far >= 1.0):
        lines.append(f"After rain delays, weekend matches can run until {clock(_MATCH_OVERRUN)}.")
    return lines


def _source_line(plan: DayPlan) -> str:
    if not plan.known:
        return ""
    return f"{'✅' if plan.confirmed else '⚠️'} {_text(plan.note)}"


def daily(plan: DayPlan, forecast: Forecast | None, now: datetime, config: Config) -> str:
    """The daily post for ``plan``'s day, written at ``now``."""
    now_minute = now.hour * 60 + now.minute
    hours = forecast.hours.get(plan.day) if forecast else None
    lines = [f"🐕 <b>{_text(config.park_name)} · {short_date(plan.day)}</b>", ""]
    lines += _booking_lines(plan, now_minute, config.lights_off)
    lines.append("")
    lines += _rain_lines(plan, hours, now_minute)
    source = _source_line(plan)
    if source:
        lines.append(source)
    lines += ["", f'<a href="{escape(config.site_url)}">The week ahead and rain by the hour</a>']
    return "\n".join(lines)


def _day_words(plan: DayPlan) -> str:
    if plan.closed:
        return "closed"
    if not plan.known:
        return "no information"
    if plan.slots:
        words = ", ".join(span(slot) for slot in plan.slots)
        return f"{words} ({_text(plan.label)})" if plan.label else words
    return _text(plan.label) if plan.label else "no bookings"


def weekly(plans: list[DayPlan], forecast: Forecast | None, config: Config) -> str:
    """The week-ahead post: one line per day."""
    known = [plan for plan in plans if plan.known]
    mixed = any(plan.confirmed for plan in known) and any(not plan.confirmed for plan in known)
    lines = [f"📅 <b>{_text(config.park_name)} · the week ahead</b>", "", "Booked times:"]
    for plan in plans:
        line = f"{short_date(plan.day)}: {_day_words(plan)}"
        if mixed and plan.known and not plan.confirmed:
            line += " (usual)"
        rain = forecast.days.get(plan.day) if forecast else None
        if rain and rain.chance is not None and rain.chance >= LIKELY:
            line += f" · 🌧 {rain.chance}%"
        lines.append(line)

    lines.append("")
    if mixed:
        lines.append("⚠️ Days marked (usual) follow the usual pattern and are not confirmed by the council's page yet.")
    elif known and not known[0].confirmed:
        lines.append(f"⚠️ {_text(known[0].note)}")
    elif known:
        lines.append("✅ From the council's schedule.")
    lines.append("Dogs can use the oval outside these times.")
    lines += ["", f'<a href="{escape(config.site_url)}">Today and rain by the hour</a>']
    return "\n".join(lines)
