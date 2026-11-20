"""Shared pieces for the tests."""

from __future__ import annotations

import dataclasses
import json
from datetime import date, timedelta
from pathlib import Path

from parkbot import config as config_module
from parkbot.council import parse
from parkbot.pattern import load_seasons
from parkbot.store import CouncilStore

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).parent / "fixtures"

# The tests use their own settings and weekly pattern, so that editing the real
# config.toml or schedule.toml (which is expected) never breaks a test.
CONFIG_FILE = FIXTURES / "config.toml"
SCHEDULE_FILE = FIXTURES / "schedule.toml"

# The two addresses the weather service answered from in November 2026: runners
# in the west of the United States were sent to the first, the others to the
# second. No test connects to them. They are here because only a public address
# is ever remembered or asked, so a made-up example address would not do.
WEST = "51.81.167.44"
EAST = "167.114.211.86"


def load_config(**changes):
    """The test settings, with any fields replaced: ``load_config(channel="")``."""
    return dataclasses.replace(config_module.load(CONFIG_FILE), **changes)


def seasons():
    return load_seasons(SCHEDULE_FILE)


def october_html() -> str:
    return (FIXTURES / "council_october_2026.html").read_text(encoding="utf-8")


def october_store(read_on: date = date(2026, 11, 20)) -> CouncilStore:
    """A store holding the October 2026 table, as read on ``read_on``."""
    store = CouncilStore()
    store.update(parse(october_html(), read_on), read_on)
    return store


def forecast_json(first: date, days: int, chance=lambda day, hour: 0, mm=lambda day, hour: 0.0) -> str:
    """An Open-Meteo style reply. ``chance`` and ``mm`` describe the hour that STARTS at ``hour``."""
    times, chances, amounts = [], [], []
    for offset in range(days):
        day = first + timedelta(days=offset)
        for stamp_hour in range(24):
            times.append(f"{day.isoformat()}T{stamp_hour:02d}:00")
            # Open-Meteo stamps a value with the end of its hour.
            covered_day = day if stamp_hour > 0 else day - timedelta(days=1)
            covered_hour = (stamp_hour - 1) % 24
            chances.append(chance(covered_day, covered_hour))
            amounts.append(mm(covered_day, covered_hour))
    daily_days = [first + timedelta(days=offset) for offset in range(days)]
    return json.dumps(
        {
            "latitude": -37.8,
            "longitude": 145.0,
            "timezone": "Australia/Melbourne",
            "hourly": {"time": times, "precipitation_probability": chances, "precipitation": amounts},
            "daily": {
                "time": [day.isoformat() for day in daily_days],
                "precipitation_probability_max": [max(chance(day, hour) for hour in range(24)) for day in daily_days],
                "precipitation_sum": [round(sum(mm(day, hour) for hour in range(24)), 1) for day in daily_days],
            },
        }
    )
