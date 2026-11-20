"""Load ``config.toml``."""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

from .timeparse import parse_hhmm


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
    day_start: int  # minutes after midnight
    lights_off: int
    council_url: str
    user_agent: str
    channel: str  # Telegram channel link name, without "@"
    post_from: int
    post_until: int
    site_name: str  # the page's own name, such as "Citizens Bark"; may be empty
    run_by: str  # who runs the page; finishes the sentence "This page is run by ..."
    site_url: str  # always ends with "/"
    tip_url: str
    repo_url: str

    @property
    def zone(self) -> ZoneInfo:
        return ZoneInfo(self.timezone_name)

    @property
    def channel_url(self) -> str:
        return f"https://t.me/{self.channel}" if self.channel else ""

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
        for name, section in (("park", park), ("council", council), ("telegram", telegram), ("site", site)):
            if not isinstance(section, dict):
                raise ConfigError(f"{path}: {name} should be a section that starts with a [{name}] line")
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
        config = Config(
            park_name=str(park["name"]),
            park_short=str(park.get("short_name") or park["name"]),
            suburb=str(park.get("suburb", "")),
            latitude=float(park["latitude"]),
            longitude=float(park["longitude"]),
            timezone_name=str(park["timezone"]),
            day_start=parse_hhmm(str(park.get("day_start", "06:00"))),
            lights_off=parse_hhmm(str(park.get("lights_off", "22:00"))),
            council_url=_web_address(str(council["url"]), "council.url", required=True),
            user_agent=str(council.get("user_agent") or "CitizensParkAlerts/1.0"),
            channel=channel,
            post_from=parse_hhmm(str(telegram.get("post_from", "14:30"))),
            post_until=parse_hhmm(str(telegram.get("post_until", "19:00"))),
            site_name=str(site.get("name", "")).strip(),
            run_by=str(site.get("run_by", "")).strip() or "a local dog owner",
            site_url=site_url if site_url.endswith("/") else site_url + "/",
            tip_url=_web_address(str(site.get("tip_url", "")), "site.tip_url"),
            repo_url=_web_address(str(site.get("repo_url", "")), "site.repo_url"),
        )
    except KeyError as error:
        raise ConfigError(f"{path} is missing the setting {error}") from error
    except (TypeError, ValueError) as error:
        raise ConfigError(f"{path}: {error}") from error

    if not config.day_start < config.lights_off:
        raise ConfigError("park.day_start must be earlier than park.lights_off")
    if not config.post_from < config.post_until:
        raise ConfigError("telegram.post_from must be earlier than telegram.post_until")
    try:
        ZoneInfo(config.timezone_name)
    except Exception as error:  # an unknown time zone name
        raise ConfigError(f"park.timezone {config.timezone_name!r} is not a known time zone") from error
    return config
