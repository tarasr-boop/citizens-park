"""The words of the Telegram bot's custom alerts, written ahead for every hour.

People who start a chat with the bot pick one time for weekdays and one for
weekends (see notifications/src/bot.js). The bot runs on the alerts backend,
which knows nothing about bookings or rain. So each check writes the alert for
every hour people can pick, today and tomorrow, into ``telegram.json`` next to
the page. At each hour the bot sends the picture drawn for that hour
(parkbot/picture.py) with the "caption" under it: one line on the bookings and
a link to the page. Without a picture it sends the words written for that hour.

An alert is the same post the channel gets, written for its own time of day:
at 8 AM it names every booking of the day, at 4 PM only what is left. An alert
at ``bot.evening`` or later is about the next day, so a 9 PM alert says what
tomorrow holds. Whether a person's weekday or weekend time applies follows the
day the alert is about.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta

from . import message
from .config import Config
from .status import DayPlan, short_date
from .timeparse import clock
from .weather import Forecast

FILE = "telegram.json"


def written_at(sent_on: date, hour: int, ahead: bool, now: datetime) -> datetime:
    """The moment an alert sent at ``hour`` on ``sent_on`` is written for.

    That is its hour, or ``now`` for an hour of today that has already begun:
    the words never look back at a time that has passed. An alert about the
    next day (``ahead``) covers the whole of that day either way.
    """
    written = datetime.combine(sent_on, time(hour), tzinfo=now.tzinfo)
    return now if not ahead and written < now else written


def alerts(config: Config, plans: list[DayPlan], forecast: Forecast | None, now: datetime) -> dict:
    """What goes into ``telegram.json``: the words for each hour of today that is still to come, and of tomorrow."""
    by_day = {plan.day: plan for plan in plans}
    now_minute = now.hour * 60 + now.minute
    entries = []
    for offset in (0, 1):
        sent_on = now.date() + timedelta(days=offset)
        for minute in range(config.bot_first, config.bot_last + 1, 60):
            if offset == 0 and minute + 60 <= now_minute:
                continue  # that hour has gone
            ahead = minute >= config.bot_evening
            about = sent_on + timedelta(days=1) if ahead else sent_on
            plan = by_day.get(about)
            if plan is None:
                continue
            written = written_at(sent_on, minute // 60, ahead, now)
            entries.append(
                {
                    "date": sent_on.isoformat(),
                    "hour": minute // 60,
                    "about": about.isoformat(),
                    "weekend": about.weekday() >= 5,
                    "text": message.daily(plan, forecast, written, config, ahead=ahead),
                    # What goes under the alert's picture. Without a picture the words go.
                    "caption": message.caption(plan, written, config, ahead=ahead),
                }
            )
    return {
        "generated": now.isoformat(timespec="minutes"),
        "generatedText": f"{short_date(now.date())}, {clock(now_minute)}",
        "alerts": entries,
    }
