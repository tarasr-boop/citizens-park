"""Load ``config.toml``."""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo

from .timeparse import parse_hhmm


# The daily alert may go out from this many minutes before its stated time.
# The check that sends it is asked for a little before that time (see
# .github/workflows/daily.yml), so that the alert arrives on the hour and not
# after it. The alerts backend has the same number: ALERT_LEAD in
# notifications/src/rules.js.
ALERT_LEAD = 30


class ConfigError(Exception):
    """``config.toml`` is missing something or holds a value that makes no sense."""


@dataclass(frozen=True)
class Config:
    park_name: str
    park_short: str
    suburb: str
    latitude: float
    longitude: float
    timezone_name: str
    day_start: int  # minutes after midnight: where the page's timeline begins
    day_end: int  # where the page's timeline ends
    lights_off: int  # when the council switches the oval's lights off
    council_url: str
    user_agent: str
    channel: str  # Telegram channel link name, without "@"
    alert_weekdays: int  # minutes after midnight: when the daily alert goes out from Monday to Friday
    alert_weekends: int  # and on Saturday and Sunday
    alert_until: int  # an alert that could not go out by this time is left out for the day
    advice_from: int  # on a rainy day the post names the best part of the evening, between these two times
    advice_until: int
    site_name: str  # the page's own name, such as "Citizens Bark"; may be empty
    site_url: str  # always ends with "/"
    tip_url: str
    repo_url: str
    feedback_email: str  # for the page's feedback button; while empty there is no button
    about_heading: str  # the page's "About me" block; left out while about_text is empty
    about_text: str
    about_link: str
    about_link_text: str
    push_url: str  # the notifications backend, without a closing "/"; while empty the page offers no notifications
    # The Telegram bot's custom alerts (the [bot] section). Times are minutes after midnight, each on the hour.
    bot_name: str = ""  # the bot's link name, without "@"; while empty the page's Telegram button leads to the channel
    bot_first: int = 4 * 60  # the earliest time people can choose
    bot_last: int = 23 * 60  # the latest
    bot_evening: int = 21 * 60  # an alert at this time or later is about the next day, sent the evening before
    bot_weekday: int = 16 * 60  # the times a new chat starts with
    bot_weekend: int = 8 * 60

    @property
    def zone(self) -> ZoneInfo:
        return ZoneInfo(self.timezone_name)

    def alert_at(self, day: date) -> int:
        """The time of day people are told to expect the alert on ``day``."""
        return self.alert_weekends if day.weekday() >= 5 else self.alert_weekdays

    def alert_from(self, day: date) -> int:
        """The earliest time of day the alert may go out on ``day``."""
        return self.alert_at(day) - ALERT_LEAD

    @property
    def channel_url(self) -> str:
        return f"https://t.me/{self.channel}" if self.channel else ""

    @property
    def bot_url(self) -> str:
        return f"https://t.me/{self.bot_name}" if self.bot_name else ""

    @property
    def display_name(self) -> str:
        """What the page is called: its own name if it has one, otherwise the park's."""
        return self.site_name or self.park_short


def _web_address(value: str, what: str, required: bool = False) -> str:
    value = value.strip()
    if not value:
        if required:
            raise ConfigError(f"{what} is empty")
        return ""
    if not value.startswith("https://") or any(ch in value for ch in " \"'<>"):
        raise ConfigError(f"{what} must be an https:// address, got {value!r}")
    return value


def _email_address(value: str, what: str) -> str:
    """An email address that is safe to put in a link as it is, or empty."""
    value = value.strip()
    if value and not re.fullmatch(r"[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+", value):
        raise ConfigError(f"{what} should be an email address, such as hello@example.org, got {value!r}")
    return value


def _link_name(value: str, what: str) -> str:
    """A Telegram link name, such as "CitizensParkBot", from the name itself or a link to it."""
    name = value.strip()
    for prefix in ("https://t.me/", "http://t.me/", "t.me/", "@"):
        name = name.removeprefix(prefix)
    name = name.strip("/")
    if name and not re.fullmatch(r"[A-Za-z0-9_]+", name):
        raise ConfigError(f"{what} should be a link name, such as CitizensParkBot, got {name!r}")
    return name


def _on_the_hour(value: object, what: str) -> int:
    """A time on the hour, such as "16:00", as minutes after midnight."""
    minute = parse_hhmm(str(value))
    if minute % 60:
        raise ConfigError(f"{what} must be a time on the hour, such as 16:00, got {value!r}")
    return minute


def load(path: str | Path = "config.toml") -> Config:
    try:
        with open(path, "rb") as handle:
            raw = tomllib.load(handle)
    except FileNotFoundError as error:
        raise ConfigError(f"{path} not found") from error
    except tomllib.TOMLDecodeError as error:
        raise ConfigError(f"{path} is not valid TOML: {error}") from error

    try:
        park, council, telegram, site = raw["park"], raw["council"], raw["telegram"], raw["site"]
        alerts = raw.get("alerts", {})  # optional
        about = raw.get("about", {})  # optional
        notifications = raw.get("notifications", {})  # optional
        bot = raw.get("bot", {})  # optional
        sections = (
            ("park", park),
            ("council", council),
            ("telegram", telegram),
            ("alerts", alerts),
            ("site", site),
            ("about", about),
            ("notifications", notifications),
            ("bot", bot),
        )
        for name, section in sections:
            if not isinstance(section, dict):
                raise ConfigError(f"{path}: {name} should be a section that starts with a [{name}] line")
        # Where the alert's time used to be set. Said out loud, so that an old
        # setting is never quietly ignored.
        for old in ("post_from", "post_until"):
            if old in telegram:
                raise ConfigError(
                    f"telegram.{old} is no longer used. The alert's times are set under [alerts]: weekdays, weekends and until"
                )
        channel = str(telegram.get("channel", "")).strip()
        for prefix in ("https://t.me/", "http://t.me/", "t.me/", "@"):
            channel = channel.removeprefix(prefix)
        channel = channel.strip("/")
        if channel.startswith(("+", "joinchat/")):
            raise ConfigError(
                "telegram.channel is an invite link to a private channel. Make the channel public "
                "(Channel Type, then Public) and use its link name, such as CitizensPark"
            )
        if channel and not re.fullmatch(r"[A-Za-z0-9_]+", channel):
            raise ConfigError(f"telegram.channel should be the channel's link name, such as CitizensPark, got {channel!r}")

        site_url = _web_address(str(site["url"]), "site.url", required=True)
        lights_off = parse_hhmm(str(park.get("lights_off", "22:00")))
        about_link = _web_address(str(about.get("link", "")), "about.link")
        config = Config(
            park_name=str(park["name"]),
            park_short=str(park.get("short_name") or park["name"]),
            suburb=str(park.get("suburb", "")),
            latitude=float(park["latitude"]),
            longitude=float(park["longitude"]),
            timezone_name=str(park["timezone"]),
            day_start=parse_hhmm(str(park.get("day_start", "06:00"))),
            day_end=parse_hhmm(str(park["day_end"])) if "day_end" in park else lights_off,
            lights_off=lights_off,
            council_url=_web_address(str(council["url"]), "council.url", required=True),
            user_agent=str(council.get("user_agent") or "CitizensParkAlerts/1.0"),
            channel=channel,
            alert_weekdays=parse_hhmm(str(alerts.get("weekdays", "16:00"))),
            alert_weekends=parse_hhmm(str(alerts.get("weekends", "08:00"))),
            alert_until=parse_hhmm(str(alerts.get("until", "19:00"))),
            advice_from=parse_hhmm(str(telegram.get("advice_from", "17:00"))),
            advice_until=parse_hhmm(str(telegram.get("advice_until", "21:00"))),
            site_name=str(site.get("name", "")).strip(),
            site_url=site_url if site_url.endswith("/") else site_url + "/",
            tip_url=_web_address(str(site.get("tip_url", "")), "site.tip_url"),
            repo_url=_web_address(str(site.get("repo_url", "")), "site.repo_url"),
            feedback_email=_email_address(str(site.get("feedback_email", "")), "site.feedback_email"),
            about_heading=str(about.get("heading", "")).strip() or "About me",
            about_text=str(about.get("text", "")).strip(),
            about_link=about_link,
            # With no words of its own, the link shows its address without the "https://".
            about_link_text=str(about.get("link_text", "")).strip() or about_link.removeprefix("https://").rstrip("/"),
            push_url=_web_address(str(notifications.get("url", "")), "notifications.url").rstrip("/"),
            bot_name=_link_name(str(bot.get("name", "")), "bot.name"),
            bot_first=_on_the_hour(bot.get("first", "04:00"), "bot.first"),
            bot_last=_on_the_hour(bot.get("last", "23:00"), "bot.last"),
            bot_evening=_on_the_hour(bot.get("evening", "21:00"), "bot.evening"),
            bot_weekday=_on_the_hour(bot.get("weekday", "16:00"), "bot.weekday"),
            bot_weekend=_on_the_hour(bot.get("weekend", "08:00"), "bot.weekend"),
        )
    except KeyError as error:
        raise ConfigError(f"{path} is missing the setting {error}") from error
    except (TypeError, ValueError) as error:
        raise ConfigError(f"{path}: {error}") from error

    if not config.day_start < config.lights_off:
        raise ConfigError("park.day_start must be earlier than park.lights_off")
    if not config.day_start < config.day_end:
        raise ConfigError("park.day_start must be earlier than park.day_end")
    for name, at in (("weekdays", config.alert_weekdays), ("weekends", config.alert_weekends)):
        if at < ALERT_LEAD:
            raise ConfigError(f"alerts.{name} must be {ALERT_LEAD} minutes after midnight or later")
        if not at < config.alert_until:
            raise ConfigError(f"alerts.{name} must be earlier than alerts.until")
    if not config.bot_first <= min(config.bot_weekday, config.bot_weekend) <= max(config.bot_weekday, config.bot_weekend) <= config.bot_last:
        raise ConfigError("bot.weekday and bot.weekend must lie between bot.first and bot.last, and bot.first before bot.last")
    if not config.bot_first < config.bot_evening <= config.bot_last + 60:
        raise ConfigError("bot.evening must be later than bot.first, and no later than an hour after bot.last")
    if not config.advice_from < config.advice_until:
        raise ConfigError("telegram.advice_from must be earlier than telegram.advice_until")
    try:
        ZoneInfo(config.timezone_name)
    except Exception as error:  # an unknown time zone name
        raise ConfigError(f"park.timezone {config.timezone_name!r} is not a known time zone") from error
    return config
