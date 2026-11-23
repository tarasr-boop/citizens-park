"""The words of the Telegram posts.

Telegram's HTML mode is used for the bold heading and the link, so anything
that comes from outside (such as a label from the council's page) is escaped
before it goes into a post.
"""

from __future__ import annotations

from datetime import datetime
from html import escape

from .config import Config
from .status import DayPlan, free_windows, short_date
from .timeparse import Slot, clock, span
from .weather import LIKELY, Forecast, HourRain, best_window, outlook, total_mm

_RAIN_ICONS = {"dry": "🌤", "slight": "🌦", "likely": "🌧", "unknown": "❔"}

# Rain so far today, or rain due during a booking, above which training may be called off.
_SOAKED_MM = 10.0
_WET_BOOKING_MM = 5.0
# The council says rain-delayed weekend matches may run this late.
_MATCH_OVERRUN = 19 * 60 + 30


def _text(value: str) -> str:
    return escape(value, quote=False)


def _booking_lines(plan: DayPlan, now_minute: int, day: str = "today") -> list[str]:
    """What is booked for the rest of ``plan``'s day. The free times are not listed: they follow from the booked ones.

    ``day`` is how the words name that day: "today", or "tomorrow" in an alert
    sent the evening before. Plain text, like the three functions after this
    one: ``daily`` escapes it for Telegram.
    """
    if plan.closed:
        lines = [f"⛔ The oval is closed {day}."]
        if plan.label:
            lines.append(f"Council notice: {plan.label}")
        return lines
    if not plan.known:
        return [f"❔ No booking information for {day}. Check the signs at the park."]

    sure = plan.confirmed
    if not plan.slots:
        if plan.label:
            return [f"⚠️ Listed for {day}: {plan.label}. The oval may be closed."]
        if sure:
            return [f"🟢 No bookings {day}."]
        return [f"🟢 Usually no bookings on {plan.day:%A}s."]

    remaining = [slot for slot in plan.slots if slot.end > now_minute]
    if not remaining:
        if sure:
            return ["🟢 Today's bookings have finished."]
        return ["🟢 The usual booking time has passed."]

    periods = [f"until {clock(slot.end)}" if slot.start <= now_minute else span(slot) for slot in remaining]
    booked = ", then ".join(periods)
    if plan.label:
        booked += f" ({plan.label})"
    return [f"🔴 Booked {booked}" if sure else f"🟠 Usually booked {booked}"]


def _rain_lines(plan: DayPlan, hours: list[HourRain] | None, now_minute: int, saved_at: str = "", ahead: bool = False) -> list[str]:
    look = outlook(hours, now_minute, tomorrow=ahead)
    lines = [f"{_RAIN_ICONS[look.level]} {look.text}"]
    if hours and saved_at:
        lines[0] += f" Forecast from {saved_at}."
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


def _window_line(plan: DayPlan, hours: list[HourRain] | None, now_minute: int, config: Config) -> str:
    """On a rainy evening, the best time to stay out of the rain while the oval is not booked.

    Empty when no rain is forecast for the evening: then any time outside the
    bookings is as good as another, and the post does not need to say so.
    """
    if not hours or plan.closed or (plan.label and not plan.slots):
        return ""
    first = max(config.advice_from, now_minute)
    window = best_window(hours, free_windows(plan.slots, first, config.advice_until), first, config.advice_until)
    if window is None:
        return ""
    when = f"from now until {clock(window.end)}" if window.start <= now_minute else span(Slot(window.start, window.end))
    line = f"Based on the hourly forecast, the best window to avoid the rain is {when}"
    return line + ("." if window.dry else ", though it may still rain then.")


def _caution_line(plan: DayPlan) -> str:
    """A warning when the day's times are not fresh from the council's page. Nothing when they are."""
    if not plan.known or (plan.confirmed and not plan.stale):
        return ""
    return f"⚠️ {plan.note}"


def _news(
    plan: DayPlan, forecast: Forecast | None, now_minute: int, config: Config, saved_at: str, ahead: bool = False
) -> tuple[list[str], list[str]]:
    """The day's news in two parts: what is booked, then the rain and any warning. Plain text.

    With ``ahead`` it is written the evening before, about the whole of
    ``plan``'s day: every booking, and the rain from the start of the day.
    """
    if ahead:
        now_minute = config.day_start
    hours = forecast.hours.get(plan.day) if forecast else None
    rest = _rain_lines(plan, hours, now_minute, saved_at, ahead)
    rest += [line for line in (_window_line(plan, hours, now_minute, config), _caution_line(plan)) if line]
    booked = _booking_lines(plan, 0, "tomorrow") if ahead else _booking_lines(plan, now_minute)
    return booked, rest


def daily(plan: DayPlan, forecast: Forecast | None, now: datetime, config: Config, ahead: bool = False) -> str:
    """The daily post for ``plan``'s day, written at ``now``.

    With ``ahead`` it is written the evening before ``plan``'s day, for the
    Telegram bot's late alerts: the heading says "tomorrow", and the words
    cover the whole day.
    """
    booked, rest = _news(plan, forecast, now.hour * 60 + now.minute, config, forecast.saved_at if forecast else "", ahead)
    heading = f"{config.park_name}, tomorrow" if ahead else config.park_name
    lines = [f"🐕 <b>{_text(heading)}</b>", ""]
    lines += [_text(line) for line in booked]
    lines.append("")
    lines += [_text(line) for line in rest]
    lines += ["", page_link(config)]
    return "\n".join(lines)


def caption(plan: DayPlan, now: datetime, config: Config, ahead: bool = False) -> str:
    """What the Telegram bot writes under an alert's picture, written at ``now``.

    One line on the bookings, with the park's name, so that it shows in a
    phone's notification ("🔴 Citizens Park oval booked until 8 PM"), and the
    link to the page. The picture shows the rest. With ``ahead`` the line is
    about the whole of ``plan``'s day, tomorrow.
    """
    return f"<b>{_text(_headline(plan, 0 if ahead else now.hour * 60 + now.minute, config.park_name, ahead))}</b>\n{page_link(config)}"


def _headline(plan: DayPlan, now_minute: int, name: str, ahead: bool) -> str:
    """The bookings for the rest of the day in one line, worded like ``_booking_lines``: only what is booked is named."""
    day = "tomorrow" if ahead else "today"
    if plan.closed:
        return f"⛔ {name} closed {day}"
    if not plan.known:
        return f"❔ No booking information for {name} {day}"
    sure = plan.confirmed
    if not plan.slots:
        if plan.label:
            return f"⚠️ {name} may be closed {day} ({plan.label})"
        return f"🟢 No bookings at {name} {day}" if sure else f"🟢 Usually no bookings at {name} on {plan.day:%A}s"
    remaining = [slot for slot in plan.slots if slot.end > now_minute]
    if not remaining:
        return f"🟢 Today's bookings at {name} have finished" if sure else f"🟢 The usual booking time at {name} has passed"
    booked = ", then ".join(f"until {clock(slot.end)}" if slot.start <= now_minute else span(slot) for slot in remaining)
    when = f"{booked} tomorrow" if ahead else booked
    return f"🔴 {name} booked {when}" if sure else f"🟠 {name} usually booked {when}"


def page_link(config: Config) -> str:
    """The link to the page: at the end of the daily post, and under the Telegram bot's alert picture."""
    return f'<a href="{escape(config.site_url)}">Press here for the week ahead and rain by the hour</a>'


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
    old = next((plan for plan in known if plan.stale), None)
    if old:
        lines.append(f"⚠️ {_text(old.note)}")
    lines.append("Dogs can use the oval outside these times.")
    lines += ["", f'<a href="{escape(config.site_url)}">Press here for today and rain by the hour</a>']
    return "\n".join(lines)


def farewell(config: Config) -> str:
    """The channel's last post, once it has moved to the bot (``telegram.retired``): where the alerts are now."""
    name = config.display_name
    same = ", the same as this channel" if (config.bot_weekday, config.bot_weekend) == (config.alert_weekdays, config.alert_weekends) else ""
    lines = [
        f"🐕 <b>{_text(name)} has moved to a bot</b>",
        "",
        f"This channel stops posting today. The same alert now comes in a private chat with the {_text(name)} bot, "
        "at a time you choose: one for weekdays and one for weekends. "
        f"It starts at {clock(config.bot_weekday)} on weekdays and {clock(config.bot_weekend)} on weekends{same}.",
        "",
        f'👉 <a href="{escape(config.bot_url)}">Open the bot</a> and press Start.',
        "",
        f'<a href="{escape(config.site_url)}">The page</a> still shows the week ahead and rain by the hour.',
    ]
    return "\n".join(lines)
